import { expect } from './util/chai';
import { ethers, deployments, getNamedAccounts } from 'hardhat';
import { Contract } from 'ethers';
import { mineNBlocks, computeBatchId, mintAndApprove, getBlockNumber } from './util/tools';

// SWIP-049 fixes the set of batches and stamp indexes a redistribution round may use, at the
// block sampling begins. These tests pin the three mechanisms that make that work:
//
//   * the reconstructed price and cumulative outpayment at the sampling-start block,
//   * the retained batch depth history and the boundary rule that decides what is retained,
//   * the balance rules that stop a later top-up or dilution from moving a batch across the
//     usability boundary of a round that is already open.

const ROUND_LENGTH = 152;
const REVEAL_OFFSET = 38;
const ROUND_USABILITY_BLOCKS = 456;
const MIN_VALIDITY_BLOCKS = 912;

/** Sampling for target round `r` starts at the first reveal block of round `r - 1`. */
function samplingStartBlock(targetRound: number): number {
  return (targetRound - 1) * ROUND_LENGTH + REVEAL_OFFSET;
}

/** Mirror of PostageStamp._firstSamplingStartAfter: first sampling start strictly after `block`. */
function firstSamplingStartAfter(blockNumber: number): number {
  if (blockNumber < REVEAL_OFFSET) return REVEAL_OFFSET;
  const completed = Math.floor((blockNumber - REVEAL_OFFSET) / ROUND_LENGTH);
  return REVEAL_OFFSET + (completed + 1) * ROUND_LENGTH;
}

/** Mine until the next transaction will be included in exactly `target`. */
async function mineUntilNextBlockIs(target: number): Promise<void> {
  const current = await getBlockNumber();
  const toMine = target - 1 - current;
  if (toMine < 0) throw new Error(`block ${target} already passed (at ${current})`);
  await mineNBlocks(toMine);
}

let deployer: string;
let stamper: string;
let oracle: string;

before(async function () {
  const named = await getNamedAccounts();
  deployer = named.deployer;
  stamper = named.stamper;
  oracle = named.oracle;
});

describe('PostageStamp SWIP-049', function () {
  let admin: Contract;
  let stamperStamp: Contract;
  let oracleStamp: Contract;
  let price: number;

  const depth = 17;
  const bucketDepth = 16;

  beforeEach(async function () {
    await deployments.fixture();
    admin = await ethers.getContract('PostageStamp', deployer);
    stamperStamp = await ethers.getContract('PostageStamp', stamper);

    const priceOracleRole = await admin.PRICE_ORACLE_ROLE();
    await admin.grantRole(priceOracleRole, oracle);
    oracleStamp = await ethers.getContract('PostageStamp', oracle);

    // Run the suite at the SWIP-049 floor so block counts in these tests are the batch
    // lifetimes, rather than being dominated by the default 24 hour validity minimum.
    await admin.setMinimumValidityBlocks(MIN_VALIDITY_BLOCKS);

    price = 1000;
    await oracleStamp.setPrice(price);
  });

  /** Create a batch worth `blocks` blocks of balance at the current price. */
  async function createBatch(nonce: string, blocks: number, batchDepth = depth): Promise<string> {
    const perChunk = price * blocks;
    const transfer = perChunk * 2 ** batchDepth;
    await mintAndApprove(deployer, stamper, stamperStamp.address, transfer.toString());
    await stamperStamp.createBatch(stamper, perChunk, batchDepth, bucketDepth, nonce, false);
    return computeBatchId(stamper, nonce);
  }

  const nonceA = '0x000000000000000000000000000000000000000000000000000000000000000a';
  const nonceB = '0x000000000000000000000000000000000000000000000000000000000000000b';

  describe('constants', function () {
    it('exposes the round schedule and balance thresholds Bee has to mirror', async function () {
      expect(await admin.REDISTRIBUTION_ROUND_BLOCKS()).to.equal(ROUND_LENGTH);
      expect(await admin.REDISTRIBUTION_REVEAL_OFFSET()).to.equal(REVEAL_OFFSET);
      expect(await admin.ROUND_USABILITY_BLOCKS()).to.equal(ROUND_USABILITY_BLOCKS);
      expect(await admin.MIN_OPERATION_VALIDITY_BLOCKS()).to.equal(MIN_VALIDITY_BLOCKS);
    });

    it('refuses an operation minimum below six redistribution rounds', async function () {
      await expect(admin.setMinimumValidityBlocks(MIN_VALIDITY_BLOCKS - 1)).to.be.revertedWith(
        'MinimumValidityTooShort()'
      );
      await admin.setMinimumValidityBlocks(MIN_VALIDITY_BLOCKS);
      expect(await admin.minimumValidityBlocks()).to.equal(MIN_VALIDITY_BLOCKS);
    });
  });

  describe('price history', function () {
    it('records the superseded price and the block it became active', async function () {
      const firstUpdateBlock = await getBlockNumber(); // the setPrice in beforeEach
      expect(await admin.lastPrice()).to.equal(price);
      expect(await admin.lastUpdatedBlock()).to.equal(firstUpdateBlock);

      await mineNBlocks(5);
      await oracleStamp.setPrice(price * 2);
      const secondUpdateBlock = await getBlockNumber();

      expect(await admin.lastPrice()).to.equal(price * 2);
      expect(await admin.lastUpdatedBlock()).to.equal(secondUpdateBlock);
      expect(await admin.previousPrice()).to.equal(price);
      expect(await admin.previousPriceUpdatedBlock()).to.equal(firstUpdateBlock);
    });

    it('reconstructs the threshold forward when no price update followed sampling start', async function () {
      const priceBlock = await getBlockNumber();
      await mineNBlocks(20);

      const samplingStart = priceBlock + 10;
      const expected = (samplingStart - priceBlock) * price + ROUND_USABILITY_BLOCKS * price;

      expect(await admin.redistributionMinimumNormalisedBalance(samplingStart)).to.equal(expected);
    });

    it('reconstructs the threshold backward across one price update', async function () {
      const firstUpdateBlock = await getBlockNumber();
      await mineNBlocks(30);

      const samplingStart = firstUpdateBlock + 10;
      // Threshold computed while the first price is still the only one.
      const beforeUpdate = await admin.redistributionMinimumNormalisedBalance(samplingStart);

      await oracleStamp.setPrice(price * 7);

      // The same round must see the same threshold after the price moved. That is the whole
      // point: Bee fixed this number at sampling start and the claim must agree with it.
      expect(await admin.redistributionMinimumNormalisedBalance(samplingStart)).to.equal(beforeUpdate);
    });

    it('rejects a sampling start in the future', async function () {
      const future = (await getBlockNumber()) + 100;
      await expect(admin.redistributionMinimumNormalisedBalance(future)).to.be.revertedWith(
        'FutureSamplingStartBlock()'
      );
    });

    // SWIP-049 argues from claim ordering that at most one price update can follow sampling
    // start. PriceOracle.setPrice is an unrestricted admin path, so the contract checks the
    // invariant instead of assuming it. See docs/SWIP-49-50-SCRUTINY.md 1.1.
    it('refuses to reconstruct across two price updates instead of returning a wrong number', async function () {
      const firstUpdateBlock = await getBlockNumber();
      await mineNBlocks(10);
      const samplingStart = firstUpdateBlock + 5;

      await oracleStamp.setPrice(price * 2);
      // One update after sampling start is still reconstructible.
      await admin.redistributionMinimumNormalisedBalance(samplingStart);

      await oracleStamp.setPrice(price * 3);
      await expect(admin.redistributionMinimumNormalisedBalance(samplingStart)).to.be.revertedWith(
        'PriceHistoryUnavailable()'
      );
    });
  });

  describe('batch usability at sampling start', function () {
    it('returns the live depth for a batch created before sampling began', async function () {
      const batchId = await createBatch(nonceA, MIN_VALIDITY_BLOCKS * 2);
      const createdAt = await getBlockNumber();

      await mineNBlocks(5);
      const samplingStart = createdAt + 1;

      const result = await admin.redistributionBatchAt(batchId, samplingStart);
      expect(result.depthAtSamplingStart).to.equal(depth);
      expect(result.bucketDepth).to.equal(bucketDepth);
      expect(result.owner).to.equal(stamper);
    });

    it('rejects a batch that did not exist when sampling began', async function () {
      const batchId = await createBatch(nonceA, MIN_VALIDITY_BLOCKS * 2);
      const createdAt = await getBlockNumber();
      await mineNBlocks(2);

      // A batch created in the sampling-start block is already too late: the round reads the
      // state at the end of the preceding block.
      await expect(admin.redistributionBatchAt(batchId, createdAt)).to.be.revertedWith(
        'BatchNotUsableForRedistribution'
      );
    });

    it('rejects an expired batch even before the expiry sweep has run', async function () {
      const batchId = await createBatch(nonceA, MIN_VALIDITY_BLOCKS);
      const createdAt = await getBlockNumber();

      await mineNBlocks(MIN_VALIDITY_BLOCKS + 5);

      // Still present in the mapping, but out of balance.
      expect(await admin.batchOwner(batchId)).to.equal(stamper);
      await expect(admin.redistributionBatchAt(batchId, createdAt + 1)).to.be.revertedWith(
        'BatchNotUsableForRedistribution'
      );
    });

    it('rejects a sampling start in the future', async function () {
      const batchId = await createBatch(nonceA, MIN_VALIDITY_BLOCKS * 2);
      const future = (await getBlockNumber()) + 100;
      await expect(admin.redistributionBatchAt(batchId, future)).to.be.revertedWith('FutureSamplingStartBlock()');
    });

    // The threshold is denominated in the price that was in force at sampling start, so a batch
    // funded under a low price can be outside a round's scope even though it is comfortably
    // alive. Redistribution compares exactly these two numbers.
    it('puts a thinly funded batch below the threshold the round fixed', async function () {
      const batchId = await createBatch(nonceA, MIN_VALIDITY_BLOCKS);
      const createdAt = await getBlockNumber();

      await mineNBlocks(2);

      const samplingStart = createdAt + 1;
      expect((await admin.redistributionBatchAt(batchId, samplingStart)).normalisedBalance).to.be.gte(
        await admin.redistributionMinimumNormalisedBalance(samplingStart)
      );

      // A price rise before the next round's sampling start raises that round's threshold while
      // the batch's normalised balance stands still.
      await oracleStamp.setPrice(price * 5);
      await mineNBlocks(2);
      const laterSamplingStart = await getBlockNumber();

      const batchNow = await admin.redistributionBatchAt(batchId, laterSamplingStart);
      const thresholdNow = await admin.redistributionMinimumNormalisedBalance(laterSamplingStart);
      expect(batchNow.normalisedBalance).to.be.lt(thresholdNow);
    });
  });

  describe('depth history', function () {
    // A batch must be able to fund a dilution and still clear the six-round minimum afterwards.
    const roomyBlocks = MIN_VALIDITY_BLOCKS * 16;

    it('retains the depth a sampling boundary observed', async function () {
      const batchId = await createBatch(nonceA, roomyBlocks);
      const createdAt = await getBlockNumber();

      // Cross the next sampling boundary, then dilute. The old depth was fixed for that round
      // and must be retained.
      const boundary = firstSamplingStartAfter(createdAt);
      await mineUntilNextBlockIs(boundary + 1);
      await stamperStamp.increaseDepth(batchId, depth + 1);

      const history = await admin.batchDepthHistory(batchId);
      expect(history.previousDepth).to.equal(depth);
      expect(history.previousDepthBlock).to.equal(createdAt);
      expect(history.olderDepth).to.equal(0);

      // The round that sampled at the boundary still sees the old depth ...
      expect((await admin.redistributionBatchAt(batchId, boundary)).depthAtSamplingStart).to.equal(depth);
      // ... while a later round sees the new one.
      const laterBoundary = firstSamplingStartAfter(boundary);
      await mineUntilNextBlockIs(laterBoundary + 1);
      expect((await admin.redistributionBatchAt(batchId, laterBoundary)).depthAtSamplingStart).to.equal(depth + 1);
    });

    it('does not spend a history slot on a depth no round ever fixed', async function () {
      const batchId = await createBatch(nonceA, roomyBlocks);
      const createdAt = await getBlockNumber();

      const boundary = firstSamplingStartAfter(createdAt);
      await mineUntilNextBlockIs(boundary + 1);
      await stamperStamp.increaseDepth(batchId, depth + 1); // records depth, boundary crossed

      // Second dilution before the next boundary: depth + 1 was only ever an intermediate live
      // value, so the retained history must not rotate.
      await stamperStamp.increaseDepth(batchId, depth + 2);

      const history = await admin.batchDepthHistory(batchId);
      expect(history.previousDepth).to.equal(depth);
      expect(history.previousDepthBlock).to.equal(createdAt);
      expect(history.olderDepth).to.equal(0);

      expect((await admin.redistributionBatchAt(batchId, boundary)).depthAtSamplingStart).to.equal(depth);
    });

    it('keeps two depths alive at once while neighbouring round scopes overlap', async function () {
      const batchId = await createBatch(nonceA, roomyBlocks);
      const createdAt = await getBlockNumber();

      const boundary1 = firstSamplingStartAfter(createdAt);
      await mineUntilNextBlockIs(boundary1 + 1);
      await stamperStamp.increaseDepth(batchId, depth + 1);
      const depth1Block = await getBlockNumber();

      // Intermediate dilution, before the next boundary: not retained.
      await stamperStamp.increaseDepth(batchId, depth + 2);

      // Cross the next boundary, which fixes depth + 2 for the following round, then dilute
      // again. Now the round sampled at boundary1 needs `depth` and the round sampled at
      // boundary2 needs `depth + 2`, simultaneously.
      const boundary2 = firstSamplingStartAfter(depth1Block);
      await mineUntilNextBlockIs(boundary2 + 1);
      await stamperStamp.increaseDepth(batchId, depth + 3);

      const history = await admin.batchDepthHistory(batchId);
      expect(history.olderDepth).to.equal(depth);
      expect(history.previousDepth).to.equal(depth + 2);

      expect((await admin.redistributionBatchAt(batchId, boundary1)).depthAtSamplingStart).to.equal(depth);
      expect((await admin.redistributionBatchAt(batchId, boundary2)).depthAtSamplingStart).to.equal(depth + 2);
    });

    // The comparison in _recordDepthBeforeIncrease is `<` and not `<=`. A dilution included in
    // the sampling-start block itself is too late for that round, so the depth it replaces is
    // the one that round must be verified against and has to be retained.
    it('retains the old depth when the dilution lands exactly in the sampling-start block', async function () {
      const batchId = await createBatch(nonceA, roomyBlocks);
      const createdAt = await getBlockNumber();

      const boundary = firstSamplingStartAfter(createdAt);
      await mineUntilNextBlockIs(boundary);
      await stamperStamp.increaseDepth(batchId, depth + 1);
      expect(await getBlockNumber()).to.equal(boundary);

      const history = await admin.batchDepthHistory(batchId);
      expect(history.previousDepth).to.equal(depth);

      await mineNBlocks(1);
      expect((await admin.redistributionBatchAt(batchId, boundary)).depthAtSamplingStart).to.equal(depth);
    });

    it('does not retain a depth when the dilution precedes any sampling boundary', async function () {
      // Land the creation just after a boundary so there is room to dilute before the next one.
      const now = await getBlockNumber();
      const boundary = firstSamplingStartAfter(now);
      await mineUntilNextBlockIs(boundary + 1);

      const batchId = await createBatch(nonceA, roomyBlocks);
      await stamperStamp.increaseDepth(batchId, depth + 1);

      const history = await admin.batchDepthHistory(batchId);
      expect(history.previousDepth).to.equal(0);
      expect(history.olderDepth).to.equal(0);
    });

    it('drops the history when the batch expires', async function () {
      const batchId = await createBatch(nonceA, MIN_VALIDITY_BLOCKS * 4);
      const createdAt = await getBlockNumber();

      const boundary = firstSamplingStartAfter(createdAt);
      await mineUntilNextBlockIs(boundary + 1);
      await stamperStamp.increaseDepth(batchId, depth + 1);
      expect((await admin.batchDepthHistory(batchId)).previousDepth).to.equal(depth);

      await mineNBlocks(MIN_VALIDITY_BLOCKS * 4);
      await admin.expireLimited(0xffff);

      const history = await admin.batchDepthHistory(batchId);
      expect(history.previousDepth).to.equal(0);
      expect(history.previousDepthBlock).to.equal(0);
    });
  });

  describe('batch id consumption', function () {
    it('never releases a batch id, not even after expiry', async function () {
      const batchId = await createBatch(nonceA, MIN_VALIDITY_BLOCKS);
      expect(await admin.batchIdUsed(batchId)).to.be.true;

      await mineNBlocks(MIN_VALIDITY_BLOCKS + 5);
      await admin.expireLimited(0xffff);
      expect(await admin.batchOwner(batchId)).to.equal(ethers.constants.AddressZero);

      const perChunk = price * MIN_VALIDITY_BLOCKS;
      const transfer = perChunk * 2 ** depth;
      await mintAndApprove(deployer, stamper, stamperStamp.address, transfer.toString());
      await expect(stamperStamp.createBatch(stamper, perChunk, depth, bucketDepth, nonceA, false)).to.be.revertedWith(
        'BatchIdAlreadyUsed'
      );
    });

    it('reports a distinct reason when an import reuses an id', async function () {
      const importedId = '0x00000000000000000000000000000000000000000000000000000000deadbeef';
      const perChunk = price * MIN_VALIDITY_BLOCKS;
      await admin.copyBatch(stamper, perChunk, depth, bucketDepth, importedId, false);

      await expect(admin.copyBatch(stamper, perChunk, depth, bucketDepth, importedId, false)).to.be.revertedWith(
        'BatchIdAlreadyUsed'
      );
    });

    it('holds imports to the same creation minimum as ordinary batches', async function () {
      const importedId = '0x00000000000000000000000000000000000000000000000000000000deadbee0';
      const perChunk = price * (MIN_VALIDITY_BLOCKS - 1);
      await expect(admin.copyBatch(stamper, perChunk, depth, bucketDepth, importedId, false)).to.be.revertedWith(
        'InsufficientBalance()'
      );
    });
  });

  describe('operation balance rules', function () {
    it('rejects a top-up once the batch has fallen below the minimum', async function () {
      const batchId = await createBatch(nonceA, MIN_VALIDITY_BLOCKS + 20);

      // Still above the floor: a top-up is allowed.
      const topUp = price * 100;
      await mintAndApprove(deployer, stamper, stamperStamp.address, (topUp * 2 ** depth).toString());
      await stamperStamp.topUp(batchId, topUp);

      // Drop it under the floor. SWIP-049 makes this permanent: the batch can no longer be
      // rescued at any size, and will expire. See docs/SWIP-49-50-SCRUTINY.md 1.2.
      await mineNBlocks(200);
      const huge = price * MIN_VALIDITY_BLOCKS * 10;
      await mintAndApprove(deployer, stamper, stamperStamp.address, (huge * 2 ** depth).toString());
      await expect(stamperStamp.topUp(batchId, huge)).to.be.revertedWith('InsufficientBalance()');
    });

    it('rejects a dilution that would leave less than the minimum', async function () {
      // Exactly two minimums, so a single depth step lands on the floor and two fall through.
      const batchId = await createBatch(nonceB, MIN_VALIDITY_BLOCKS * 2);
      await expect(stamperStamp.increaseDepth(batchId, depth + 2)).to.be.revertedWith('InsufficientBalance()');
    });
  });

  describe('round arithmetic', function () {
    it('places sampling start at the first reveal block of the preceding round', async function () {
      expect(samplingStartBlock(1)).to.equal(REVEAL_OFFSET);
      expect(samplingStartBlock(2)).to.equal(ROUND_LENGTH + REVEAL_OFFSET);

      // The sampling-to-claim window is 266 blocks inclusive, which is what the 456 block
      // usability threshold is sized against.
      const target = 10;
      const lastClaimBlock = target * ROUND_LENGTH + ROUND_LENGTH - 1;
      expect(lastClaimBlock - samplingStartBlock(target) + 1).to.equal(266);
    });
  });
});
