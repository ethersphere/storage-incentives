import { expect } from './util/chai';
import { ethers, getNamedAccounts, getUnnamedAccounts, deployments } from 'hardhat';
import { mineNBlocks, encodeAndHash, mintAndApprove, createOverlay } from './util/tools';

const { read, execute } = deployments;
const phaseLength = 38;
const roundLength = 152;

// Named accounts used by tests.
let deployer: string, stamper: string, oracle: string, pauser: string;
let others: string[];

// Before the tests, assign accounts
before(async function () {
  const namedAccounts = await getNamedAccounts();
  deployer = namedAccounts.deployer;
  stamper = namedAccounts.stamper;
  oracle = namedAccounts.oracle;
  pauser = namedAccounts.pauser;
  others = await getUnnamedAccounts();
});

async function nPlayerGames(nodes: string[], stakes: string[], trials: number) {
  const price1 = 100;
  const batch = {
    nonce: '0x000000000000000000000000000000000000000000000000000000000000abcd',
    initialPaymentPerChunk: 200000,
    depth: 17,
    bucketDepth: 16,
    immutable: false,
  };

  const postageStampOracle = await ethers.getContract('PostageStamp', oracle);
  await postageStampOracle.setPrice(price1);

  const postageStampAdmin = await ethers.getContract('PostageStamp', deployer);
  await postageStampAdmin.setMinimumValidityBlocks(0);

  const batchSize = 2 ** batch.depth;
  const transferAmount = 2 * batch.initialPaymentPerChunk * batchSize;

  const postage = await ethers.getContract('PostageStamp', stamper);

  await mintAndApprove(deployer, stamper, postage.address, transferAmount.toString());

  await postage.createBatch(
    stamper,
    batch.initialPaymentPerChunk,
    batch.depth,
    batch.bucketDepth,
    batch.nonce,
    batch.immutable
  );

  const depth = '0x00';
  const hash = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';
  const nonce = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';
  const reveal_nonce = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';

  for (let i = 0; i < nodes.length; i++) {
    const sr_node = await ethers.getContract('StakeRegistry', nodes[i]);
    await mintAndApprove(deployer, nodes[i], sr_node.address, stakes[i]);
    await sr_node.depositStake(nodes[i], nonce, stakes[i]);
  }

  interface Outcome {
    node: string;
    stake: string;
    wins: number;
  }

  const winDist: Outcome[] = [];
  for (let i = 0; i < nodes.length; i++) {
    winDist.push({ node: nodes[i], stake: stakes[i], wins: 0 });
  }

  await mineNBlocks(roundLength * 3 - 15 - nodes.length * 3);
  for (let i = 0; i < trials; i++) {
    for (let i = 0; i < nodes.length; i++) {
      const r_node = await ethers.getContract('Redistribution', nodes[i]);
      const overlay = await createOverlay(nodes[i], '0x00', nonce);
      const obsfucatedHash = encodeAndHash(overlay, depth, hash, reveal_nonce);
      const currentRound = await r_node.currentRound();
      await r_node.commit(obsfucatedHash, overlay, currentRound);
    }

    await mineNBlocks(phaseLength - nodes.length);

    for (let i = 0; i < nodes.length; i++) {
      const r_node = await ethers.getContract('Redistribution', nodes[i]);
      const overlay = await createOverlay(nodes[i], '0x00', nonce);
      await r_node.reveal(overlay, depth, hash, reveal_nonce);
    }

    await mineNBlocks(phaseLength - nodes.length + 1);

    const r_node = await ethers.getContract('Redistribution', nodes[0]);

    for (let i = 0; i < winDist.length; i++) {
      const overlay = await createOverlay(winDist[i].node, '0x00', nonce);
      if (await r_node.isWinner(overlay)) {
        winDist[i].wins++;
      }
    }

    await r_node.claim();

    const sr = await ethers.getContract('StakeRegistry');

    //stakes are preserved
    for (let i = 0; i < nodes.length; i++) {
      const overlay = await createOverlay(nodes[i], '0x00', nonce);
      expect(await sr.usableStakeOfOverlay(overlay)).to.be.eq(stakes[i]);
    }

    await mineNBlocks(phaseLength * 2 - nodes.length);
  }

  return winDist;
}

describe('Stats', async function () {
  beforeEach(async function () {
    await deployments.fixture();
    const priceOracleRole = await read('PostageStamp', 'PRICE_ORACLE_ROLE');
    await execute('PostageStamp', { from: deployer }, 'grantRole', priceOracleRole, oracle);

    const pauserRole = await read('StakeRegistry', 'PAUSER_ROLE');
    await execute('StakeRegistry', { from: deployer }, 'grantRole', pauserRole, pauser);
  });
  describe('two player game', async function () {
    const trials = 150;

    it('is fair with 1:3 stake', async function () {
      this.timeout(0);
      const allowed_variance = 0.035;
      const stakes = ['100000000000000000', '300000000000000000'];
      const nodes = [others[0], others[1]];

      const dist = await nPlayerGames(nodes, stakes, trials);
      let sumStakes = BigInt(0);
      for (let i = 0; i < stakes.length; i++) {
        sumStakes += BigInt(stakes[i]);
      }

      for (let i = 0; i < dist.length; i++) {
        const actual =
          parseInt((BigInt(dist[i].stake) / BigInt(100000000000000000)).toString()) /
          parseInt((sumStakes / BigInt(100000000000000000)).toString());
        const probable = dist[i].wins / trials;
        await expect(Math.abs(actual - probable)).be.lessThan(allowed_variance);
      }
    });
  });
});
