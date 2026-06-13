// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.19;

import "../TestToken.sol";
import "../PostageStamp.sol";
import "../PriceOracle.sol";
import "../Redistribution.sol" as RedistMod;
import "../Staking.sol" as StakingMod;
import "./RedistributionExposed.sol";

contract EchidnaSystemActor {
    TestToken internal immutable token;
    StakingMod.StakeRegistry internal immutable stake;
    PostageStamp internal immutable stamp;
    PriceOracle internal immutable oracle;
    RedistMod.Redistribution internal immutable redist;

    constructor(TestToken t, StakingMod.StakeRegistry s, PostageStamp p, PriceOracle o, RedistMod.Redistribution r) {
        token = t;
        stake = s;
        stamp = p;
        oracle = o;
        redist = r;

        token.approve(address(stake), type(uint256).max);
        token.approve(address(stamp), type(uint256).max);
    }

    function callManageStake(bytes32 setNonce, uint256 addAmount, uint8 height) external returns (bool ok) {
        (ok, ) = address(stake).call(abi.encodeWithSelector(stake.manageStake.selector, setNonce, addAmount, height));
    }

    function callWithdrawFromStake() external returns (bool ok) {
        (ok, ) = address(stake).call(abi.encodeWithSelector(stake.withdrawFromStake.selector));
    }

    function callCreateBatch(
        address owner,
        uint256 initialBalancePerChunk,
        uint8 depth,
        uint8 bucketDepth,
        bytes32 nonce,
        bool immutableFlag
    ) external returns (bool ok) {
        (ok, ) = address(stamp).call(
            abi.encodeWithSelector(
                stamp.createBatch.selector,
                owner,
                initialBalancePerChunk,
                depth,
                bucketDepth,
                nonce,
                immutableFlag
            )
        );
    }

    function callTopUp(bytes32 batchId, uint256 topupAmountPerChunk) external returns (bool ok) {
        (ok, ) = address(stamp).call(abi.encodeWithSignature("topUp(bytes32,uint256)", batchId, topupAmountPerChunk));
    }

    function callIncreaseDepth(bytes32 batchId, uint8 newDepth) external returns (bool ok) {
        (ok, ) = address(stamp).call(abi.encodeWithSignature("increaseDepth(bytes32,uint8)", batchId, newDepth));
    }

    function callExpireAll() external returns (bool ok) {
        (ok, ) = address(stamp).call(abi.encodeWithSelector(stamp.expireLimited.selector, type(uint256).max));
    }

    function callCommit(bytes32 obfuscatedHash, uint64 roundNumber) external returns (bool ok) {
        (ok, ) = address(redist).call(abi.encodeWithSelector(redist.commit.selector, obfuscatedHash, roundNumber));
    }

    function callReveal(uint8 depth, bytes32 hash, bytes32 nonce) external returns (bool ok) {
        (ok, ) = address(redist).call(abi.encodeWithSelector(redist.reveal.selector, depth, hash, nonce));
    }

    function callAdjustPrice(uint16 redundancy) external returns (bool ok) {
        (ok, ) = address(oracle).call(abi.encodeWithSelector(oracle.adjustPrice.selector, redundancy));
    }
}

/// @notice Integration fuzz harness: StakeRegistry + PostageStamp + PriceOracle + Redistribution wired together.
contract EchidnaSystemHarness {
    uint256 internal constant ACTOR_COUNT = 3;

    TestToken internal immutable token;
    PostageStamp internal immutable stamp;
    PriceOracle internal immutable oracle;
    StakingMod.StakeRegistry internal immutable stake;
    RedistMod.Redistribution internal immutable redist;

    EchidnaSystemActor[3] internal actors;
    uint256 internal constant BOOTSTRAP_HEIGHT = 16;
    bytes32[3] internal bootstrapNonce;

    // Integration negative-test flags.
    bool internal unauthorizedOracleAdjustSucceeded;

    // Tracked commit/reveal preimages for the integrated happy-path flow.
    bool[3] internal trackedHasCommit;
    bool[3] internal trackedHasReveal;
    uint64[3] internal trackedRound;
    bytes32[3] internal trackedObfuscated;
    bytes32[3] internal trackedHash;
    bytes32[3] internal trackedRevealNonce;
    uint8[3] internal trackedDepth;

    constructor() {
        token = new TestToken("TestToken", "TST", 0);

        // Deploy postage first; oracle depends on it.
        stamp = new PostageStamp(address(token), 16, 17280);
        oracle = new PriceOracle(address(stamp), 152);

        // Wire roles: the oracle must be able to call PostageStamp.setPrice.
        stamp.grantRole(stamp.PRICE_ORACLE_ROLE(), address(oracle));

        // Deploy stake registry (uses oracle.currentPrice()).
        stake = new StakingMod.StakeRegistry(address(token), 1, address(oracle));

        // Deploy redistribution (uses stake/stamp/oracle). Exposed wrapper adds length helpers for harness scans.
        redist = RedistMod.Redistribution(
            address(new RedistributionExposed(address(stake), address(stamp), address(oracle)))
        );

        // Wire roles: redistribution must be able to freeze stake and withdraw the stamp pot.
        stake.grantRole(stake.REDISTRIBUTOR_ROLE(), address(redist));
        stamp.grantRole(stamp.REDISTRIBUTOR_ROLE(), address(redist));

        // Create actor contracts and pre-fund + pre-stake them.
        for (uint256 i = 0; i < ACTOR_COUNT; i++) {
            actors[i] = new EchidnaSystemActor(token, stake, stamp, oracle, redist);
            bootstrapNonce[i] = keccak256(abi.encodePacked("bootstrap", i));
            // Mint enough for both staking and postage operations.
            token.mint(address(actors[i]), 1e28);
            // Bootstrap a stake early so that after 2 rounds pass, commit() can succeed.
            actors[i].callManageStake(bootstrapNonce[i], 1e24, uint8(BOOTSTRAP_HEIGHT));
        }

        // Create a dedicated price updater (actor[0]) for adjustPrice.
        oracle.grantRole(oracle.PRICE_UPDATER_ROLE(), address(actors[0]));
    }

    // -----------------------------
    // Integration actions
    // -----------------------------

    /// @dev No-op that lets Echidna advance block.number without side effects,
    /// helping the fuzzer walk through round phases.
    function act_tick() external {}

    function act_actor_manageStake(uint8 actorId, bytes32 setNonce, uint256 addAmount, uint8 height) external {
        EchidnaSystemActor a = actors[uint256(actorId) % ACTOR_COUNT];
        uint8 h = uint8(height % 32);
        uint256 amt = _boundStakeAdd(addAmount);
        a.callManageStake(setNonce, amt, h);
    }

    function act_actor_withdrawSurplus(uint8 actorId) external {
        EchidnaSystemActor a = actors[uint256(actorId) % ACTOR_COUNT];
        a.callWithdrawFromStake();
    }

    function act_actor_createBatch(
        uint8 actorId,
        uint256 initialBalancePerChunk,
        uint8 depth,
        uint8 bucketDepth,
        bytes32 nonce,
        bool imm
    ) external {
        EchidnaSystemActor a = actors[uint256(actorId) % ACTOR_COUNT];
        uint8 minBucket = stamp.minimumBucketDepth();
        // depth must exceed minimumBucketDepth; allow [minBucket+1 .. minBucket+10]
        uint8 d = uint8(minBucket + 1 + (depth % 10));
        // bucketDepth must be in [minBucket, d-1]
        uint8 b = uint8(minBucket + (bucketDepth % (d - minBucket)));

        uint256 min = stamp.minimumInitialBalancePerChunk();
        uint256 init = initialBalancePerChunk % (min + 1e6);
        if (init < min) init = min;
        if (init == 0) init = 1;

        a.callCreateBatch(address(a), init, d, b, nonce, imm);
    }

    function act_actor_topUp(uint8 actorId, bytes32 batchId, uint256 topupAmountPerChunk) external {
        EchidnaSystemActor a = actors[uint256(actorId) % ACTOR_COUNT];
        uint256 amt = topupAmountPerChunk % 1e9;
        if (amt == 0) amt = 1;
        a.callTopUp(batchId, amt);
    }

    function act_actor_increaseDepth(uint8 actorId, bytes32 batchId, uint8 newDepth) external {
        EchidnaSystemActor a = actors[uint256(actorId) % ACTOR_COUNT];
        uint8 d = uint8((newDepth % 12) + 1);
        a.callIncreaseDepth(batchId, d);
    }

    function act_actor_expireAll(uint8 actorId) external {
        EchidnaSystemActor a = actors[uint256(actorId) % ACTOR_COUNT];
        a.callExpireAll();
    }

    function act_admin_setOraclePrice(uint32 p) external {
        // This should update both oracle state and PostageStamp.lastPrice (via setPrice()).
        oracle.setPrice(p);
    }

    function act_updater_adjustOraclePrice(uint16 redundancy) external {
        // Only actor[0] has PRICE_UPDATER_ROLE.
        actors[0].callAdjustPrice(uint16((redundancy % 8) + 1));
    }

    function act_rando_tryAdjustOraclePrice(uint8 actorId, uint16 redundancy) external {
        EchidnaSystemActor a = actors[uint256(actorId) % ACTOR_COUNT];
        bool ok = a.callAdjustPrice(uint16((redundancy % 8) + 1));
        if (ok && address(a) != address(actors[0])) unauthorizedOracleAdjustSucceeded = true;
    }

    function act_redist_happyCommit(uint8 actorId, bytes32 hash, bytes32 revealNonce) external {
        if (redist.paused()) return;
        if (!redist.currentPhaseCommit()) return;
        // Avoid the commit-phase last-block restriction.
        if (block.number % 152 == (152 / 4) - 1) return;

        uint256 idx = uint256(actorId) % ACTOR_COUNT;
        EchidnaSystemActor a = actors[idx];

        // Must have staked at least 2 rounds prior.
        uint256 lastUpdated = stake.lastUpdatedBlockNumberOfAddress(address(a));
        if (lastUpdated == 0) return;
        if (lastUpdated >= block.number - 2 * 152) return;

        // Use the actor's current staking height as the reveal depth (depthResponsibility = 0 => proximity always passes).
        uint8 height = stake.heightOfAddress(address(a));
        uint8 depth = height;

        bytes32 overlay = stake.overlayOfAddress(address(a));
        bytes32 obfuscated = redist.wrapCommit(overlay, depth, hash, revealNonce);

        bool ok = a.callCommit(obfuscated, redist.currentRound());
        if (!ok) return;

        trackedHasCommit[idx] = true;
        trackedHasReveal[idx] = false;
        trackedRound[idx] = redist.currentRound();
        trackedObfuscated[idx] = obfuscated;
        trackedHash[idx] = hash;
        trackedRevealNonce[idx] = revealNonce;
        trackedDepth[idx] = depth;
    }

    function act_redist_happyReveal(uint8 actorId) external {
        if (redist.paused()) return;
        if (!redist.currentPhaseReveal()) return;

        uint256 idx = uint256(actorId) % ACTOR_COUNT;
        if (!trackedHasCommit[idx] || trackedHasReveal[idx]) return;

        // Must reveal in the same round that holds commits.
        if (redist.currentRound() != trackedRound[idx]) return;
        if (redist.currentCommitRound() != trackedRound[idx]) return;

        EchidnaSystemActor a = actors[idx];
        bool ok = a.callReveal(trackedDepth[idx], trackedHash[idx], trackedRevealNonce[idx]);
        if (!ok) return;
        trackedHasReveal[idx] = true;
    }

    // -----------------------------
    // Integration properties
    // -----------------------------

    function echidna_unauthorized_oracle_adjust_never_succeeds() external view returns (bool) {
        return !unauthorizedOracleAdjustSucceeded;
    }

    function echidna_oracle_price_matches_stamp_lastPrice_when_updated() external view returns (bool) {
        // `PostageStamp.lastPrice` updates on every successful oracle `setPrice`/`adjustPrice` call.
        // We don't assert it *always* equals oracle.currentPrice(), because it can lag if the stamp call failed.
        // But in this integrated harness, oracle holds PRICE_ORACLE_ROLE and the stamp call should succeed.
        uint64 lp = stamp.lastPrice();
        if (lp == 0) return true; // not updated yet
        return uint32(lp) == oracle.currentPrice();
    }

    function echidna_stamp_internal_pot_not_above_contract_balance() external view returns (bool) {
        // Raw `pot` tracks accrued liability; it must not exceed ERC20 balance held by the stamp contract.
        // (`totalPot()` caps at balance but is non-view; this is the meaningful accounting check.)
        return stamp.pot() <= token.balanceOf(address(stamp));
    }

    function echidna_tracked_redist_commit_reveal_consistent() external view returns (bool) {
        uint64 liveCommitRound = redist.currentCommitRound();
        for (uint256 i = 0; i < ACTOR_COUNT; i++) {
            if (!trackedHasCommit[i]) continue;
            if (trackedRound[i] != liveCommitRound) continue;

            // Verify the commit exists in storage (scan bounded prefix).
            if (!_commitExists(trackedObfuscated[i], address(actors[i]))) return false;
        }

        for (uint256 i = 0; i < ACTOR_COUNT; i++) {
            if (!trackedHasReveal[i]) continue;
            if (trackedRound[i] != liveCommitRound) continue;

            if (!_revealMatchesCommit(address(actors[i]), trackedDepth[i], trackedHash[i])) return false;
        }
        return true;
    }

    // -----------------------------
    // Internal helpers
    // -----------------------------

    function _boundStakeAdd(uint256 a) internal pure returns (uint256) {
        if (a == 0) return 1e18;
        uint256 max = 1e25;
        if (a > max) return (a % max) + 1;
        return a;
    }

    function _commitExists(bytes32 obfuscated, address owner) internal view returns (bool) {
        uint256 lim = RedistributionExposed(address(redist)).currentCommitsLength();
        if (lim > 25) lim = 25;
        for (uint256 i = 0; i < lim; i++) {
            (bool ok, bytes memory data) = address(redist).staticcall(
                abi.encodeWithSignature("currentCommits(uint256)", i)
            );
            if (!ok) break;
            (bytes32 ov, address ow, bool rev, uint8 h, uint256 st, bytes32 obf, uint256 ri) = abi.decode(
                data,
                (bytes32, address, bool, uint8, uint256, bytes32, uint256)
            );
            ov;
            rev;
            h;
            st;
            ri;
            if (ow == owner && obf == obfuscated) return true;
        }
        return false;
    }

    function _revealMatchesCommit(address owner, uint8 depth, bytes32 hash) internal view returns (bool) {
        uint256 lim = RedistributionExposed(address(redist)).currentRevealsLength();
        if (lim > 25) lim = 25;
        for (uint256 i = 0; i < lim; i++) {
            (bool ok, bytes memory data) = address(redist).staticcall(
                abi.encodeWithSignature("currentReveals(uint256)", i)
            );
            if (!ok) break;
            (bytes32 ov, address ow, uint8 d, uint256 st, uint256 sd, bytes32 h) = abi.decode(
                data,
                (bytes32, address, uint8, uint256, uint256, bytes32)
            );
            ov;
            st;
            sd;
            if (ow == owner && d == depth && h == hash) return true;
        }
        return false;
    }
}
