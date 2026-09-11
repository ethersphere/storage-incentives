// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.19;

import "../Util/StsMath.sol";

/**
 * @title Test harness exposing the STS-1 coefficient arithmetic
 * @dev StsMath is an internal library, so its functions are only reachable from a contract that
 * links them. This wrapper exists so the Q64.64 maths can be unit tested and fuzzed directly,
 * independently of the redistribution round machinery.
 */
contract StsMathExposed {
    function q64() external pure returns (uint256) {
        return StsMath.Q64;
    }

    function maxCoefficientQ64() external pure returns (uint256) {
        return StsMath.MAX_COEFFICIENT_Q64;
    }

    function mulDivUp(uint256 x, uint256 y, uint256 d) external pure returns (uint256) {
        return StsMath.mulDivUp(x, y, d);
    }

    function ratioQ64(uint256 n, uint256 d) external pure returns (uint256) {
        return StsMath.ratioQ64(n, d);
    }

    function cubeQ64(uint256 v) external pure returns (uint256) {
        return StsMath.cubeQ64(v);
    }

    function cubeRootQ64(uint256 v) external pure returns (uint256) {
        return StsMath.cubeRootQ64(v);
    }

    function stampDensityCoefficientQ64(uint256 largestProvenValue, uint256 limit) external pure returns (uint256) {
        return StsMath.stampDensityCoefficientQ64(largestProvenValue, limit);
    }

    function utilizationCoefficientQ64(uint256 sum, uint256 count) external pure returns (uint256) {
        return StsMath.utilizationCoefficientQ64(sum, count);
    }

    function applyCoefficient(uint256 value, uint256 coefficientQ64) external pure returns (uint256) {
        return StsMath.applyCoefficient(value, coefficientQ64);
    }
}
