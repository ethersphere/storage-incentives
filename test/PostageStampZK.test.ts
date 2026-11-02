import { expect } from './util/chai';
import { ethers, network } from 'hardhat';
import { BigNumber, Contract, Signer } from 'ethers';
import fs from 'fs';
import path from 'path';

// PostageStampZK: PostageStamp without the batch tree. Expiry and the pot are computed in the settlement
// proof from its event log (prover/crates/vm/src/postage.rs).
//
// The last test compares the accounting with master's PostageStamp. It runs random batch histories on both
// contracts, in the same blocks, and with DUMP_POSTAGE_VECTORS=1 it writes the ZK log and master's pot at
// each checkpoint to prover/crates/vm/tests/vectors/postage-*.json. prover/crates/vm/tests/postage_vectors.rs
// replays the log and must reach the same pot and validChunkCount.

const { keccak256, solidityPack, defaultAbiCoder } = ethers.utils;
const ZERO = ethers.constants.HashZero;
const KIND_CREATE = 1;
const KIND_TOPUP = 2;
const KIND_DEPTH = 3;
const KIND_PRICE = 4;

async function mine(n: number) {
  if (n > 0) await network.provider.send('hardhat_mine', ['0x' + n.toString(16)]);
}

function logHash(prev: string, e: any): string {
  return keccak256(
    solidityPack(
      ['bytes32', 'uint8', 'bytes32', 'address', 'uint8', 'uint8', 'uint256', 'uint256', 'uint64'],
      [prev, e.kind, e.batchId, e.owner, e.depth, e.bucketDepth, e.value, e.outpayment, e.blockNumber]
    )
  );
}

async function logs(stamp: Contract) {
  const evs = await stamp.queryFilter(stamp.filters.PostageLog());
  return evs.map((e) => ({
    index: e.args!.index.toNumber(),
    kind: e.args!.kind,
    batchId: e.args!.batchId,
    owner: e.args!.owner,
    depth: e.args!.depth,
    bucketDepth: e.args!.bucketDepth,
    value: e.args!.value.toString(),
    outpayment: e.args!.outpayment.toString(),
    blockNumber: e.args!.blockNumber.toNumber(),
  }));
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

  it('logs every change as a hash chain that matches the documented rule', async function () {
    const perChunk = (await stamp.minimumInitialBalancePerChunk()).mul(2);
    const id = await create(ZERO, perChunk);
    await stamp.topUp(id, perChunk);
    await stamp.increaseDepth(id, 19);
    await stamp.setPrice(200);

    const entries = await logs(stamp);
    expect(entries.map((e) => e.kind)).to.deep.eq([KIND_PRICE, KIND_CREATE, KIND_TOPUP, KIND_DEPTH, KIND_PRICE]);
    let h = ZERO;
    for (const e of entries) {
      h = logHash(h, e);
      expect(await stamp.eventHashAt(e.index)).to.eq(h);
      expect(await stamp.eventBlockAt(e.index)).to.eq(e.blockNumber);
    }
    expect(await stamp.eventCount()).to.eq(5);
    expect(await stamp.eventHashAt(0)).to.eq(ZERO);
    await expect(stamp.eventHashAt(6)).to.be.revertedWith('EventOutOfRange()');
    // The batch fields are the stored batch.
    const b = await stamp.batches(id);
    expect(entries[3].value).to.eq(b.normalisedBalance.toString());
    expect(entries[3].depth).to.eq(19);
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
    await stamp.setMinimumValidityBlocks(1);
    const id = await create(ZERO, 1000); // price 100: 10 blocks
    expect(await stamp.isBatchAlive(id)).to.be.true;
    await mine(20);
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
        for (const c of [master, zk]) {
          await c.grantRole(await c.PRICE_ORACLE_ROLE(), me);
          await c.setMinimumValidityBlocks(5);
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
        const opts = { gasLimit: 3_000_000 };

        const r = rng(seed * 7919);
        const ids: { id: string; depth: number }[] = [];
        let price = 10 + r(50);
        await both((c) => c.setPrice(price, opts));
        const checkpoints: { block: number; pot: string; validChunkCount: string }[] = [];

        for (let step = 0; step < 60; step++) {
          const op = r(10);
          if (op < 4 || ids.length === 0) {
            const nonce = keccak256(solidityPack(['uint256', 'uint256'], [seed, step]));
            const depth = 17 + r(3);
            const perChunk = price * (5 + r(200));
            await both((c) => c.createBatch(me, perChunk, depth, 16, nonce, false, opts));
            ids.push({ id: keccak256(defaultAbiCoder.encode(['address', 'bytes32'], [me, nonce])), depth });
          } else if (op < 6) {
            const b = ids[r(ids.length)];
            if ((await zk.remainingBalance(b.id)).gt(0)) {
              const amount = price * (5 + r(100));
              await both((c) => c.topUp(b.id, amount, opts));
            }
          } else if (op < 7) {
            const b = ids[r(ids.length)];
            const rem = await zk.remainingBalance(b.id);
            if (b.depth < 22 && rem.gt(price * 5 * 2 + 1)) {
              await both((c) => c.increaseDepth(b.id, b.depth + 1, opts));
              b.depth += 1;
            }
          } else if (op < 8) {
            price = 10 + r(50);
            await both((c) => c.setPrice(price, opts));
          } else {
            await mine(1 + r(150));
          }

          if (step % 10 === 9) {
            // Master: sweep everything, then its pot covers all payments up to this block.
            const rc = await (await master.expireLimited(ethers.constants.MaxUint256, opts)).wait();
            checkpoints.push({
              block: rc.blockNumber,
              pot: (await master.pot()).toString(),
              validChunkCount: (await master.validChunkCount()).toString(),
            });
          }
        }

        const entries = await logs(zk);
        expect(entries.length).to.be.greaterThan(10);
        expect(checkpoints.length).to.eq(6);

        if (process.env.DUMP_POSTAGE_VECTORS) {
          const dir = path.join(__dirname, '..', 'prover', 'crates', 'vm', 'tests', 'vectors');
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(
            path.join(dir, `postage-${seed}.json`),
            JSON.stringify({ source: 'test/PostageStampZK.test.ts', seed, events: entries, checkpoints }, null, 2)
          );
        }
      });
    }
  });
});
