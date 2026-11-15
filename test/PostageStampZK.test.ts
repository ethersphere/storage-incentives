import { expect } from './util/chai';
import { ethers, network } from 'hardhat';
import { BigNumber, Contract, Signer } from 'ethers';

// PostageStampZK: PostageStamp without the batch tree and without the expiry loop. The pot is computed
// on chain from sums for each bucket of the balance scale (docs/SNARK-SETTLEMENT.md, section 6).
//
// The last tests compare the pot with master's PostageStamp. They run random batch histories on both
// contracts, in the same blocks. The pot of PostageStampZK is never more than master's pot, it is behind
// by less than one bucket for each live chunk, and it is equal when all batches are expired.

const { keccak256, solidityPack, defaultAbiCoder } = ethers.utils;
const ZERO = ethers.constants.HashZero;

async function mine(n: number) {
  if (n > 0) await network.provider.send('hardhat_mine', ['0x' + n.toString(16)]);
}

describe('PostageStampZK', function () {
  let deployer: Signer, other: Signer;
  let token: Contract, stamp: Contract;

  beforeEach(async function () {
    [deployer, , other] = await ethers.getSigners();
    token = await (await ethers.getContractFactory('TestToken')).deploy('sBZZ', 'sBZZ', '1' + '0'.repeat(30));
    stamp = await (await ethers.getContractFactory('PostageStampZK')).deploy(token.address, 16);
    await stamp.grantRole(await stamp.PRICE_ORACLE_ROLE(), await deployer.getAddress());
    await token.approve(stamp.address, ethers.constants.MaxUint256);
    await stamp.setPrice(100);
  });

  async function create(nonce: string, perChunk: BigNumber | number, depth = 18) {
    await stamp.createBatch(await deployer.getAddress(), perChunk, depth, 16, nonce, false);
    return keccak256(defaultAbiCoder.encode(['address', 'bytes32'], [await deployer.getAddress(), nonce]));
  }

  it('fixes the pot of a game round at its seed block (the cut)', async function () {
    await stamp.setPrice(24000);
    const perChunk = (await stamp.minimumInitialBalancePerChunk()).mul(4);
    const id = await create(ZERO, perChunk, 18);
    const created = (await stamp.batches(id)).normalisedBalance.sub(perChunk); // outpayment at the purchase
    const size = BigNumber.from(1).shl(18);

    // Go past the seed block of the next round (round * 64 + 48) and account in the round after it.
    const now = await ethers.provider.getBlockNumber();
    const round = Math.floor(now / 64) + 1;
    const seedBlock = round * 64 + 48;
    await mine(seedBlock + 20 - now);
    await stamp.checkpoint();

    // The batch paid for each unit of outpayment from its purchase to the seed block.
    const outpaymentAt = async (block: number) =>
      (await stamp.currentTotalOutPayment()).sub(BigNumber.from(24000).mul((await ethers.provider.getBlockNumber()) - block));
    const expected = size.mul((await outpaymentAt(seedBlock)).sub(created));
    expect(await stamp.callStatic.potAt(round)).to.eq(expected);

    // Later transactions and later rounds do not change it.
    await mine(200);
    await stamp.topUp(id, perChunk);
    expect(await stamp.callStatic.potAt(round)).to.eq(expected);
    expect((await stamp.callStatic.potAt(round + 2)).gt(expected)).to.eq(true);
    // The round whose seed block is not over has no cut yet.
    const current = Math.floor((await ethers.provider.getBlockNumber()) / 64);
    await expect(stamp.callStatic.potAt(current + 1)).to.be.revertedWith('CutNotFound()');
  });

  it('keeps the events Bee follows', async function () {
    const perChunk = (await stamp.minimumInitialBalancePerChunk()).mul(2);
    await expect(stamp.createBatch(await deployer.getAddress(), perChunk, 18, 16, ZERO, false)).to.emit(
      stamp,
      'BatchCreated'
    );
    const id = keccak256(defaultAbiCoder.encode(['address', 'bytes32'], [await deployer.getAddress(), ZERO]));
    await expect(stamp.topUp(id, perChunk)).to.emit(stamp, 'BatchTopUp');
    await expect(stamp.increaseDepth(id, 19)).to.emit(stamp, 'BatchDepthIncrease');
    await expect(stamp.setPrice(1)).to.emit(stamp, 'PriceUpdate');
  });

  it('expires by comparison, without removing anything', async function () {
    // A balance must be in a later bucket than the current one: 3 buckets here (price 100).
    const balance = (await stamp.BUCKET()).mul(3);
    const id = await create(ZERO, balance);
    expect(await stamp.isBatchAlive(id)).to.be.true;
    await mine(balance.div(100).toNumber() + 10);
    expect(await stamp.isBatchAlive(id)).to.be.false;
    expect(await stamp.remainingBalance(id)).to.eq(0);
    expect((await stamp.batches(id)).owner).to.eq(await deployer.getAddress());
    await expect(stamp.topUp(id, 1000)).to.be.revertedWith('BatchExpired()');
    await expect(stamp.increaseDepth(id, 19)).to.be.revertedWith('BatchExpired()');
    // The id stays taken.
    await expect(stamp.createBatch(await deployer.getAddress(), 1000, 18, 16, ZERO, false)).to.be.revertedWith(
      'BatchExists()'
    );
  });

  it('keeps the expiry calls of current Bee versions as no-ops', async function () {
    expect(await stamp.expiredBatchesExist()).to.be.false;
    await stamp.expireLimited(25);
  });

  it('pays out only to the redistributor role, the amount asked', async function () {
    const perChunk = (await stamp.minimumInitialBalancePerChunk()).mul(2);
    await create(ZERO, perChunk);
    const to = await other.getAddress();
    await expect(stamp.connect(other).withdraw(to, 1)).to.be.revertedWith('OnlyRedistributor()');
    await stamp.grantRole(await stamp.REDISTRIBUTOR_ROLE(), await deployer.getAddress());
    await stamp.withdraw(to, 12345);
    expect(await token.balanceOf(to)).to.eq(12345);
  });

  it('copies batches in bulk (migration), only for the admin, and logs each copy', async function () {
    // Regression: copyBatchBulk calls copyBatch through `this`, and copyBatch rejected the contract itself
    // as not the admin, so every batch failed (CopyBatchFailed). Master's PostageStamp has the same code.
    const id = (i: number) => ethers.utils.keccak256(ethers.utils.toUtf8Bytes(`copy-${i}`));
    const owner = await other.getAddress();
    const balance = (await stamp.minimumInitialBalancePerChunk()).mul(3);
    const list = [0, 1, 2].map((i) => ({
      batchId: id(i),
      owner,
      depth: 20,
      bucketDepth: 16,
      immutableFlag: i === 1,
      remainingBalance: balance,
    }));
    list.push({ ...list[0] }); // a copy that exists already fails alone
    await expect(stamp.connect(other).copyBatchBulk(list)).to.be.revertedWith('AdministratorOnly()');
    const before = await stamp.liveSize();
    const rc = await (await stamp.copyBatchBulk(list)).wait();
    const failed = rc.logs.filter(
      (l: { topics: string[] }) => l.topics[0] === stamp.interface.getEventTopic('CopyBatchFailed')
    );
    expect(failed.length).to.eq(1);
    for (const i of [0, 1, 2]) {
      const b = await stamp.batches(id(i));
      expect(b.owner).to.eq(owner);
      expect(b.immutableFlag).to.eq(i === 1);
    }
    // Each copy is in the pot accounting.
    expect(await stamp.liveSize()).to.eq(before.add(BigNumber.from(1).shl(20).mul(3)));
    // A direct copyBatch call still needs the admin.
    await expect(stamp.connect(other).copyBatch(owner, balance, 20, 16, id(9), false)).to.be.revertedWith(
      'AdministratorOnly()'
    );
  });

  it('buys a batch for less gas than PostageStamp', async function () {
    const master = await (await ethers.getContractFactory('PostageStamp')).deploy(token.address, 16);
    await master.grantRole(await master.PRICE_ORACLE_ROLE(), await deployer.getAddress());
    await token.approve(master.address, ethers.constants.MaxUint256);
    await master.setPrice(100);
    const perChunk = (await stamp.minimumInitialBalancePerChunk()).mul(2);
    // Fill both with 50 batches so the tree is not empty.
    for (let i = 0; i < 50; i++) {
      const nonce = keccak256(solidityPack(['uint256'], [i]));
      await stamp.createBatch(await deployer.getAddress(), perChunk.add(i), 18, 16, nonce, false);
      await master.createBatch(await deployer.getAddress(), perChunk.add(i), 18, 16, nonce, false);
    }
    const nonce = keccak256('0x99');
    const zk = await (await stamp.createBatch(await deployer.getAddress(), perChunk, 18, 16, nonce, false)).wait();
    const ms = await (await master.createBatch(await deployer.getAddress(), perChunk, 18, 16, nonce, false)).wait();
    console.log(`      createBatch gas with 50 batches: PostageStamp ${ms.gasUsed}, PostageStampZK ${zk.gasUsed}`);
    expect(zk.gasUsed.lt(ms.gasUsed)).to.be.true;
  });

  describe('accounting matches PostageStamp', function () {
    // Deterministic PRNG so a history can be replayed.
    function rng(seed: number) {
      let x = seed >>> 0 || 1;
      return (n: number) => {
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        return (x >>> 0) % n;
      };
    }

    for (const seed of [1, 2, 3]) {
      it(`random history ${seed}`, async function () {
        const master = await (await ethers.getContractFactory('PostageStamp')).deploy(token.address, 16);
        const zk = await (await ethers.getContractFactory('PostageStampZK')).deploy(token.address, 16);
        const me = await deployer.getAddress();
        const BUCKET = await zk.BUCKET();
        for (const c of [master, zk]) {
          await c.grantRole(await c.PRICE_ORACLE_ROLE(), me);
          // The minimum balance (100 blocks of the price) is more than one bucket.
          await c.setMinimumValidityBlocks(100);
          await token.approve(c.address, ethers.constants.MaxUint256);
        }

        // Every operation goes to both contracts in the same block.
        const both = async (fn: (c: Contract) => Promise<unknown>) => {
          await network.provider.send('evm_setAutomine', [false]);
          await fn(master);
          await fn(zk);
          await network.provider.send('evm_mine', []);
          await network.provider.send('evm_setAutomine', [true]);
        };
        const opts = { gasLimit: 5_000_000 };
        // Master: sweep everything, then its pot covers all payments up to this block.
        const pots = async () => {
          await network.provider.send('evm_setAutomine', [false]);
          await master.expireLimited(ethers.constants.MaxUint256, opts);
          await zk.checkpoint(opts);
          await network.provider.send('evm_mine', []);
          await network.provider.send('evm_setAutomine', [true]);
          return { master: await master.pot(), zk: await zk.cumulativePot(), live: await master.validChunkCount() };
        };

        const r = rng(seed * 7919);
        const ids: { id: string; depth: number }[] = [];
        const newPrice = () => 22000 + r(20000);
        let price = newPrice();
        await both((c) => c.setPrice(price, opts));
        let checks = 0;
        let maxLag = BigNumber.from(0);

        for (let step = 0; step < 80; step++) {
          const op = r(10);
          if (op < 4 || ids.length === 0) {
            const nonce = keccak256(solidityPack(['uint256', 'uint256'], [seed, step]));
            const depth = 17 + r(3);
            const perChunk = price * (100 + r(1500));
            await both((c) => c.createBatch(me, perChunk, depth, 16, nonce, false, opts));
            ids.push({ id: keccak256(defaultAbiCoder.encode(['address', 'bytes32'], [me, nonce])), depth });
          } else if (op < 6) {
            const b = ids[r(ids.length)];
            if ((await zk.remainingBalance(b.id)).gt(0)) {
              const amount = price * (100 + r(1000));
              await both((c) => c.topUp(b.id, amount, opts));
            }
          } else if (op < 7) {
            const b = ids[r(ids.length)];
            const rem = await zk.remainingBalance(b.id);
            if (b.depth < 22 && rem.gt(price * 100 * 2 + 1)) {
              await both((c) => c.increaseDepth(b.id, b.depth + 1, opts));
              b.depth += 1;
            }
          } else if (op < 8) {
            price = newPrice();
            await both((c) => c.setPrice(price, opts));
          } else {
            await mine(1 + r(400));
          }

          if (step % 8 === 7) {
            const p = await pots();
            // Never more than master, and behind by less than one bucket for each chunk that is alive
            // or expired in the current bucket.
            expect(p.zk.lte(p.master), `step ${step}: zk ${p.zk} > master ${p.master}`).to.eq(true);
            const lag = p.master.sub(p.zk);
            const bound = BUCKET.mul(BigNumber.from(1).shl(23)); // more than all chunks of the test
            expect(lag.lte(bound), `step ${step}: lag ${lag}`).to.eq(true);
            if (lag.gt(maxLag)) maxLag = lag;
            checks++;
          }
        }
        expect(checks).to.eq(10);

        // All batches expire. Then both contracts have the same pot, exactly.
        await mine(4000);
        const end = await pots();
        expect(end.live).to.eq(0);
        expect(end.zk).to.eq(end.master);
        expect(await zk.liveSize()).to.eq(0);
        expect(maxLag.gt(0)).to.eq(true);
      });
    }
  });
});
