// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.19;

import "../Redistribution.sol";

/// @notice Fuzz-only deployment target: pins the post-reveal `seed` so Hardhat-derived
/// `claim()` fixtures stay valid when Echidna/hevm use a different `block.prevrandao` than the original test run.
contract RedistributionFixtureRandomness is Redistribution {
    bytes32 internal immutable fixedPostRevealSeed;

    constructor(
        address staking,
        address postageContract,
        address oracleContract,
        bytes32 _fixedPostRevealSeed
    ) Redistribution(staking, postageContract, oracleContract) {
        fixedPostRevealSeed = _fixedPostRevealSeed;
    }

    function _nextSeedValue() internal view override returns (bytes32) {
        return fixedPostRevealSeed;
    }
}
