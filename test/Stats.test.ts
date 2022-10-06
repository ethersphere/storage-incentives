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

let node_0: string;
const overlay_0 = '0xa67dc06e2a97991a1ace5628baf7a50efa00814b369e375475c059919f3cccaf';
const nonce_0 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';
const revealed_overlay_0 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';
const hash_0 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';
const depth_0 = '0x06';
const reveal_nonce_0 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';
const stakeAmount_0 = '100000000000000000';

const obsfucatedHash_0 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';

//fake
const overlay_f = '0xf4153f4153f4153f4153f4153f4153f4153f4153f4153f4153f4153f4153f415';
const depth_f = '0x0000000000000000000000000000000000000000000000000000000000000007';
const reveal_nonce_f = '0xf4153f4153f4153f4153f4153f4153f4153f4153f4153f4153f4153f4153f415';
const obsfucatedHash_f = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';

let node_1: string;
const overlay_1 = '0xa6da244c491646c1a8d60be1804e537ed77c90543815cac39f117bbe846bc665';
const stakeAmount_1 = '100000000000000000';
const nonce_1 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';
const hash_1 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';
const depth_1 = '0x06';
const reveal_nonce_1 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';

const obsfucatedHash_1 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';

let node_2: string;
const overlay_2 = '0xa55ccf886a6a325789beabcea720d3f1f0469672b2d042001214e9a246ae6465';
const stakeAmount_2 = '100000000000000000';
const nonce_2 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';
const hash_2 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';
const depth_2 = '0x06';
const reveal_nonce_2 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';

let node_3: string;
const overlay_3 = '0xae41f76f17b6bff2be63309297b8b65326548dce0df5cfdc09aebf6eaf1d76e1';
const stakeAmount_3 = '100000000000000000';
const nonce_3 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';
const hash_3 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';
const depth_3 = '0x06';
const reveal_nonce_3 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';

let node_4: string;
const overlay_4 = '0xaf4f91fec04f7fb393ebf0671da5562c278871530541b5eb612e6e03a2cfdde8';
const stakeAmount_4 = '100000000000000000';
const nonce_4 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';
const hash_4 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';
const depth_4 = '0x06';
const reveal_nonce_4 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';

// Before the tests, assign accounts
before(async function () {
  const namedAccounts = await getNamedAccounts();
  deployer = namedAccounts.deployer;
  stamper = namedAccounts.stamper;
  oracle = namedAccounts.oracle;
  node_0 = namedAccounts.node_0;
  node_1 = namedAccounts.node_1;
  node_2 = namedAccounts.node_2;
  node_3 = namedAccounts.node_3;
  node_4 = namedAccounts.node_4;
  others = await getUnnamedAccounts();
});

const errors = {
  commit: {
    notOwner: 'owner must match sender to be able to commit',
    notStaked: 'node must have staked at least minimum stake',
    stakedRecently: 'stake updated recently',
    alreadyCommited: 'participant already committed in this round',
  },
  reveal: {
    noCommits: 'round received no commits',
    doNotMatch: 'no matching commit or hash',
    outOfDepth: 'anchor out of self reported depth',
    notInReveal: 'not in reveal phase',
  },
  claim: {
    alreadyClaimed: 'round already received successful claim',
  },
};

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

async function twoPlayerGames(
  node_a: string,
  node_b: string,
  stake_amount_a: string,
  stake_amount_b: string,
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
  const r_node_a = await ethers.getContract('Redistribution', node_a);
  const r_node_b = await ethers.getContract('Redistribution', node_b);

  const overlay_a = await createOverlay(node_a, '0x00', nonce);
  const overlay_b = await createOverlay(node_b, '0x00', nonce);

  const sr_node_a = await ethers.getContract('StakeRegistry', node_a);
  await mintAndApprove(node_a, sr_node_a.address, stake_amount_a);
  await sr_node_a.depositStake(node_a, nonce, stake_amount_a);

  const sr_node_b = await ethers.getContract('StakeRegistry', node_b);
  await mintAndApprove(node_b, sr_node_b.address, stake_amount_b);
  await sr_node_b.depositStake(node_b, nonce, stake_amount_b);

  let winsA = 0;
  await mineNBlocks(roundLength * 3 - 21);
  for (let i = 0; i < trials; i++) {
    const startRoundBlockNumber = await getBlockNumber();

    const obsfucatedHash_a = encodeAndHash(overlay_a, depth, hash, reveal_nonce);
    await r_node_a.commit(obsfucatedHash_a, overlay_a);

    const obsfucatedHash_b = encodeAndHash(overlay_b, depth, hash, reveal_nonce);
    await r_node_b.commit(obsfucatedHash_b, overlay_b);

    await mineNBlocks(phaseLength);

    await r_node_a.reveal(overlay_a, depth, hash, reveal_nonce);
    await r_node_b.reveal(overlay_b, depth, hash, reveal_nonce);

    await mineNBlocks(phaseLength - 2);

    if (await r_node_a.isWinner(overlay_a)) {
      winsA++;
    }

    const tx2 = await r_node_b.claim();
    const receipt2 = await tx2.wait();

    const sr = await ethers.getContract('StakeRegistry');

    //stakes are preserved
    expect(await sr.usableStakeOfOverlay(overlay_a)).to.be.eq(stake_amount_a);
    expect(await sr.usableStakeOfOverlay(overlay_b)).to.be.eq(stake_amount_b);

    await mineNBlocks(phaseLength * 2 - 3);
  }
  return winsA / trials;
}

describe('Stats', function () {
  describe('two player game', async function () {
    const trials = 200;

    it('is fair with 1:3 stake', async function () {
      const stake_amount_a = '100000000000000000';
      const stake_amount_b = '300000000000000000';
      const perfect_ratio = 0.25;
      const allowed_variance = 0.02;
      const node_a = others[0];
      const node_b = others[1];

      const winRatio = await twoPlayerGames(node_a, node_b, stake_amount_a, stake_amount_b, trials);

      expect(winRatio).be.lessThan(perfect_ratio + allowed_variance);
      expect(winRatio).be.greaterThan(perfect_ratio - allowed_variance);
    }).timeout(100000);

  //   it('is fair with 1:3 stake', async function () {
  //     const stake_amount_a = '100000000000000000';
  //     const stake_amount_b = '300000000000000000';
  //     const perfect_ratio = 0.25;
  //     const allowed_variance = 0.02;
  //     const node_a = others[2];
  //     const node_b = others[3];

  //     let winRatio = await twoPlayerGames(node_a, node_b, stake_amount_a, stake_amount_b, trials);

  //     expect(winRatio).be.lessThan(perfect_ratio + allowed_variance);
  //     expect(winRatio).be.greaterThan(perfect_ratio - allowed_variance);
  //   }).timeout(50000);
  });
});
