//<sig should seperate into unit/integration style tests? sig>
//<sig how many iterations/slashes etc. before the claim method uses too much gas for each blockchain? sig>
//<sig is it higher than 32 reveal/truth sig>
//<sig gas analysis sig>
//<sig review events emitted from claim in light of the above

import { expect } from './util/chai';
import { ethers, deployments, getNamedAccounts, getUnnamedAccounts } from 'hardhat';
import { Event, Contract } from 'ethers';

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

//todo DRY this
async function mineNBlocks(n: number) {
  for (let index = 0; index < n; index++) {
    await ethers.provider.send('hardhat_mine', []);
  }
}

async function setPrevRandDAO() {
  await ethers.provider.send('hardhat_setPrevRandao', [
    '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33',
  ]);
}

async function getBlockNumber() {
  const blockNumber = await ethers.provider.send('eth_blockNumber', []);
  return parseInt(blockNumber);
}

//todo DRY this
async function mintAndApprove(payee: string, beneficiary: string, transferAmount: string) {
  const minterTokenInstance = await ethers.getContract('TestToken', deployer);
  await minterTokenInstance.mint(payee, transferAmount);
  const payeeTokenInstance = await ethers.getContract('TestToken', payee);
  await payeeTokenInstance.approve(beneficiary, transferAmount);
}

function encodeAndHash(overlay_1: string, depth_1: string, hash_1: string, reveal_nonce_1: string) {
  const encoded = new Uint8Array(97);
  encoded.set(arrayify(overlay_1));
  encoded.set(arrayify(depth_1), 32);
  encoded.set(arrayify(hash_1), 33);
  encoded.set(arrayify(reveal_nonce_1), 65);
  return keccak256(hexlify(encoded));
}

async function createOverlay(address: string, networkID: string, nonce: string) {
  const encoded = new Uint8Array(60);
  encoded.set(arrayify(address));
  encoded.set(arrayify(networkID).reverse(), 20);
  encoded.set(arrayify(nonce), 28);
  return keccak256(hexlify(encoded));
}

// the game should only select one winner if there are 5 players with equal stakes
// statistical test where 2 nodes one with 2/3 of the stake and see if there is a meaningful difference in their probability
// both are evenly selected if 1/2 (do this in a separate test file)
// other stats tests?

async function nPlayerGames(
  nodes: string[],
  stakes: string[],
  trials: number
) {
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

  await mintAndApprove(stamper, postage.address, transferAmount.toString());

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

  for(let i=0; i < nodes.length; i++){
    const r_node = await ethers.getContract('Redistribution', nodes[i]);
    const overlay = await createOverlay(nodes[i], '0x00', nonce);
    const sr_node = await ethers.getContract('StakeRegistry', nodes[i]);
    await mintAndApprove(nodes[i], sr_node.address, stakes[i]);
    await sr_node.depositStake(nodes[i], nonce, stakes[i]);
  }

  let winDist: any;
  winDist = {};
  for(let i=0; i < nodes.length; i++){
    winDist[nodes[i]] = [stakes[i], 0];
  }

  await mineNBlocks(roundLength * 3 - 15 - (nodes.length*3));
  for (let i = 0; i < trials; i++) {
    const startRoundBlockNumber = await getBlockNumber();

    const r_nodex = await ethers.getContract('Redistribution', nodes[0]);

    for(let i=0; i < nodes.length; i++){
      const r_node = await ethers.getContract('Redistribution', nodes[i]);
      const overlay = await createOverlay(nodes[i], '0x00', nonce);
      const obsfucatedHash = encodeAndHash(overlay, depth, hash, reveal_nonce);
      await r_node.commit(obsfucatedHash, overlay);
    }

    await mineNBlocks(phaseLength - nodes.length);

    for(let i=0; i < nodes.length; i++){
      const r_node = await ethers.getContract('Redistribution', nodes[i]);
      const overlay = await createOverlay(nodes[i], '0x00', nonce);
      await r_node.reveal(overlay, depth, hash, reveal_nonce);
    }

    await mineNBlocks(phaseLength - nodes.length + 1);

    const r_node = await ethers.getContract('Redistribution', nodes[0]);

    for(let i=0; i < nodes.length; i++){
      const overlay = await createOverlay(nodes[i], '0x00', nonce);
      if (await r_node.isWinner(overlay)) {
        winDist[nodes[i]][1]++;
      }
    }

    const tx2 = await r_node.claim();
    const receipt2 = await tx2.wait();

    const sr = await ethers.getContract('StakeRegistry');

    //stakes are preserved
    for(let i=0; i < nodes.length; i++){
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
      const allowed_variance = 0.02;
      const stakes = ['100000000000000000', '300000000000000000'];
      const nodes = [others[0], others[1]];

      const dist = await nPlayerGames(nodes, stakes, trials);
      let sumStakes = BigInt(0);
      for(let i=0;i<stakes.length;i++){
        sumStakes += BigInt(stakes[i]);
      }

      for(let i = 0; i<nodes.length; i++){
        let r = dist[nodes[i]];
        let actual = parseInt((BigInt(r[0])/BigInt(100000000000000000)).toString()) / parseInt((sumStakes/BigInt(100000000000000000)).toString());
        let probable = (r[1] / trials);

        expect(Math.abs(actual-probable)).be.lessThan(allowed_variance);

      }

    }).timeout(100000);

    it('is fair with 1:1 stake', async function () {
      const allowed_variance = 0.02;
      const stakes = ['100000000000000000', '100000000000000000'];
      const nodes = [others[0], others[1]];

      const dist = await nPlayerGames(nodes, stakes, trials);
      let sumStakes = BigInt(0);
      for(let i=0;i<stakes.length;i++){
        sumStakes += BigInt(stakes[i]);
      }

      for(let i = 0; i<nodes.length; i++){
        let r = dist[nodes[i]];
        let actual = parseInt((BigInt(r[0])/BigInt(100000000000000000)).toString()) / parseInt((sumStakes/BigInt(100000000000000000)).toString());
        let probable = (r[1] / trials);

        expect(Math.abs(actual-probable)).be.lessThan(allowed_variance);

      }

    }).timeout(100000);

  });
});
