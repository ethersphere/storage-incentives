// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title STS-1 fixed point coefficient arithmetic
 * @author The Swarm Authors
 * @dev SWIP-050 weights a proof-validated entry by two continuous cube-root coefficients on top
 * of its base stake density. Both are ratios of binary quantities, so they are carried in Q64.64:
 * `Q64` is 1.0x, `2 * Q64` is 2.0x, `Q64 / 2` is 0.5x.
 *
 * Rounding is conservative throughout: a coefficient is never larger than the mathematical value
 * it approximates. Benefit ratios round down, the average index ratio rounds up before it is used
 * as a denominator, and the cube root returns the largest Q64.64 value whose cube does not exceed
 * its input.
 *
 * Deviation from SWIP-050, see docs/SWIP-49-50-SCRUTINY.md 2.2: both coefficients are capped at
 * 2x. As written the appendix caps at 2^32, which makes the cheapest way to multiply
 * redistribution weight by 32 "buy a very deep batch and stamp only the lowest index of each
 * bucket" - rewarding wasted batch capacity, which is the opposite of the stated motivation. The
 * SWIP's own tables describe a 1x..2x range, and its underreporting safety argument only holds if
 * each factor is bounded by the density actually proven.
 */
library StsMath {
    // 1.0x in Q64.64.
    uint256 internal constant Q64 = 1 << 64;

    // Ceiling for both coefficients. See the deviation note above.
    uint256 internal constant MAX_COEFFICIENT_Q64 = 2 * Q64;

    // Saturation point for a ratio, so a zero or tiny denominator cannot overflow the Q64.64
    // representation. Any ratio at or above this pins the coefficient to its cap anyway.
    uint256 internal constant MAX_RATIO_REAL = 1 << 96;
    uint256 internal constant MAX_RATIO_Q64 = MAX_RATIO_REAL * Q64;

    /**
     * @notice `x * y / denominator`, rounded up.
     */
    function mulDivUp(uint256 x, uint256 y, uint256 denominator) internal pure returns (uint256 result) {
        result = Math.mulDiv(x, y, denominator);
        if (mulmod(x, y, denominator) != 0) {
            result += 1;
        }
    }

    /**
     * @notice `numerator / denominator` as Q64.64, rounded down and saturating.
     */
    function ratioQ64(uint256 numerator, uint256 denominator) internal pure returns (uint256) {
        if (denominator == 0) {
            return MAX_RATIO_Q64;
        }
        if (numerator / denominator >= MAX_RATIO_REAL) {
            return MAX_RATIO_Q64;
        }
        return Math.mulDiv(numerator, Q64, denominator);
    }

    /**
     * @notice Cube of a Q64.64 value, in Q64.64.
     */
    function cubeQ64(uint256 valueQ64) internal pure returns (uint256) {
        uint256 squareQ64 = Math.mulDiv(valueQ64, valueQ64, Q64);
        return Math.mulDiv(squareQ64, valueQ64, Q64);
    }

    /**
     * @notice Largest Q64.64 value in [1x, MAX_COEFFICIENT_Q64] whose cube does not exceed the input.
     * @dev Below 1x there is no benefit to award, so the result floors at 1x. Because the search
     * range is bounded by the coefficient cap rather than by the input, this is a fixed-width
     * binary search with no doubling phase.
     */
    function cubeRootQ64(uint256 valueQ64) internal pure returns (uint256) {
        if (valueQ64 <= Q64) {
            return Q64;
        }
        if (cubeQ64(MAX_COEFFICIENT_Q64) <= valueQ64) {
            return MAX_COEFFICIENT_Q64;
        }

        uint256 low = Q64;
        uint256 high = MAX_COEFFICIENT_Q64;

        while (low + 1 < high) {
            uint256 middle = (low + high) / 2;
            if (cubeQ64(middle) <= valueQ64) {
                low = middle;
            } else {
                high = middle;
            }
        }

        return low;
    }

    /**
     * @notice Stamp density coefficient, `cbrt(limit / largestProvenValue)`.
     * @dev `limit` is the sample ceiling the density witness must fall under. It is deliberately
     * NOT a function of the claimed depth: a depth-scaled ceiling would grow in step with the
     * largest proven value, cancelling out of the ratio and leaving depth overreporting a free
     * `2^k` gain on base stake density. See docs/SWIP-49-50-SCRUTINY.md 2.1.
     * @param largestProvenValue The transformed stamp value at the density witness position.
     * @param limit The depth-independent stamp sample ceiling.
     * @return The coefficient in Q64.64, or zero if the sample is not dense enough to pass.
     */
    function stampDensityCoefficientQ64(uint256 largestProvenValue, uint256 limit) internal pure returns (uint256) {
        if (largestProvenValue == 0 || largestProvenValue >= limit) {
            return 0;
        }
        return cubeRootQ64(ratioQ64(limit, largestProvenValue));
    }

    /**
     * @notice Utilization coefficient, `max(1, cbrt(1 / (2 * averageIndexRatio)))`.
     * @dev Rewards stamps drawn from low within-bucket indexes, which ordinary uploads tend to
     * fill first. A half-full bucket is the neutral point; worse than that is not penalised.
     * @param sumIndexRatioQ64 Sum of the per-witness `(withinBucketIndex + 1) / slotsPerBucket`
     * ratios, each already rounded up so the average never overstates the benefit.
     * @param witnessCount Number of witnesses contributing to the sum.
     */
    function utilizationCoefficientQ64(uint256 sumIndexRatioQ64, uint256 witnessCount) internal pure returns (uint256) {
        if (witnessCount == 0) {
            return Q64;
        }

        uint256 averageIndexRatioQ64 = mulDivUp(sumIndexRatioQ64, 1, witnessCount);

        if (averageIndexRatioQ64 >= Q64 / 2) {
            return Q64;
        }
        if (averageIndexRatioQ64 == 0) {
            return MAX_COEFFICIENT_Q64;
        }

        return cubeRootQ64(Math.mulDiv(Q64, Q64, 2 * averageIndexRatioQ64));
    }

    /**
     * @notice Apply a Q64.64 coefficient to a value.
     */
    function applyCoefficient(uint256 value, uint256 coefficientQ64) internal pure returns (uint256) {
        return Math.mulDiv(value, coefficientQ64, Q64);
    }
}
