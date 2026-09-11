// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.19;

import "../Redistribution.sol";

/// @notice Test/fuzz wrapper: exposes `winnerSelection` and array lengths so harnesses need not call
/// the auto-generated `currentCommits(i)` / `currentReveals(i)` getters out of bounds (those revert).
contract RedistributionExposed is Redistribution {
    constructor(
        address staking,
        address postageContract,
        address oracleContract,
        address token
    ) Redistribution(staking, postageContract, oracleContract, token) {}

    /// @notice Fuzz-only: mark a revealed overlay proof validated without running the witnesses.
    /// @dev STS-1 proof submission needs real BMT witnesses and postage signatures, which a
    /// structural fuzzer cannot produce. This bypass lets the harness reach truth selection,
    /// payout and freezing, which is what the invariants below are about.
    function exposedMarkProofValidated(uint256 revealIndex, uint256 weight) external {
        Reveal storage r = currentReveals[revealIndex];
        r.stampRevealed = true;
        r.proofSubmitted = true;
        r.effectiveStakeDensity = weight == 0 ? r.stakeDensity : weight;
    }

    function exposedSetStampHash(uint256 revealIndex, bytes32 stampHash) external {
        currentReveals[revealIndex].stampHash = stampHash;
    }

    /// @notice Fuzz-only equivalent of the old single-shot winnerSelection(): finalize participation
    /// (non-reveal freezes + tentative winner) then apply disagreement penalties and consume the round.
    function exposedWinnerSelection() external {
        uint64 cr = currentRound();

        if (!currentPhaseClaim()) {
            revert NotClaimPhase();
        }
        if (cr != currentRevealRound) {
            revert NoReveals();
        }
        if (cr <= currentClaimRound) {
            revert AlreadyClaimed();
        }
        if (participationFinalized[cr]) {
            revert AlreadyClaimed();
        }

        _finalizeParticipation(cr);

        bool success = OracleContract.adjustPrice(lastRedundancyCount);
        if (!success) {
            emit PriceAdjustmentSkipped(lastRedundancyCount);
        }
        currentClaimRound = cr;
    }

    function currentCommitsLength() external view returns (uint256) {
        return currentCommits.length;
    }

    function currentRevealsLength() external view returns (uint256) {
        return currentReveals.length;
    }
}
