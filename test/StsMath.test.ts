import { expect } from './util/chai';
import { ethers } from 'hardhat';
import { BigNumber, Contract } from 'ethers';

// SWIP-050 Appendix A.9. The coefficients are cube roots of binary ratios, carried in Q64.64,
// and they are required to round conservatively: a coefficient must never be larger than the
// mathematical value it approximates.

const Q64 = BigNumber.from(2).pow(64);
const MAX_COEFFICIENT = Q64.mul(2);

/** Q64.64 value as a plain number, for comparison against the SWIP's illustrative tables. */
function toFloat(q: BigNumber): number {
  return q.mul(1_000_000).div(Q64).toNumber() / 1_000_000;
}

describe('StsMath', function () {
  let math: Contract;

  before(async function () {
    const factory = await ethers.getContractFactory('StsMathExposed');
    math = await factory.deploy();
    await math.deployed();
  });

  describe('fixed point primitives', function () {
    it('rounds mulDivUp up only when there is a remainder', async function () {
      expect(await math.mulDivUp(10, 1, 5)).to.equal(2);
      expect(await math.mulDivUp(11, 1, 5)).to.equal(3);
      expect(await math.mulDivUp(0, 1, 5)).to.equal(0);
    });

    it('represents ratios in Q64.64', async function () {
      expect(await math.ratioQ64(2, 1)).to.equal(Q64.mul(2));
      expect(await math.ratioQ64(1, 2)).to.equal(Q64.div(2));
      expect(await math.ratioQ64(1, 1)).to.equal(Q64);
    });

    it('saturates rather than overflowing on a zero or tiny denominator', async function () {
      const saturated = await math.ratioQ64(1, 0);
      expect(saturated).to.equal(Q64.mul(BigNumber.from(2).pow(96)));
      // A saturated ratio still resolves to the coefficient cap, not to garbage.
      expect(await math.cubeRootQ64(saturated)).to.equal(MAX_COEFFICIENT);
    });

    it('cubes exactly at the representable points', async function () {
      expect(await math.cubeQ64(Q64)).to.equal(Q64);
      expect(await math.cubeQ64(Q64.mul(2))).to.equal(Q64.mul(8));
    });
  });

  describe('cube root', function () {
    it('floors at 1x for anything at or below 1x', async function () {
      expect(await math.cubeRootQ64(0)).to.equal(Q64);
      expect(await math.cubeRootQ64(Q64.div(2))).to.equal(Q64);
      expect(await math.cubeRootQ64(Q64)).to.equal(Q64);
    });

    it('is exact on perfect cubes', async function () {
      expect(await math.cubeRootQ64(Q64.mul(8))).to.equal(Q64.mul(2));
    });

    it('never returns a value whose cube exceeds the input', async function () {
      const inputs = [
        Q64.mul(11).div(10),
        Q64.mul(4).div(3),
        Q64.mul(2),
        Q64.mul(5).div(2),
        Q64.mul(4),
        Q64.mul(7),
        Q64.mul(8),
      ];
      for (const input of inputs) {
        const root = await math.cubeRootQ64(input);
        expect(await math.cubeQ64(root), `cube of root of ${input.toString()}`).to.be.lte(input);
      }
    });

    it('is tight: one ulp higher would overshoot', async function () {
      const input = Q64.mul(7); // not a perfect cube in Q64.64
      const root = await math.cubeRootQ64(input);
      expect(await math.cubeQ64(root)).to.be.lte(input);
      expect(await math.cubeQ64(root.add(1))).to.be.gt(input);
    });

    // Deviation from SWIP-050 as written, which caps at 2^32. See
    // docs/SWIP-49-50-SCRUTINY.md 2.2.
    it('caps at 2x however large the ratio', async function () {
      expect(await math.cubeRootQ64(Q64.mul(8))).to.equal(MAX_COEFFICIENT);
      expect(await math.cubeRootQ64(Q64.mul(1000))).to.equal(MAX_COEFFICIENT);
      expect(await math.cubeRootQ64(Q64.mul(BigNumber.from(2).pow(90)))).to.equal(MAX_COEFFICIENT);
    });
  });

  describe('stamp density coefficient', function () {
    const limit = Q64.mul(1_000_000); // arbitrary ceiling, only the ratio matters

    it('matches the table in SWIP-050 to three decimals', async function () {
      const table: [number, number][] = [
        [0.9, 1.036],
        [0.75, 1.101],
        [0.5, 1.26],
        [0.4, 1.357],
        [0.25, 1.587],
        [0.125, 2.0],
      ];

      for (const [fraction, expected] of table) {
        const x = limit.mul(Math.round(fraction * 1000)).div(1000);
        const coefficient = await math.stampDensityCoefficientQ64(x, limit);
        expect(toFloat(coefficient), `density at ${fraction}L`).to.be.closeTo(expected, 0.001);
      }
    });

    it('gives no benefit when the density witness only just passes', async function () {
      expect(await math.stampDensityCoefficientQ64(limit.sub(1), limit)).to.equal(Q64);
    });

    it('reports failure when the density witness is at or above the limit', async function () {
      expect(await math.stampDensityCoefficientQ64(limit, limit)).to.equal(0);
      expect(await math.stampDensityCoefficientQ64(limit.add(1), limit)).to.equal(0);
      expect(await math.stampDensityCoefficientQ64(0, limit)).to.equal(0);
    });

    // The reason the limit takes no depth argument: if it scaled with the claimed depth, the
    // largest proven value would scale with it too, the ratio would be unchanged, and
    // overreporting depth would be a free 2^k on base stake density.
    it('is unchanged when limit and value scale together', async function () {
      const base = await math.stampDensityCoefficientQ64(limit.div(4), limit);
      const scaled = await math.stampDensityCoefficientQ64(limit.div(4).mul(16), limit.mul(16));
      expect(scaled).to.equal(base);
    });
  });

  describe('utilization coefficient', function () {
    const witnesses = 3;

    /** Sum of three identical per-witness ratios expressed as numerator/denominator. */
    function sumFor(numerator: number, denominator: number): BigNumber {
      return Q64.mul(numerator).div(denominator).mul(witnesses);
    }

    it('matches the table in SWIP-050 to three decimals', async function () {
      const table: [number, number, number][] = [
        [1, 2, 1.0],
        [3, 8, 1.101],
        [1, 4, 1.26],
        [1, 5, 1.357],
        [1, 8, 1.587],
        [1, 16, 2.0],
      ];

      for (const [numerator, denominator, expected] of table) {
        const coefficient = await math.utilizationCoefficientQ64(sumFor(numerator, denominator), witnesses);
        expect(toFloat(coefficient), `utilization at ${numerator}/${denominator}`).to.be.closeTo(expected, 0.001);
      }
    });

    it('does not penalise worse than half-full buckets', async function () {
      expect(await math.utilizationCoefficientQ64(sumFor(3, 4), witnesses)).to.equal(Q64);
      expect(await math.utilizationCoefficientQ64(Q64.mul(witnesses), witnesses)).to.equal(Q64);
    });

    it('caps at 2x for an arbitrarily deep batch stamped at index zero', async function () {
      // A depth 32 batch with bucket depth 16 has 65536 slots; index 0 gives a ratio of
      // 1/65536, which the appendix as written would turn into a 32x multiplier.
      const sum = Q64.div(65536).mul(witnesses);
      expect(await math.utilizationCoefficientQ64(sum, witnesses)).to.equal(MAX_COEFFICIENT);
      expect(await math.utilizationCoefficientQ64(witnesses, witnesses)).to.equal(MAX_COEFFICIENT);
      expect(await math.utilizationCoefficientQ64(0, witnesses)).to.equal(MAX_COEFFICIENT);
    });

    it('rounds the average up, so a mixed sample never overstates its benefit', async function () {
      // Two witnesses at 1/8 and one at 1/2 average to 1/4 exactly; anything that rounds the
      // average down would award more than that.
      const sum = Q64.div(8).mul(2).add(Q64.div(2));
      const coefficient = await math.utilizationCoefficientQ64(sum, witnesses);
      const exact = await math.utilizationCoefficientQ64(Q64.div(4).mul(witnesses), witnesses);
      expect(coefficient).to.be.lte(exact);
    });

    it('is neutral when there are no witnesses', async function () {
      expect(await math.utilizationCoefficientQ64(0, 0)).to.equal(Q64);
    });
  });

  describe('combined weight', function () {
    // SWIP-050's safety argument: underreporting depth by k bits loses 2^k of base stake
    // density and can gain at most cbrt(2^k) from each coefficient, so it stays 2^(k/3) worse.
    // With both coefficients capped at 2x the combined gain is at most 4x, which keeps the
    // argument true for every k and removes the unbounded tail.
    it('cannot multiply base weight by more than four', async function () {
      const base = BigNumber.from(10).pow(20);
      const withDensity = await math.applyCoefficient(base, MAX_COEFFICIENT);
      const withBoth = await math.applyCoefficient(withDensity, MAX_COEFFICIENT);
      expect(withBoth).to.equal(base.mul(4));
    });

    it('leaves weight untouched at the neutral coefficient', async function () {
      const base = BigNumber.from('12345678901234567890');
      expect(await math.applyCoefficient(base, Q64)).to.equal(base);
    });
  });
});
