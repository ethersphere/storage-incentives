// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.19;

import "../Redistribution.sol";
import "../TestToken.sol";
import "../interface/IPostageStamp.sol";
import "./EchidnaMocks.sol";

contract EchidnaPostageStampPotMock is IPostageStamp {
    TestToken internal immutable token;

    uint256 public pot;
    address public lastBeneficiary;
    uint256 public lastAmount;
    uint256 public validChunkCountValue;
    bool public shouldRevertWithdraw;

    constructor(TestToken t) {
        token = t;
    }

    function seedPot(uint256 amount) external {
        token.mint(address(this), amount);
        pot += amount;
    }

    function setShouldRevertWithdraw(bool v) external {
        shouldRevertWithdraw = v;
    }

    function setValidChunkCount(uint256 v) external {
        validChunkCountValue = v;
    }

    function withdraw(address beneficiary) external {
        if (shouldRevertWithdraw) revert("mock withdraw revert");
        uint256 bal = token.balanceOf(address(this));
        uint256 amt = pot < bal ? pot : bal;
        lastBeneficiary = beneficiary;
        lastAmount = amt;
        pot = 0;
        if (amt > 0) {
            token.transfer(beneficiary, amt);
        }
    }

    // Unused in this claim-stub harness but required by the interface.
    function setPrice(uint256) external {}
    function validChunkCount() external view returns (uint256) {
        return validChunkCountValue;
    }
    function batchOwner(bytes32) external pure returns (address) {
        return address(0);
    }
    function batchDepth(bytes32) external pure returns (uint8) {
        return 0;
    }
    function batchBucketDepth(bytes32) external pure returns (uint8) {
        return 0;
    }
    function remainingBalance(bytes32) external pure returns (uint256) {
        return 0;
    }
    function minimumInitialBalancePerChunk() external pure returns (uint256) {
        return 0;
    }
    function redistributionMinimumNormalisedBalance(uint256) external pure returns (uint256) {
        return 0;
    }
    function redistributionBatchAt(
        bytes32,
        uint256
    ) external pure returns (address owner, uint8 depthAtSamplingStart, uint8 bucketDepth, uint256 normalisedBalance) {
        return (address(0), 0, 0, 0);
    }
    function batches(
        bytes32
    )
        external
        pure
        returns (
            address owner,
            uint8 depth,
            uint8 bucketDepth,
            bool immutableFlag,
            uint256 normalisedBalance,
            uint256 lastUpdatedBlockNumber
        )
    {
        return (address(0), 0, 0, false, 0, 0);
    }
}

contract RedistributionClaimStub is Redistribution {
    constructor(
        address staking,
        address postageContract,
        address oracleContract,
        address tokenAddress
    ) Redistribution(staking, postageContract, oracleContract, tokenAddress) {}

    /// @notice Fuzz-only: mark a revealed overlay proof validated without running the witnesses.
    /// @dev STS-1 proof submission needs real BMT witnesses and postage signatures, which a
    /// structural fuzzer cannot produce. Everything downstream of proof validation - truth
    /// selection, proportional payout, freezing, claim gating - is still exercised for real.
    function markProofValidated(uint256 revealIndex) external {
        Reveal storage r = currentReveals[revealIndex];
        r.stampRevealed = true;
        r.proofSubmitted = true;
        r.effectiveStakeDensity = r.stakeDensity;
    }

    function revealsLength() external view returns (uint256) {
        return currentReveals.length;
    }

    /// @notice Fuzz-only claim: finalize participation + disagreement penalties + oracle, then withdraw pot.
    /// @dev Bypasses inclusion/SOC/stamp proof verification. Withdraw reverts the whole claim (no pay, no claim).
    function claimStub() external whenNotPaused {
        uint64 cr = currentRound();

        if (!currentPhaseClaim()) {
            revert NotClaimPhase();
        }
        if (!participationFinalized[cr]) {
            _finalizeParticipation(cr);
        }
        if (cr != currentRevealRound || currentReveals.length == 0) {
            revert NoReveals();
        }
        if (cr <= currentClaimRound) {
            revert AlreadyClaimed();
        }

        SelectedSchellingPoint memory truth = selectedTruth;
        if (!truth.selected) {
            revert NoClaimableTruth();
        }

        uint256 balanceBefore = bzzToken.balanceOf(address(this));
        PostageContract.withdraw(address(this));
        uint256 pot = bzzToken.balanceOf(address(this)) - balanceBefore;

        uint16 redundancy = _applyPayoutsAndFreezes(cr, truth, pot);

        bool priceOk = OracleContract.adjustPrice(redundancy);
        if (!priceOk) {
            emit PriceAdjustmentSkipped(redundancy);
        }

        lastRedundancyCount = redundancy;
        lastClaimedDepth = truth.depth;
        currentClaimRound = cr;
        emit ChunkCount(PostageContract.validChunkCount());
    }

    function currentCommitsLength() external view returns (uint256) {
        return currentCommits.length;
    }
}

contract EchidnaRedistributionClaimActor {
    RedistributionClaimStub internal immutable redist;

    constructor(RedistributionClaimStub r) {
        redist = r;
    }

    function callCommit(bytes32 obfuscatedHash, uint64 roundNumber, uint8 depth) external returns (bool ok) {
        (ok, ) = address(redist).call(
            abi.encodeWithSelector(redist.commit.selector, obfuscatedHash, roundNumber, depth)
        );
    }

    function callReveal(uint8 depth, bytes32 hash, bytes32 nonce) external returns (bool ok) {
        (ok, ) = address(redist).call(abi.encodeWithSelector(redist.reveal.selector, depth, hash, bytes32(0), nonce));
    }

    function callWithdrawPayout() external returns (bool ok) {
        (ok, ) = address(redist).call(
            abi.encodeWithSelector(redist.withdrawRedistributionPayout.selector, address(this))
        );
    }

    function callClaimStub() external returns (bool ok) {
        (ok, ) = address(redist).call(abi.encodeWithSelector(redist.claimStub.selector));
    }
}

/// @notice Harness to fuzz commit→reveal→claim-withdraw end-to-end (without proof verification).
contract EchidnaRedistributionClaimHarness {
    uint256 internal constant ACTOR_COUNT = 3;
    uint256 internal constant ROUND_LENGTH = 152;

    TestToken internal immutable token;
    EchidnaStakeRegistryMock internal immutable stakeMock;
    EchidnaPostageStampPotMock internal immutable stampMock;
    EchidnaPriceOracleMock internal immutable oracleMock;
    RedistributionClaimStub internal immutable redist;

    EchidnaRedistributionClaimActor[3] internal actors;

    // Track a "happy-path" preimage so reveal/claim can actually succeed.
    bool[3] internal trackedHasCommit;
    bool[3] internal trackedHasReveal;
    uint64[3] internal trackedRound;
    bytes32[3] internal trackedObfuscated;
    bytes32[3] internal trackedHash;
    bytes32[3] internal trackedNonce;
    uint8[3] internal trackedDepth;

    // Pending claim postconditions.
    bool internal pendingClaim;
    bool internal pendingWithdrawShouldFail;
    uint64 internal pendingClaimRound;
    uint256 internal pendingPotBefore;
    uint256 internal pendingOracleCallsBefore;
    uint256[3] internal pendingActorBalBefore;

    // Flags.
    bool internal claimSucceededTwiceSameRound;
    uint64 internal lastClaimRound;

    constructor() {
        token = new TestToken("TestToken", "TT", 0);
        stakeMock = new EchidnaStakeRegistryMock();
        stampMock = new EchidnaPostageStampPotMock(token);
        oracleMock = new EchidnaPriceOracleMock();
        redist = new RedistributionClaimStub(
            address(stakeMock),
            address(stampMock),
            address(oracleMock),
            address(token)
        );

        for (uint256 i = 0; i < ACTOR_COUNT; i++) {
            actors[i] = new EchidnaRedistributionClaimActor(redist);
            // Seed eligible stake; lastUpdated=1 ensures it will become "2 rounds old" later.
            stakeMock.setNode(address(actors[i]), bytes32(uint256(i + 1)), 0, 1e18, 1);
        }
    }

    function _clearClaimPending() internal {
        pendingClaim = false;
    }

    // -----------------------------
    // Actions
    // -----------------------------

    /// @dev No-op that lets Echidna advance block.number without side effects,
    /// helping the fuzzer walk through round phases.
    function act_tick() external {}

    function act_seedPot(uint256 amount) external {
        _clearClaimPending();
        uint256 x = amount % 1e24;
        if (x == 0) x = 1e18;
        stampMock.seedPot(x);
    }

    function act_setWithdrawRevertMode(bool v) external {
        _clearClaimPending();
        stampMock.setShouldRevertWithdraw(v);
    }

    function act_setActorNode(
        uint8 actorId,
        bytes32 overlay,
        uint8 height,
        uint256 effectiveStake,
        uint256 lastUpdated
    ) external {
        _clearClaimPending();
        uint256 idx = uint256(actorId) % ACTOR_COUNT;
        uint8 h = uint8(height % 16);
        uint256 stake = effectiveStake == 0 ? 1e18 : (effectiveStake % 1e24) + 1;
        uint256 u = lastUpdated == 0 ? 1 : lastUpdated;
        stakeMock.setNode(address(actors[idx]), overlay, h, stake, u);
    }

    function act_happyCommit(uint8 actorId, bytes32 hash, bytes32 nonce) external {
        _clearClaimPending();
        if (!redist.currentPhaseCommit()) return;
        if (block.number % ROUND_LENGTH == (ROUND_LENGTH / 4) - 1) return;

        uint256 idx = uint256(actorId) % ACTOR_COUNT;
        EchidnaRedistributionClaimActor a = actors[idx];

        // SWIP-51 requires depth > height; use height 0 / depth 1 (depthResponsibility = 1).
        bytes32 overlay = keccak256(abi.encodePacked("overlay", idx, redist.currentRoundAnchor()));
        uint8 height = 0;
        uint8 depth = 1;

        // Ensure staking is old enough.
        stakeMock.setNode(address(a), overlay, height, 1e18, _backdateLastUpdated());

        bytes32 obf = redist.wrapCommit(redist.currentRound(), overlay, depth, hash, bytes32(0), nonce);
        bool ok = a.callCommit(obf, redist.currentRound(), depth);
        if (!ok) return;
        // commit() does not revert on CommitRejected (frozen closer after auto-finalize).
        if (!_commitExists(obf, address(a))) return;

        trackedHasCommit[idx] = true;
        trackedHasReveal[idx] = false;
        trackedRound[idx] = redist.currentRound();
        trackedObfuscated[idx] = obf;
        trackedHash[idx] = hash;
        trackedNonce[idx] = nonce;
        trackedDepth[idx] = depth;
    }

    function act_happyReveal(uint8 actorId) external {
        _clearClaimPending();
        if (!redist.currentPhaseReveal()) return;

        uint256 idx = uint256(actorId) % ACTOR_COUNT;
        if (!trackedHasCommit[idx] || trackedHasReveal[idx]) return;
        if (redist.currentRound() != trackedRound[idx]) return;
        if (redist.currentCommitRound() != trackedRound[idx]) return;

        bool ok = actors[idx].callReveal(trackedDepth[idx], trackedHash[idx], trackedNonce[idx]);
        if (!ok) return;
        trackedHasReveal[idx] = true;
    }

    /// @dev STS-1 requires a proof validated entry before a claim can select any truth. Real
    /// witnesses are out of reach for a structural fuzzer, so this marks the entry directly; the
    /// truth selection, payout split and freezing that follow are the real implementations.
    function act_markProofValidated(uint8 revealIdx) external {
        _clearClaimPending();
        uint256 len = redist.revealsLength();
        if (len == 0) return;
        redist.markProofValidated(uint256(revealIdx) % len);
    }

    function act_withdrawPayout(uint8 actorId) external {
        _clearClaimPending();
        actors[uint256(actorId) % ACTOR_COUNT].callWithdrawPayout();
    }

    function act_claimStub(uint8 actorId) external {
        _clearClaimPending();
        uint256 idx = uint256(actorId) % ACTOR_COUNT;
        pendingClaimRound = redist.currentRound();
        pendingOracleCallsBefore = oracleMock.calls();
        pendingWithdrawShouldFail = stampMock.shouldRevertWithdraw();

        // Snapshot pot + actor balances before claim.
        pendingPotBefore = stampMock.pot();
        for (uint256 i = 0; i < ACTOR_COUNT; i++) {
            pendingActorBalBefore[i] = token.balanceOf(address(actors[i]));
        }

        bool ok = actors[idx].callClaimStub();
        if (!ok) return;

        if (lastClaimRound == pendingClaimRound) claimSucceededTwiceSameRound = true;
        lastClaimRound = pendingClaimRound;

        pendingClaim = true;
    }

    // -----------------------------
    // Properties
    // -----------------------------

    function echidna_claim_only_once_per_round() external view returns (bool) {
        return !claimSucceededTwiceSameRound;
    }

    /// @notice STS-1 pays several nodes, so the pot is withdrawn into the redistribution contract
    /// and every token of it is accrued to beneficiaries. Nothing is created and nothing is lost.
    function echidna_claim_accrues_whole_pot_to_beneficiaries() external view returns (bool) {
        if (!pendingClaim) return true;
        if (pendingWithdrawShouldFail) return true;
        if (redist.currentClaimRound() != pendingClaimRound) return true;

        // Pot must be zeroed by our mock withdraw on success, and paid to the contract itself.
        if (stampMock.pot() != 0) return false;
        if (stampMock.lastBeneficiary() != address(redist)) return false;
        if (stampMock.lastAmount() != pendingPotBefore) return false;

        // Every withdrawn token must be claimable by someone: accrued balances plus what actors
        // have already drawn down must cover the contract's token balance exactly.
        uint256 accrued;
        uint256 drawn;
        for (uint256 i = 0; i < ACTOR_COUNT; i++) {
            accrued += redist.pendingRedistributionPayouts(address(actors[i]));
            drawn += token.balanceOf(address(actors[i]));
        }
        if (accrued != token.balanceOf(address(redist))) return false;

        // No actor may hold tokens it was never accrued.
        return drawn <= pendingPotBefore + _sumPriorBalances();
    }

    /// @notice Failed withdraw must not mark the round claimed (no pay, no claim).
    function echidna_failed_withdraw_does_not_succeed_claim() external view returns (bool) {
        if (!pendingClaim) return true;
        return !pendingWithdrawShouldFail;
    }

    function echidna_claim_triggers_oracle_adjustPrice() external view returns (bool) {
        if (!pendingClaim) return true;
        if (oracleMock.calls() <= pendingOracleCallsBefore) return false;
        return true;
    }

    function echidna_unfinished_participants_frozen_after_claim() external view returns (bool) {
        if (!pendingClaim) return true;
        if (redist.currentClaimRound() != pendingClaimRound) return true;

        // Under STS-1 a stage one commit is unfinished until it is proof validated, so any actor
        // that committed and did not reveal in that round must have been frozen at least once.
        for (uint256 i = 0; i < ACTOR_COUNT; i++) {
            if (!trackedHasCommit[i]) continue;
            if (trackedRound[i] != pendingClaimRound) continue;
            if (trackedHasReveal[i]) continue;
            if (stakeMock.freezeCount(address(actors[i])) == 0) return false;
        }
        return true;
    }

    function _sumPriorBalances() internal view returns (uint256 total) {
        for (uint256 i = 0; i < ACTOR_COUNT; i++) {
            total += pendingActorBalBefore[i];
        }
    }

    // -----------------------------
    // Helpers
    // -----------------------------

    function _backdateLastUpdated() internal view returns (uint256) {
        uint256 twoRounds = 2 * ROUND_LENGTH;
        if (block.number > twoRounds + 1) return block.number - twoRounds - 1;
        return 1;
    }

    function _commitExists(bytes32 obfuscated, address owner) internal view returns (bool) {
        uint256 lim = redist.currentCommitsLength();
        if (lim > 25) lim = 25;
        for (uint256 i = 0; i < lim; i++) {
            (bool ok, bytes memory data) = address(redist).staticcall(
                abi.encodeWithSignature("currentCommits(uint256)", i)
            );
            if (!ok) break;
            (, address ow, , , , , , bytes32 obf, ) = abi.decode(
                data,
                (bytes32, address, bool, uint8, uint8, uint256, uint256, bytes32, uint256)
            );
            if (ow == owner && obf == obfuscated) return true;
        }
        return false;
    }
}
