import { expect } from './util/chai';
import { ethers, deployments, getNamedAccounts, getUnnamedAccounts } from 'hardhat';
import { Event, Contract } from 'ethers';
import { mineNBlocks, getBlockNumber, encodeAndHash, mintAndApprove, createOverlay} from './util/tools'

import { keccak256 } from '@ethersproject/keccak256';
import { arrayify, hexlify } from '@ethersproject/bytes';

const phaseLength = 38;
const roundLength = 152;

const round2Anchor = '0xa6eef7e35abe7026729641147f7915573c7e97b47efa546f5f6e3230263bcb49';
const round3AnchoIfNoReveals = '0xac33ff75c19e70fe83507db0d683fd3465c996598dc972688b7ace676c89077b';

// Named accounts used by tests.
let deployer: string, stamper: string, oracle: string;
let others: any;

// Before the tests, assign accounts
before(async function () {
  const namedAccounts = await getNamedAccounts();
  deployer = namedAccounts.deployer;
  stamper = namedAccounts.stamper;
  oracle = namedAccounts.oracle;
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

  const token = await ethers.getContract('TestToken', deployer);

  const postageStampOracle = await ethers.getContract('PostageStamp', oracle);
  await postageStampOracle.setPrice(price1);

  const batchSize = 2 ** batch.depth;
  const transferAmount = 2 * batch.initialPaymentPerChunk * batchSize;
  const expectedNormalisedBalance = batch.initialPaymentPerChunk;

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

  const stampCreatedBlock = await getBlockNumber();

  const depth = '0x00';
  const hash = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';
  const nonce = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';
  const reveal_nonce = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';

  for (let i = 0; i < nodes.length; i++) {
    const r_node = await ethers.getContract('Redistribution', nodes[i]);
    const overlay = await createOverlay(nodes[i], '0x00', nonce);
    const sr_node = await ethers.getContract('StakeRegistry', nodes[i]);
    await mintAndApprove(deployer, nodes[i], sr_node.address, stakes[i]);
    await sr_node.depositStake(nodes[i], nonce, stakes[i]);
  }

  const winDist: any[][] = [];
  for (let i = 0; i < nodes.length; i++) {
    winDist.push([nodes[i], stakes[i], 0]);
  }

  await mineNBlocks(roundLength * 3 - 15 - nodes.length * 3);
  for (let i = 0; i < trials; i++) {
    const startRoundBlockNumber = await getBlockNumber();

    const r_nodex = await ethers.getContract('Redistribution', nodes[0]);

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
      const overlay = await createOverlay(winDist[i][0], '0x00', nonce);
      if (await r_node.isWinner(overlay)) {
        winDist[i][2]++;
      }
    }

    const tx2 = await r_node.claim();
    const receipt2 = await tx2.wait();

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

describe('Stats', function () {
  describe('two player game', async function () {
    const trials = 200;

    it('is fair with 1:3 stake', async function () {
      const allowed_variance = 0.025;
      const stakes = ['100000000000000000', '300000000000000000'];
      const nodes = [others[0], others[1]];

      const dist = await nPlayerGames(nodes, stakes, trials);
      let sumStakes = BigInt(0);
      for (let i = 0; i < stakes.length; i++) {
        sumStakes += BigInt(stakes[i]);
      }

      for (let i = 0; i < dist.length; i++) {
        const actual =
          parseInt((BigInt(dist[i][1]) / BigInt(100000000000000000)).toString()) /
          parseInt((sumStakes / BigInt(100000000000000000)).toString());
        const probable = dist[i][2] / trials;
        expect(Math.abs(actual - probable)).be.lessThan(allowed_variance);
      }
    }).timeout(100000);
  });
});
