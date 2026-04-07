// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.19;

import "../Redistribution.sol";
import "../TestToken.sol";
import "../interface/IPostageStamp.sol";
import "./EchidnaMocks.sol";

contract EchidnaPostageStampPotMock is IPostageStamp {
    TestToken internal immutable token;

    uint256 public pot;
    uint256 public withdrawCalls;
    address public lastBeneficiary;
    uint256 public lastAmount;
    uint256 public validChunkCountValue;

    constructor(TestToken t) {
        token = t;
    }

    function seedPot(uint256 amount) external {
        // Mint to this mock and treat it as withdrawable pot.
        token.mint(address(this), amount);
        pot += amount;
    }

    function setValidChunkCount(uint256 v) external {
        validChunkCountValue = v;
    }

    function withdraw(address beneficiary) external {
        uint256 bal = token.balanceOf(address(this));
        uint256 amt = pot < bal ? pot : bal;
        withdrawCalls += 1;
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
        address oracleContract
    ) Redistribution(staking, postageContract, oracleContract) {}

    /// @notice Fuzz-only claim: run real winnerSelection(), then withdraw pot to winner.
    /// @dev Bypasses inclusion/SOC/stamp proof verification entirely.
    function claimStub() external whenNotPaused {
        winnerSelection();
        Reveal memory winnerSelected = winner;

        (bool success, ) = address(PostageContract).call(
            abi.encodeWithSignature("withdraw(address)", winnerSelected.owner)
        );
        if (!success) {
            emit WithdrawFailed(winnerSelected.owner);
        }

        emit WinnerSelected(winnerSelected);
        emit ChunkCount(PostageContract.validChunkCount());
    }
}

contract EchidnaRedistributionClaimActor {
    RedistributionClaimStub internal immutable redist;

    constructor(RedistributionClaimStub r) {
        redist = r;
    }

    function callCommit(bytes32 obfuscatedHash, uint64 roundNumber) external returns (bool ok) {
        (ok, ) = address(redist).call(abi.encodeWithSelector(redist.commit.selector, obfuscatedHash, roundNumber));
    }

    function callReveal(uint8 depth, bytes32 hash, bytes32 nonce) external returns (bool ok) {
        (ok, ) = address(redist).call(abi.encodeWithSelector(redist.reveal.selector, depth, hash, nonce));
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
        redist = new RedistributionClaimStub(address(stakeMock), address(stampMock), address(oracleMock));

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

    function act_seedPot(uint256 amount) external {
        _clearClaimPending();
        uint256 x = amount % 1e24;
        if (x == 0) x = 1e18;
        stampMock.seedPot(x);
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

        // Make proximity always pass by setting depth == height (depthResponsibility=0).
        bytes32 overlay = keccak256(abi.encodePacked("overlay", idx, redist.currentRoundAnchor()));
        uint8 height = 0;
        uint8 depth = 0;

        // Ensure staking is old enough.
        stakeMock.setNode(address(a), overlay, height, 1e18, _backdateLastUpdated());

        bytes32 obf = redist.wrapCommit(overlay, depth, hash, nonce);
        bool ok = a.callCommit(obf, redist.currentRound());
        if (!ok) return;

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

    function act_claimStub(uint8 actorId) external {
        _clearClaimPending();
        uint256 idx = uint256(actorId) % ACTOR_COUNT;
        pendingClaimRound = redist.currentRound();
        pendingOracleCallsBefore = oracleMock.calls();

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

    function echidna_claim_withdraws_pot_to_winner_when_successful() external view returns (bool) {
        if (!pendingClaim) return true;
        if (redist.currentClaimRound() != pendingClaimRound) return true; // stale

        // Pot must be zeroed by our mock withdraw on success.
        if (stampMock.pot() != 0) return false;

        // Beneficiary must match the winner selected by the round logic.
        (, address winnerOwner, , , , ) = redist.winner();
        if (stampMock.lastBeneficiary() != winnerOwner) return false;

        // The amount transferred must match the pot snapshot (our mock mints on seedPot).
        if (stampMock.lastAmount() != pendingPotBefore) return false;

        // Exactly one actor's balance should increase by lastAmount, matching the beneficiary.
        uint256 increased = 0;
        for (uint256 i = 0; i < ACTOR_COUNT; i++) {
            uint256 afterBal = token.balanceOf(address(actors[i]));
            if (afterBal != pendingActorBalBefore[i]) {
                if (afterBal != pendingActorBalBefore[i] + stampMock.lastAmount()) return false;
                if (address(actors[i]) != stampMock.lastBeneficiary()) return false;
                increased += 1;
            }
        }
        // If potBefore was 0, no balances should change.
        if (pendingPotBefore == 0) return increased == 0;
        return increased == 1;
    }

    function echidna_claim_triggers_oracle_adjustPrice() external view returns (bool) {
        if (!pendingClaim) return true;
        if (oracleMock.calls() <= pendingOracleCallsBefore) return false;
        return true;
    }

    function echidna_nonrevealers_frozen_after_claim_selection() external view returns (bool) {
        if (!pendingClaim) return true;
        if (redist.currentClaimRound() != pendingClaimRound) return true;

        // Any actor that committed but did not reveal in that round should have been frozen at least once.
        for (uint256 i = 0; i < ACTOR_COUNT; i++) {
            if (!trackedHasCommit[i]) continue;
            if (trackedRound[i] != pendingClaimRound) continue;
            if (trackedHasReveal[i]) continue;
            if (stakeMock.freezeCount(address(actors[i])) == 0) return false;
        }
        return true;
    }

    // -----------------------------
    // Helpers
    // -----------------------------

    function _backdateLastUpdated() internal view returns (uint256) {
        uint256 twoRounds = 2 * ROUND_LENGTH;
        if (block.number > twoRounds + 1) return block.number - twoRounds - 1;
        return 1;
    }
}
