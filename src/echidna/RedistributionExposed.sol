// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.19;

import "../Redistribution.sol";

/// @notice Test/fuzz wrapper: exposes `winnerSelection` and array lengths so harnesses need not call
/// the auto-generated `currentCommits(i)` / `currentReveals(i)` getters out of bounds (those revert).
contract RedistributionExposed is Redistribution {
    constructor(
        address staking,
        address postageContract,
        address oracleContract
    ) Redistribution(staking, postageContract, oracleContract, 152) {}

    function exposedWinnerSelection() external {
        winnerSelection();
    }

    function currentCommitsLength() external view returns (uint256) {
        return currentCommits.length;
    }

    function currentRevealsLength() external view returns (uint256) {
        return currentReveals.length;
    }
}
