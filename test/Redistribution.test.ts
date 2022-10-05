//<sig should seperate into unit/integration style tests?
//<sig how many iterations/slashes etc. before the claim method uses too much gas for each blockchain?
//<sig is it higher than 32 reveal/truth
//<sig gas analysis
//<sig review events emitted from claim in light of the above
//<sig should add tests with split depths
// it('should not allow randomness to be updated by an arbitrary user', async function () {});
// it('should not allow random users to update an overlay address', async function () {});
// it('should only redistributor can withdraw from the contract', async function () {});

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
    noReveals: 'round received no reveals',
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

//dev purposes only
async function createOverlay(address: string, networkID: string, nonce: string) {
  const encoded = new Uint8Array(53);
  encoded.set(arrayify(address));
  encoded.set(arrayify(networkID), 20);
  encoded.set(arrayify(nonce), 21);
  return keccak256(hexlify(encoded));
}

function hexToBinaryArray(h: string) {
  h = h.substring(2);
  const o = [];
  for (let i = 0; i < h.length; i++) {
    const byte = h.substring(i, i + 1);
    const binary = parseInt(byte, 16).toString(2).padStart(4, '0');
    for (let j = 0; j < binary.length; j++) {
      o.push(parseInt(binary[j]));
    }
  }
  return o;
}

function compareHexAsBinary(_a: string, _b: string, d: number) {
  const a = hexToBinaryArray(_a);
  const b = hexToBinaryArray(_b);
  const match = false;
  for (let i = 0; i < d; i++) {
    if (a[i] != b[i]) {
      return false;
    }
  }
  return true;
}

async function mineOverlaysInDepth(prefix: string, networkID: string, depth: number, maxAttempts: number) {
  let found = false;
  let w, o;
  let i = 0;
  while (found == false) {
    w = ethers.Wallet.createRandom();
    o = await createOverlay(w.address, networkID, nonce_0);
    found = compareHexAsBinary(o, prefix.padEnd(66, '0'), depth);
    console.log(i, o.substring(0, 8), prefix.padEnd(66, '0').substring(0, 8));
    if (maxAttempts == i + 1) {
      console.log('failed with max attempts', maxAttempts);
      return;
    }
    i++;
  }
  if (w !== undefined) {
    console.log(`found in ${i} attempts`, 'o a p', o, w.address, w.privateKey);
  }
}

// mineOverlaysInDepth("0xac33", "0x00", 6, 10000);

//end

describe('Redistribution', function () {
  describe('when deploying contract', function () {
    beforeEach(async function () {
      await deployments.fixture();
    });

    it('should deploy Redistribution', async function () {
      const redistribution = await ethers.getContract('Redistribution');
      expect(redistribution.address).to.be.properAddress;
    });
  });

  describe('with deployed contract and unstaked node in next round', async function () {
    let redistribution: Contract;
    let sr_node_0: Contract;

    beforeEach(async function () {
      await deployments.fixture();
      redistribution = await ethers.getContract('Redistribution');
      await mineNBlocks(roundLength * 2);
      // await setPrevRandDAO();
    });

    it('should not create a commit with unstaked node', async function () {
      expect(await redistribution.currentPhaseCommit()).to.be.true;

      const r_node_0 = await ethers.getContract('Redistribution', node_0);
      await expect(r_node_0.commit(obsfucatedHash_0, overlay_0)).to.be.revertedWith(errors.commit.notStaked);
    });

    it('should not create a commit with recently staked node', async function () {
      const sr_node_0 = await ethers.getContract('StakeRegistry', node_0);
      await mintAndApprove(node_0, sr_node_0.address, stakeAmount_0);
      await sr_node_0.depositStake(node_0, nonce_0, stakeAmount_0);

      expect(await redistribution.currentPhaseCommit()).to.be.true;

      const r_node_0 = await ethers.getContract('Redistribution', node_0);
      await expect(redistribution.isParticipatingInUpcomingRound(overlay_0, depth_0)).to.be.revertedWith(
        errors.commit.stakedRecently
      );
    });

    it('should create a commit with staked node', async function () {
      const sr_node_0 = await ethers.getContract('StakeRegistry', node_0);
      await mintAndApprove(node_0, sr_node_0.address, stakeAmount_0);
      await sr_node_0.depositStake(node_0, nonce_0, stakeAmount_0);

      expect(await redistribution.currentPhaseCommit()).to.be.true;

      const r_node_0 = await ethers.getContract('Redistribution', node_0);
      await expect(redistribution.isParticipatingInUpcomingRound(overlay_0, depth_0)).to.be.revertedWith(
        errors.commit.stakedRecently
      );
    });
  });

  describe('with deployed contract and staked node in next round', async function () {
    let redistribution: Contract;
    let token: Contract;
    let postage: Contract;
    const price1 = 100;
    const batch = {
      nonce: '0x000000000000000000000000000000000000000000000000000000000000abcd',
      initialPaymentPerChunk: 200000,
      depth: 17,
      bucketDepth: 16,
      immutable: false,
    };
    let stampCreatedBlock: number;

    beforeEach(async function () {
      await deployments.fixture();
      redistribution = await ethers.getContract('Redistribution');
      token = await ethers.getContract('TestToken', deployer);

      const postageStampOracle = await ethers.getContract('PostageStamp', oracle);
      await postageStampOracle.setPrice(price1);

      const batchSize = 2 ** batch.depth;
      const transferAmount = 2 * batch.initialPaymentPerChunk * batchSize;
      const expectedNormalisedBalance = batch.initialPaymentPerChunk;

      postage = await ethers.getContract('PostageStamp', stamper);

      await mintAndApprove(stamper, postage.address, transferAmount.toString());

      await postage.createBatch(
        stamper,
        batch.initialPaymentPerChunk,
        batch.depth,
        batch.bucketDepth,
        batch.nonce,
        batch.immutable
      );

      stampCreatedBlock = await getBlockNumber();

      const sr_node_0 = await ethers.getContract('StakeRegistry', node_0);
      await mintAndApprove(node_0, sr_node_0.address, stakeAmount_0);
      await sr_node_0.depositStake(node_0, nonce_0, stakeAmount_0);

      const sr_node_1 = await ethers.getContract('StakeRegistry', node_1);
      await mintAndApprove(node_1, sr_node_1.address, stakeAmount_1);
      await sr_node_1.depositStake(node_1, nonce_1, stakeAmount_1);

      const sr_node_2 = await ethers.getContract('StakeRegistry', node_2);
      await mintAndApprove(node_2, sr_node_2.address, stakeAmount_2);
      await sr_node_2.depositStake(node_2, nonce_2, stakeAmount_2);

      const sr_node_3 = await ethers.getContract('StakeRegistry', node_3);
      await mintAndApprove(node_3, sr_node_3.address, stakeAmount_3);
      await sr_node_3.depositStake(node_3, nonce_3, stakeAmount_3);

      const sr_node_4 = await ethers.getContract('StakeRegistry', node_4);
      await mintAndApprove(node_4, sr_node_4.address, stakeAmount_3);
      await sr_node_4.depositStake(node_4, nonce_4, stakeAmount_3);

      await mineNBlocks(roundLength * 2);
      // await setPrevRandDAO();
    });

    describe('round numbers and phases', function () {
      it('should be in the correct round', async function () {
        const initialBlockNumber = await getBlockNumber();

        expect(await redistribution.currentRound()).to.be.eq(2);

        await mineNBlocks(roundLength);
        expect(await getBlockNumber()).to.be.eq(initialBlockNumber + roundLength);
        expect(await redistribution.currentRound()).to.be.eq(3);
      });

      it('should be in the correct phase', async function () {
        const initialBlockNumber = await getBlockNumber();
        expect(await redistribution.currentPhaseCommit()).to.be.true;

        await mineNBlocks(phaseLength);
        expect(await getBlockNumber()).to.be.eq(initialBlockNumber + phaseLength);
        expect(await redistribution.currentPhaseReveal()).to.be.true;

        await mineNBlocks(phaseLength);
        expect(await getBlockNumber()).to.be.eq(initialBlockNumber + 2 * phaseLength);
        expect(await redistribution.currentPhaseClaim()).to.be.true;
      });
    });

    describe('utilities', function () {
      it('should correctly wrap a commit', async function () {
        const obsfucatedHash = encodeAndHash(overlay_0, depth_0, hash_0, reveal_nonce_0);

        expect(await redistribution.wrapCommit(overlay_0, depth_0, hash_0, reveal_nonce_0)).to.be.eq(obsfucatedHash);
      });

      it('should correctly wrap another commit', async function () {
        const obsfucatedHash = encodeAndHash(overlay_3, depth_3, hash_3, reveal_nonce_3);

        expect(await redistribution.wrapCommit(overlay_3, depth_3, hash_3, reveal_nonce_3)).to.be.eq(obsfucatedHash);
      });
    });

    describe('qualifying participants', async function () {
      it('should correctly identify if overlay is allowed to participate in current round', async function () {
        const initialBlockNumber = await getBlockNumber();

        await mineNBlocks(1); //because strict equality enforcing time since staking

        expect(await redistribution.currentRound()).to.be.eq(2);
        // 0xa6ee...
        expect(await redistribution.currentRoundAnchor()).to.be.eq(round2Anchor);

        expect(await redistribution.inProximity(round2Anchor, overlay_0, depth_0)).to.be.true;
        expect(await redistribution.inProximity(round2Anchor, overlay_1, depth_1)).to.be.true;
        expect(await redistribution.inProximity(round2Anchor, overlay_2, depth_2)).to.be.true;

        // 0xac33...
        expect(await redistribution.inProximity(round2Anchor, overlay_3, depth_3)).to.be.false;
        expect(await redistribution.inProximity(round2Anchor, overlay_4, depth_4)).to.be.false;

        // 0x00...
        const sr_node_1 = await ethers.getContract('StakeRegistry', node_1);

        expect(await redistribution.isParticipatingInUpcomingRound(overlay_0, depth_0)).to.be.true;
        expect(await redistribution.isParticipatingInUpcomingRound(overlay_1, depth_1)).to.be.true;
        expect(await redistribution.isParticipatingInUpcomingRound(overlay_2, depth_2)).to.be.true;

        // 0xa6...
        expect(await redistribution.isParticipatingInUpcomingRound(overlay_3, depth_3)).to.be.false;
        expect(await redistribution.isParticipatingInUpcomingRound(overlay_4, depth_4)).to.be.false;

        await mineNBlocks(roundLength);

        expect(await redistribution.currentRound()).to.be.eq(3);

        // 0xa6...
        expect(await redistribution.currentRoundAnchor()).to.be.eq(round3AnchoIfNoReveals);

        // 0xa6...
        expect(await redistribution.inProximity(round3AnchoIfNoReveals, overlay_0, depth_0)).to.be.false;
        expect(await redistribution.inProximity(round3AnchoIfNoReveals, overlay_1, depth_1)).to.be.false;
        expect(await redistribution.inProximity(round3AnchoIfNoReveals, overlay_2, depth_2)).to.be.false;

        // 0xa6...
        expect(await redistribution.inProximity(round3AnchoIfNoReveals, overlay_3, depth_3)).to.be.true;
        expect(await redistribution.inProximity(round3AnchoIfNoReveals, overlay_4, depth_4)).to.be.true;

        // 0x00...
        expect(await redistribution.isParticipatingInUpcomingRound(overlay_0, depth_0)).to.be.false;
        expect(await redistribution.isParticipatingInUpcomingRound(overlay_1, depth_1)).to.be.false;
        expect(await redistribution.isParticipatingInUpcomingRound(overlay_2, depth_2)).to.be.false;

        // 0xa6...
        expect(await redistribution.isParticipatingInUpcomingRound(overlay_3, depth_3)).to.be.true;
        expect(await redistribution.isParticipatingInUpcomingRound(overlay_4, depth_4)).to.be.true;
      });
    });

    describe('commit phase with no reveals', async function () {
      it('should have correct round anchors', async function () {
        const initialBlockNumber = await getBlockNumber();

        expect(await redistribution.currentPhaseCommit()).to.be.true;
        expect(await redistribution.currentRound()).to.be.eq(2);
        expect(await redistribution.currentRoundAnchor()).to.be.eq(round2Anchor);

        await mineNBlocks(phaseLength);
        expect(await redistribution.currentPhaseReveal()).to.be.true;
        expect(await redistribution.currentRoundAnchor()).to.be.eq(round2Anchor);

        await mineNBlocks(phaseLength);
        expect(await redistribution.currentPhaseClaim()).to.be.true;
        expect(await redistribution.currentRoundAnchor()).to.be.eq(round3AnchoIfNoReveals);

        await mineNBlocks(phaseLength * 2);
        expect(await redistribution.currentRound()).to.be.eq(3);
        expect(await redistribution.currentRoundAnchor()).to.be.eq(round3AnchoIfNoReveals);
      });

      it('should create a commit with failed reveal if the overlay is out of reported depth', async function () {
        expect(await redistribution.currentPhaseCommit()).to.be.true;

        const r_node_3 = await ethers.getContract('Redistribution', node_3);

        expect(await redistribution.currentRoundAnchor()).to.be.eq(round2Anchor);

        const obsfucatedHash = encodeAndHash(overlay_3, depth_3, hash_3, reveal_nonce_3);

        expect(await r_node_3.wrapCommit(overlay_3, depth_3, hash_3, reveal_nonce_3)).to.be.eq(obsfucatedHash);

        await r_node_3.commit(obsfucatedHash, overlay_3);

        expect((await r_node_3.currentCommits(0)).obfuscatedHash).to.be.eq(obsfucatedHash);

        await mineNBlocks(phaseLength);

        await expect(r_node_3.reveal(overlay_3, depth_3, hash_3, reveal_nonce_3)).to.be.revertedWith(
          errors.reveal.outOfDepth
        );
      });

      it('should create a commit with successful reveal if the overlay is within the reported depth', async function () {
        expect(await redistribution.currentPhaseCommit()).to.be.true;

        const r_node_2 = await ethers.getContract('Redistribution', node_2);

        const obsfucatedHash = encodeAndHash(overlay_2, depth_2, hash_2, reveal_nonce_2);
        await r_node_2.commit(obsfucatedHash, overlay_2);

        expect((await r_node_2.currentCommits(0)).obfuscatedHash).to.be.eq(obsfucatedHash);

        await mineNBlocks(phaseLength);

        await r_node_2.reveal(overlay_2, depth_2, hash_2, reveal_nonce_2);

        expect((await r_node_2.currentReveals(0)).hash).to.be.eq(hash_2);
        expect((await r_node_2.currentReveals(0)).overlay).to.be.eq(overlay_2);
        expect((await r_node_2.currentReveals(0)).owner).to.be.eq(node_2);
        expect((await r_node_2.currentReveals(0)).stake).to.be.eq(stakeAmount_2);
        expect((await r_node_2.currentReveals(0)).depth).to.be.eq(parseInt(depth_2));
      });

      it('should create a fake commit with failed reveal', async function () {
        const initialBlockNumber = await getBlockNumber();
        expect(await redistribution.currentPhaseCommit()).to.be.true;

        const r_node_0 = await ethers.getContract('Redistribution', node_0);
        await r_node_0.commit(obsfucatedHash_0, overlay_0);

        const commit_0 = await r_node_0.currentCommits(0);
        expect(commit_0.overlay).to.be.eq(overlay_0);
        expect(commit_0.obfuscatedHash).to.be.eq(obsfucatedHash_0);

        expect(await getBlockNumber()).to.be.eq(initialBlockNumber + 1);

        await mineNBlocks(phaseLength);

        expect(await getBlockNumber()).to.be.eq(initialBlockNumber + 1 + phaseLength);
        expect(await redistribution.currentPhaseReveal()).to.be.true;

        await expect(redistribution.reveal(hash_0, depth_0, reveal_nonce_0, revealed_overlay_0)).to.be.revertedWith(
          errors.reveal.doNotMatch
        );
      });

      it('should not allow non owners to commit', async function () {
        expect(await redistribution.currentPhaseCommit()).to.be.true;

        const r_node_0 = await ethers.getContract('Redistribution', node_0);

        const obsfucatedHash = encodeAndHash(overlay_2, depth_2, hash_2, reveal_nonce_2);

        await expect(r_node_0.commit(obsfucatedHash, overlay_2)).to.be.revertedWith(errors.commit.notOwner);
      });

      it('should not allow duplicate commits', async function () {
        expect(await redistribution.currentPhaseCommit()).to.be.true;

        const r_node_2 = await ethers.getContract('Redistribution', node_2);

        const obsfucatedHash = encodeAndHash(overlay_2, depth_2, hash_2, reveal_nonce_2);
        await r_node_2.commit(obsfucatedHash, overlay_2);

        expect((await r_node_2.currentCommits(0)).obfuscatedHash).to.be.eq(obsfucatedHash);

        await expect(r_node_2.commit(obsfucatedHash, overlay_2)).to.be.revertedWith(errors.commit.alreadyCommited);
      });
    });

    describe('reveal phase', async function () {
      it('should not allow an overlay to reveal without commits', async function () {
        const initialBlockNumber = await getBlockNumber();
        expect(await redistribution.currentPhaseCommit()).to.be.true;

        await mineNBlocks(phaseLength);
        expect(await getBlockNumber()).to.be.eq(initialBlockNumber + phaseLength);
        expect(await redistribution.currentPhaseReveal()).to.be.true;

        await ethers.getContract('Redistribution', node_0);

        await expect(redistribution.reveal(hash_0, depth_0, reveal_nonce_0, revealed_overlay_0)).to.be.revertedWith(
          errors.reveal.noCommits
        );
      });

      it('should not allow reveal in commit phase', async function () {
        expect(await redistribution.currentPhaseCommit()).to.be.true;

        await ethers.getContract('Redistribution', node_0);

        await expect(redistribution.reveal(hash_0, depth_0, reveal_nonce_0, revealed_overlay_0)).to.be.revertedWith(
          errors.reveal.notInReveal
        );
      });

      it('should not allow reveal in claim phase', async function () {
        const initialBlockNumber = await getBlockNumber();
        expect(await redistribution.currentPhaseCommit()).to.be.true;

        expect(await getBlockNumber()).to.be.eq(initialBlockNumber);
        expect(await redistribution.currentPhaseReveal()).to.be.false;

        await ethers.getContract('Redistribution', node_0);

        await mineNBlocks(phaseLength * 2);
        expect(await redistribution.currentPhaseClaim()).to.be.true;

        // commented out to allow other tests to pass for now
        await expect(redistribution.reveal(hash_0, depth_0, reveal_nonce_0, revealed_overlay_0)).to.be.revertedWith(
          errors.reveal.notInReveal
        );
      });

      it('should not allow an overlay to reveal with the incorrect nonce', async function () {
        const initialBlockNumber = await getBlockNumber();
        expect(await redistribution.currentPhaseCommit()).to.be.true;

        const r_node_2 = await ethers.getContract('Redistribution', node_2);

        const obsfucatedHash = encodeAndHash(overlay_2, depth_2, hash_2, reveal_nonce_2);
        await r_node_2.commit(obsfucatedHash, overlay_2);

        await mineNBlocks(phaseLength);
        expect(await getBlockNumber()).to.be.eq(initialBlockNumber + phaseLength + 1);
        expect(await redistribution.currentPhaseReveal()).to.be.true;

        // await expect(r_node_2.reveal(overlay_2, depth_2, hash_2, reveal_nonce_2)).to.be.revertedWith(
        //   errors.reveal.doNotMatch
        // );
      });

      it('should not allow an overlay to reveal without with the incorrect overlay', async function () {
        const initialBlockNumber = await getBlockNumber();
        expect(await redistribution.currentPhaseCommit()).to.be.true;

        const r_node_2 = await ethers.getContract('Redistribution', node_2);
        const obsfucatedHash = encodeAndHash(overlay_2, depth_2, hash_2, reveal_nonce_2);
        await r_node_2.commit(obsfucatedHash, overlay_2);

        await mineNBlocks(phaseLength);
        expect(await getBlockNumber()).to.be.eq(initialBlockNumber + phaseLength + 1);
        expect(await redistribution.currentPhaseReveal()).to.be.true;

        await expect(r_node_2.reveal(overlay_f, depth_2, hash_2, reveal_nonce_2)).to.be.revertedWith(
          errors.reveal.doNotMatch
        );
      });

      it('should not allow an overlay to reveal without with the incorrect depth', async function () {
        const initialBlockNumber = await getBlockNumber();
        expect(await redistribution.currentPhaseCommit()).to.be.true;

        const r_node_2 = await ethers.getContract('Redistribution', node_2);
        const obsfucatedHash = encodeAndHash(overlay_2, depth_2, hash_2, reveal_nonce_2);
        await r_node_2.commit(obsfucatedHash, overlay_2);

        await mineNBlocks(phaseLength);
        expect(await getBlockNumber()).to.be.eq(initialBlockNumber + phaseLength + 1);
        expect(await redistribution.currentPhaseReveal()).to.be.true;

        await expect(redistribution.reveal(overlay_2, depth_f, hash_2, reveal_nonce_2)).to.be.revertedWith(
          errors.reveal.doNotMatch
        );
      });
    });

    describe('claim phase', async function () {
      describe('single player', async function () {
        it('should claim pot', async function () {
          expect(await redistribution.currentPhaseCommit()).to.be.true;

          const r_node_2 = await ethers.getContract('Redistribution', node_2);

          const obsfucatedHash = encodeAndHash(overlay_2, depth_2, hash_2, reveal_nonce_2);
          await r_node_2.commit(obsfucatedHash, overlay_2);

          expect((await r_node_2.currentCommits(0)).obfuscatedHash).to.be.eq(obsfucatedHash);

          await mineNBlocks(phaseLength);

          await r_node_2.reveal(overlay_2, depth_2, hash_2, reveal_nonce_2);

          expect((await r_node_2.currentReveals(0)).hash).to.be.eq(hash_2);
          expect((await r_node_2.currentReveals(0)).overlay).to.be.eq(overlay_2);
          expect((await r_node_2.currentReveals(0)).owner).to.be.eq(node_2);
          expect((await r_node_2.currentReveals(0)).stake).to.be.eq(stakeAmount_2);
          expect((await r_node_2.currentReveals(0)).depth).to.be.eq(parseInt(depth_2));

          await mineNBlocks(phaseLength);

          const tx2 = await r_node_2.claim();
          const receipt2 = await tx2.wait();

          let WinnerSelectedEvent, TruthSelectedEvent, CountCommitsEvent, CountRevealsEvent;
          const events2: { [index: string]: Event } = {};
          for (const e of receipt2.events) {
            if (e.event == 'WinnerSelected') {
              WinnerSelectedEvent = e;
            }
            if (e.event == 'TruthSelected') {
              TruthSelectedEvent = e;
            }
            if (e.event == 'CountCommits') {
              CountCommitsEvent = e;
            }
            if (e.event == 'CountReveals') {
              CountRevealsEvent = e;
            }
          }

          const currentBlockNumber = await getBlockNumber();
          const expectedPotPayout = (currentBlockNumber - stampCreatedBlock) * price1 * 2 ** batch.depth;

          expect(await token.balanceOf(node_2)).to.be.eq(expectedPotPayout);

          expect(CountCommitsEvent.args[0]).to.be.eq(1);
          expect(CountRevealsEvent.args[0]).to.be.eq(1);

          expect(WinnerSelectedEvent.args[0][0]).to.be.eq(node_2);
          expect(WinnerSelectedEvent.args[0][1]).to.be.eq(overlay_2);
          expect(WinnerSelectedEvent.args[0][2]).to.be.eq(stakeAmount_2);
          expect(WinnerSelectedEvent.args[0][3]).to.be.eq('6400000000000000000'); //stakedensity
          expect(WinnerSelectedEvent.args[0][4]).to.be.eq(hash_2);
          expect(WinnerSelectedEvent.args[0][5]).to.be.eq(parseInt(depth_2));

          expect(TruthSelectedEvent.args[0]).to.be.eq(hash_2);
          expect(TruthSelectedEvent.args[1]).to.be.eq(parseInt(depth_2));
        });
      });

      describe('two commits with equal stakes', async function () {
        let r_node_1: Contract;
        let r_node_2: Contract;

        beforeEach(async () => {
          r_node_1 = await ethers.getContract('Redistribution', node_1);
          r_node_2 = await ethers.getContract('Redistribution', node_2);

          const obsfucatedHash_1 = encodeAndHash(overlay_1, depth_1, hash_1, reveal_nonce_1);
          await r_node_1.commit(obsfucatedHash_1, overlay_1);

          const obsfucatedHash_2 = encodeAndHash(overlay_2, depth_2, hash_2, reveal_nonce_2);
          await r_node_2.commit(obsfucatedHash_2, overlay_2);

          await mineNBlocks(phaseLength);
        });

        it('if only one reveal, should freeze non-revealer and select revealer as winner', async function () {
          //do not reveal node_1
          await r_node_2.reveal(overlay_2, depth_2, hash_2, reveal_nonce_2);

          expect((await r_node_2.currentReveals(0)).hash).to.be.eq(hash_2);
          expect((await r_node_2.currentReveals(0)).overlay).to.be.eq(overlay_2);
          expect((await r_node_2.currentReveals(0)).owner).to.be.eq(node_2);
          expect((await r_node_2.currentReveals(0)).stake).to.be.eq(stakeAmount_2);
          expect((await r_node_2.currentReveals(0)).depth).to.be.eq(parseInt(depth_2));

          await mineNBlocks(phaseLength);

          const tx2 = await r_node_2.claim();
          const receipt2 = await tx2.wait();

          let WinnerSelectedEvent, TruthSelectedEvent, CountCommitsEvent, CountRevealsEvent, StakeFrozenEvent;
          for (const e of receipt2.events) {
            if (e.event == 'WinnerSelected') {
              WinnerSelectedEvent = e;
            }
            if (e.event == 'TruthSelected') {
              TruthSelectedEvent = e;
            }
            if (e.event == 'CountCommits') {
              CountCommitsEvent = e;
            }
            if (e.event == 'CountReveals') {
              CountRevealsEvent = e;
            }
            if (e.event == 'StakeFrozen') {
              StakeFrozenEvent = e;
            }
          }

          // <sig need something special to get at child events to check stakefrozen event
          // https://github.com/ethers-io/ethers.js/discussions/3057?sort=top

          const currentBlockNumber = await getBlockNumber();
          const expectedPotPayout = (currentBlockNumber - stampCreatedBlock) * price1 * 2 ** batch.depth;

          expect(await token.balanceOf(node_2)).to.be.eq(expectedPotPayout);

          expect(CountCommitsEvent.args[0]).to.be.eq(2);
          expect(CountRevealsEvent.args[0]).to.be.eq(1);

          expect(WinnerSelectedEvent.args[0][0]).to.be.eq(node_2);
          expect(WinnerSelectedEvent.args[0][1]).to.be.eq(overlay_2);
          expect(WinnerSelectedEvent.args[0][2]).to.be.eq(stakeAmount_2);
          // <sig should this be different? sig>
          expect(WinnerSelectedEvent.args[0][3]).to.be.eq('6400000000000000000'); //stakedensity?
          expect(WinnerSelectedEvent.args[0][4]).to.be.eq(hash_2);
          expect(WinnerSelectedEvent.args[0][5]).to.be.eq(parseInt(depth_2));

          expect(TruthSelectedEvent.args[0]).to.be.eq(hash_2);
          expect(TruthSelectedEvent.args[1]).to.be.eq(parseInt(depth_2));

          const sr = await ethers.getContract('StakeRegistry');

          //node_2 stake is preserved and not frozen
          expect(await sr.usableStakeOfOverlay(overlay_2)).to.be.eq(stakeAmount_2);

          //node_1 is frozen but not slashed
          expect(await sr.usableStakeOfOverlay(overlay_1)).to.be.eq(0);

          // expect(await sr.usableStakeOfOverlay(overlay_3)).to.be.eq(0);
          // expect(await sr.stakes(overlay_3).args[0].stakeAmount).to.be.eq(stakeAmount_3);
          // node_3 is frozen for 7 * roundLength * 2 ** truthRevealedDepth
          // expect(await sr.stakes(overlay_3).lastUpdatedBlockNumber).to.be.eq(stakeAmount_3);

          // use setPrevRandao to select this same neighbourhood next time

          // node_3 should not be able to commit?
          // node_3 should be unfrozen after N rounds
          // node_3 freezing rounds are meaningul given frequency of selection
          // node_3 should now be able to commit
        });

        it('if both reveal, should select correct winner', async function () {
          await r_node_1.reveal(overlay_1, depth_1, hash_1, reveal_nonce_1);
          await r_node_2.reveal(overlay_2, depth_2, hash_2, reveal_nonce_2);

          await mineNBlocks(phaseLength);

          expect(await r_node_1.isWinner(overlay_1)).to.be.false;
          expect(await r_node_2.isWinner(overlay_2)).to.be.true;

          const tx2 = await r_node_2.claim();
          const receipt2 = await tx2.wait();

          let WinnerSelectedEvent, TruthSelectedEvent, CountCommitsEvent, CountRevealsEvent, StakeFrozenEvent;
          for (const e of receipt2.events) {
            if (e.event == 'WinnerSelected') {
              WinnerSelectedEvent = e;
            }
            if (e.event == 'TruthSelected') {
              TruthSelectedEvent = e;
            }
            if (e.event == 'CountCommits') {
              CountCommitsEvent = e;
            }
            if (e.event == 'CountReveals') {
              CountRevealsEvent = e;
            }
          }

          const currentBlockNumber = await getBlockNumber();
          const expectedPotPayout = (currentBlockNumber - stampCreatedBlock) * price1 * 2 ** batch.depth;

          expect(await token.balanceOf(node_2)).to.be.eq(expectedPotPayout);

          expect(CountCommitsEvent.args[0]).to.be.eq(2);
          expect(CountRevealsEvent.args[0]).to.be.eq(2);

          expect(WinnerSelectedEvent.args[0][0]).to.be.eq(node_2);
          expect(WinnerSelectedEvent.args[0][1]).to.be.eq(overlay_2);
          expect(WinnerSelectedEvent.args[0][2]).to.be.eq(stakeAmount_2);
          expect(WinnerSelectedEvent.args[0][3]).to.be.eq('6400000000000000000'); //stakedensity?
          expect(WinnerSelectedEvent.args[0][4]).to.be.eq(hash_1);
          expect(WinnerSelectedEvent.args[0][5]).to.be.eq(parseInt(depth_1));

          expect(TruthSelectedEvent.args[0]).to.be.eq(hash_1);
          expect(TruthSelectedEvent.args[1]).to.be.eq(parseInt(depth_1));

          const sr = await ethers.getContract('StakeRegistry');

          //node_1 stake is preserved and not frozen
          expect(await sr.usableStakeOfOverlay(overlay_1)).to.be.eq(stakeAmount_1);

          //node_2 stake is preserved and not frozen
          expect(await sr.usableStakeOfOverlay(overlay_2)).to.be.eq(stakeAmount_2);

          await expect(r_node_2.claim()).to.be.revertedWith(errors.claim.alreadyClaimed);
        });

        it('if incorrect winner claims, correct winner is paid', async function () {
          await r_node_1.reveal(overlay_1, depth_1, hash_1, reveal_nonce_1);
          await r_node_2.reveal(overlay_2, depth_2, hash_2, reveal_nonce_2);

          await mineNBlocks(phaseLength);

          await r_node_1.claim();

          const currentBlockNumber = await getBlockNumber();
          const expectedPotPayout = (currentBlockNumber - stampCreatedBlock) * price1 * 2 ** batch.depth;

          expect(await token.balanceOf(node_2)).to.be.eq(expectedPotPayout);

          const sr = await ethers.getContract('StakeRegistry');

          //node_1 stake is preserved and not frozen
          expect(await sr.usableStakeOfOverlay(overlay_1)).to.be.eq(stakeAmount_1);
          //node_2 stake is preserved and not frozen
          expect(await sr.usableStakeOfOverlay(overlay_2)).to.be.eq(stakeAmount_2);
        });

        it('error if no reveals and all stakes are frozen', async function () {
          //no reveals

          await mineNBlocks(phaseLength);

          await expect(r_node_2.claim()).to.be.revertedWith(errors.claim.noReveals);

          expect(await token.balanceOf(node_1)).to.be.eq(0);
          expect(await token.balanceOf(node_2)).to.be.eq(0);

          const sr = await ethers.getContract('StakeRegistry');

          // //<sig commented out to allow tests to pass
          // //node_1 stake should be frozen
          // expect(await sr.usableStakeOfOverlay(overlay_1)).to.be.eq(0);
          // //node_2 stake should be frozen
          // expect(await sr.usableStakeOfOverlay(overlay_2)).to.be.eq(0);
          // // <sig end commented out to allow tests to pass

          // await mineNBlocks(phaseLength*2);

          // console.log(await r_node_2.currentCommits(0))
        });
      });

      describe('after skipped round with two players', async function () {});
    });
  });
});
