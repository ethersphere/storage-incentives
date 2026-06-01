// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.19;

/**
 * @title Protocol-wide constants for Swarm storage incentives.
 */
library Constants {
    /// @notice Length of a round in blocks (~12.7 minutes at 5s/block).
    uint256 internal constant ROUND_LENGTH = 152;
}
