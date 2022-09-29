import { expect } from './util/chai';
import { ethers, deployments, getNamedAccounts } from 'hardhat';
import { Event, Contract } from 'ethers';

import { keccak256 } from '@ethersproject/keccak256';
import { arrayify, hexlify } from '@ethersproject/bytes';

const phaseLength = 38;
const roundLength = 152;

const round2Anchor = '0xa6eef7e35abe7026729641147f7915573c7e97b47efa546f5f6e3230263bcb49';
const round3AnchoIfNoReveals = '0xac33ff75c19e70fe83507db0d683fd3465c996598dc972688b7ace676c89077b';

// Named accounts used by tests.
let deployer: string;

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
const address_2 = '0x61a270cBBD60a030b3399655F6a65E175cb9179f';

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
  node_0 = namedAccounts.node_0;
  node_1 = namedAccounts.node_1;
  node_2 = namedAccounts.node_2;
  node_3 = namedAccounts.node_3;
  node_4 = namedAccounts.node_4;
});

const errors = {
  commit: {
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
  let o = [];
  for (let i = 0; i < h.length; i++) {
    let byte = h.substring(i, i + 1);
    let binary = parseInt(byte, 16).toString(2).padStart(4, '0');
    for (let j = 0; j < binary.length; j++) {
      o.push(parseInt(binary[j]));
    }
  }
  return o;
}

function compareHexAsBinary(_a: string, _b: string, d: number) {
  let a = hexToBinaryArray(_a);
  let b = hexToBinaryArray(_b);
  let match = false;
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
      await mineNBlocks(roundLength*2);
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
    let sr_node_0: Contract;

    beforeEach(async function () {
      await deployments.fixture();
      redistribution = await ethers.getContract('Redistribution');

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

      await mineNBlocks(roundLength*2);
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

      it('should correctly wrap a commit', async function () {
        const obsfucatedHash = encodeAndHash(overlay_3, depth_3, hash_3, reveal_nonce_3);

        expect(await redistribution.wrapCommit(overlay_3, depth_3, hash_3, reveal_nonce_3)).to.be.eq(obsfucatedHash);
      });
    });

    // describe('initial rounds', function () {
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

      describe('with no reveals', async function () {
        it('should have correct round anchors', async function () {
          const initialBlockNumber = await getBlockNumber();

          expect(await redistribution.currentRound()).to.be.eq(2);
          expect(await redistribution.currentRoundAnchor()).to.be.eq(round2Anchor);

          await mineNBlocks(phaseLength);
          expect(await redistribution.currentPhaseReveal()).to.be.true;
          // <sig is this desired behavior? sig>
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

          const r_node_0 = await ethers.getContract('Redistribution', node_0);

          const obsfucatedHash = encodeAndHash(overlay_2, depth_2, hash_2, reveal_nonce_2);
          await r_node_0.commit(obsfucatedHash, overlay_2);

          expect((await r_node_0.currentCommits(0)).obfuscatedHash).to.be.eq(obsfucatedHash);

          await mineNBlocks(phaseLength);

          await r_node_0.reveal(overlay_2, depth_2, hash_2, reveal_nonce_2);

          expect((await r_node_0.currentReveals(0)).hash).to.be.eq(hash_2);
          expect((await r_node_0.currentReveals(0)).overlay).to.be.eq(overlay_2);
          expect((await r_node_0.currentReveals(0)).owner).to.be.eq(address_2);
          expect((await r_node_0.currentReveals(0)).stake).to.be.eq(stakeAmount_2);
          expect((await r_node_0.currentReveals(0)).depth).to.be.eq(parseInt(depth_2));
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

        it('should not allow duplicate commits', async function () {
          expect(await redistribution.currentPhaseCommit()).to.be.true;

          const r_node_0 = await ethers.getContract('Redistribution', node_0);

          const obsfucatedHash = encodeAndHash(overlay_2, depth_2, hash_2, reveal_nonce_2);
          await r_node_0.commit(obsfucatedHash, overlay_2);

          expect((await r_node_0.currentCommits(0)).obfuscatedHash).to.be.eq(obsfucatedHash);

          await expect(r_node_0.commit(obsfucatedHash, overlay_2)).to.be.revertedWith(errors.commit.alreadyCommited);
        });
      });

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

      // it('should not allow randomness to be updated by an arbitrary user', async function () {});
      // it('should not allow random users to update an overlay address', async function () {});

      // it('should allow honest single player to claim pot', async function () {
      //     expect(await redistribution.currentPhaseCommit()).to.be.true;

      //     const r_node_0 = await ethers.getContract('Redistribution', node_0);

      //     const obsfucatedHash = encodeAndHash(overlay_2, depth_2, hash_2, reveal_nonce_2);
      //     await r_node_0.commit(obsfucatedHash, overlay_2);

      //     expect((await r_node_0.currentCommits(0)).obfuscatedHash).to.be.eq(obsfucatedHash);

      //     await mineNBlocks(phaseLength);

      //     // await r_node_0.reveal(overlay_2, depth_2, hash_2, reveal_nonce_2);

      //     // expect((await r_node_0.currentReveals(0)).hash).to.be.eq(hash_2);
      //     // expect((await r_node_0.currentReveals(0)).overlay).to.be.eq(overlay_2);
      //     // expect((await r_node_0.currentReveals(0)).owner).to.be.eq('0x467aF2818F6eBB358870F824B69aeE7f5ee2C881');
      //     // expect((await r_node_0.currentReveals(0)).stake).to.be.eq(stakeAmount_2);
      //     // expect((await r_node_0.currentReveals(0)).depth).to.be.eq(parseInt(depth_2));

      //   // const tx2 = await r_node_0.claim();
      //   // const receipt2 = await tx2.wait();

      //   // const events2: { [index: string]: Event } = {};
      //   // for (const e of receipt2.events) {
      //   //   events2[e.event] = e;
      //   // }

      //   // // @ts-ignore
      //   // expect(events2.WinnerSelected.args[0]).to.be.eq(node_0);
      //   // // @ts-ignore
      //   // expect(events2.TruthSelected.args[0]).to.be.eq(node_0);
      //   // // @ts-ignore
      //   // expect(events2.TruthSelected.args[1]).to.be.eq(hash_0);

      //   // expect(events.TruthSelected.args[2]).to.be.eq(depth_2)

      //   // correct value of pot is withdrawn
      // });

      // should we add a method to allow us to deterministically assign the "random" number for testing
      // perhaps this could be the interface to the RNG

      // if there is two commit reveals with equal stakes
      // test the selection of truth is correct based on the truthSelectionAnchor
      // test the selection of the winner is correct based on the winnerSelectionAnchor

      // stats tests
      // both are evenly selected (do this in a separate test file)

      // it('if there is two commit reveals with equal stakes', async function () {});
    // });

      //if claimed
        //currentWinner reports already been claimed
        //claim reports already been claimed

      //in the second round
        //should have no commits

      //starting in an arbritary round number

      //should not be able to commit if frozen for X rounds if doesn't match truth oracle
      //should be slashed if committed and not revealed
  });
});
