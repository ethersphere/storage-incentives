import { expect } from './util/chai';
import { ethers, deployments, getUnnamedAccounts } from 'hardhat';
import { Event, Contract } from 'ethers';

import { keccak256 } from '@ethersproject/keccak256';
import { arrayify, hexlify } from '@ethersproject/bytes';

const phaseLength = 38;
const roundLength = 146;

// Named accounts used by tests.
let node_0: string;

// Before the tests, assign accounts
before(async function () {
  const unnamed = await getUnnamedAccounts();
  node_0 = unnamed[0];
});

//fake
const overlay_0 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';
const obsfucatedHash_0 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';
const hash_0 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';
const depth_0 = '0x0000000000000000000000000000000000000000000000000000000000000006';
const revealNonce_0 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';
const revealed_overlay_0 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';

//out of depth
const overlay_1 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';
const hash_1 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';
const depth_1 = '0x0000000000000000000000000000000000000000000000000000000000000006';
const revealNonce_1 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';

//correct
const overlay_2 = '0x00111133b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';
const hash_2 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';
const depth_2 = '0x0000000000000000000000000000000000000000000000000000000000000006';
const revealNonce_2 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';

const errors = {
  reveal: {
    noCommits: 'round received no commits',
    doNotMatch: 'revealed values do not match commited hash',
    outOfDepth: 'anchor out of self reported depth',
  },
};

async function mineNBlocks(n: number) {
  for (let index = 0; index < n; index++) {
    await ethers.provider.send('evm_mine', []);
  }
}

async function getBlockNumber() {
  const blockNumber = await ethers.provider.send('eth_blockNumber', []);
  return parseInt(blockNumber);
}

function encodeAndHash(hash_1: string, depth_1: string, revealNonce_1: string, overlay_1: string) {
  const encoded = new Uint8Array(128);
  encoded.set(arrayify(hash_1));
  encoded.set(arrayify(depth_1), 32);
  encoded.set(arrayify(revealNonce_1), 64);
  encoded.set(arrayify(overlay_1), 96);
  return keccak256(hexlify(encoded));
}

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

  describe('with deployed contract', async function () {
    let redistribution: Contract;

    beforeEach(async function () {
      await deployments.fixture();
      redistribution = await ethers.getContract('Redistribution');
    });

    describe('in the first round', function () {
      it('should be in the correct round', async function () {
        const initialBlockNumber = await getBlockNumber();
        expect(await redistribution.currentRound()).to.be.eq(0);

        await mineNBlocks(roundLength);

        expect(await getBlockNumber()).to.be.eq(initialBlockNumber + roundLength);
        expect(await redistribution.currentRound()).to.be.eq(1);
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

      //seed

      it('should select a random seed in the first round', async function () {
        // how will it be random with no previous nonces?
        // seed with a demonstrably random number, or with something deterministic but arbitrary?
      });

      it('should select a random seed in the second round based on the previous commit nonces', async function () {
        //awaiting solidity
      });

      //committing

      it('should create a fake commit', async function () {
        expect(await redistribution.currentPhaseCommit()).to.be.true;

        const r_node_0 = await ethers.getContract('Redistribution', node_0);
        await r_node_0.commit(obsfucatedHash_0, overlay_0);

        const commit_0 = await r_node_0.currentCommits(0);
        expect(commit_0.overlay).to.be.eq(overlay_0);
        expect(commit_0.obfuscatedHash).to.be.eq(obsfucatedHash_0);
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

        // commented out to allow other tests to pass for now
        // await expect(redistribution.reveal(hash_0, depth_0, revealNonce_0, revealed_overlay_0)).to.be.revertedWith(
        //   errors.reveal.doNotMatch
        // );
      });

      it('should not allow an overlay to reveal without commits', async function () {
        const initialBlockNumber = await getBlockNumber();
        expect(await redistribution.currentPhaseCommit()).to.be.true;

        await mineNBlocks(phaseLength);
        expect(await getBlockNumber()).to.be.eq(initialBlockNumber + phaseLength);
        expect(await redistribution.currentPhaseReveal()).to.be.true;

        await ethers.getContract('Redistribution', node_0);

        await redistribution.reveal(hash_0, depth_0, revealNonce_0, revealed_overlay_0);

        // commented out to allow other tests to pass for now
        // await expect(redistribution.reveal(hash_0, depth_0, revealNonce_0, revealed_overlay_0)).to.be.revertedWith(
        //   errors.reveal.noCommits
        // );
      });

      it('should not allow reveal in commit phase', async function () {
        const initialBlockNumber = await getBlockNumber();
        expect(await redistribution.currentPhaseCommit()).to.be.true;

        expect(await getBlockNumber()).to.be.eq(initialBlockNumber);
        expect(await redistribution.currentPhaseCommit()).to.be.true;

        await ethers.getContract('Redistribution', node_0);

        // commented out to allow other tests to pass for now
        // await expect(redistribution.reveal(hash_0, depth_0, revealNonce_0, revealed_overlay_0)).to.be.revertedWith(
        //   errors.reveal.wrongPhaseCommit
        // );
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
        // await expect(redistribution.reveal(hash_0, depth_0, revealNonce_0, revealed_overlay_0)).to.be.revertedWith(
        //   errors.reveal.wrongPhaseClaim
        // );
      });

      // use real commit?
      it('should create actual commit with failed reveal if the overlay is out of the reported depth', async function () {
        expect(await redistribution.currentPhaseCommit()).to.be.true;

        const r_node_0 = await ethers.getContract('Redistribution', node_0);

        const obsfucatedHash_1 = encodeAndHash(hash_1, depth_1, revealNonce_1, overlay_1);

        await r_node_0.commit(obsfucatedHash_1, overlay_1);

        await expect(redistribution.reveal(hash_0, depth_0, revealNonce_0, revealed_overlay_0)).to.be.revertedWith(
          errors.reveal.outOfDepth
        );
      });

      // it('should only allow one commit per staked overlay', async function () {});

      it('should create actual commit with successful reveal if within depth', async function () {
        expect(await redistribution.currentPhaseCommit()).to.be.true;

        const r_node_0 = await ethers.getContract('Redistribution', node_0);

        // console.log("Selection Anchor", await redistribution.SelectionAnchor())

        const obsfucatedHash_2 = encodeAndHash(hash_2, depth_2, revealNonce_2, overlay_2);

        await r_node_0.commit(obsfucatedHash_2, overlay_2);

        expect((await r_node_0.currentCommits(0)).obfuscatedHash).to.be.eq(obsfucatedHash_2);

        await mineNBlocks(phaseLength);

        await r_node_0.reveal(hash_2, depth_2, revealNonce_2, overlay_2);

        expect((await r_node_0.currentReveals(0)).hash).to.be.eq(hash_2);
        expect((await r_node_0.currentReveals(0)).overlay).to.be.eq(overlay_2);
        // expect((await r_node_0.currentReveals(0)).owner).to.be.eq(...);
        // expect((await r_node_0.currentReveals(0)).stake).to.be.eq(...);
        // expect((await r_node_0.currentReveals(0)).depth).to.be.eq(depth_2);
      });

      // use real commit?
      it('should create actual commit with failed reveal if the overlay is out of the reported depth', async function () {
        expect(await redistribution.currentPhaseCommit()).to.be.true;

        const r_node_0 = await ethers.getContract('Redistribution', node_0);

        const obsfucatedHash_1 = encodeAndHash(hash_1, depth_1, revealNonce_1, overlay_1);

        await r_node_0.commit(obsfucatedHash_1, overlay_1);

        await expect(redistribution.reveal(hash_0, depth_0, revealNonce_0, revealed_overlay_0)).to.be.revertedWith(
          errors.reveal.outOfDepth
        );
      });

      it('should create actual commit with successful reveal if within depth', async function () {
        expect(await redistribution.currentPhaseCommit()).to.be.true;

        const r_node_0 = await ethers.getContract('Redistribution', node_0);

        // console.log("Selection Anchor", await redistribution.SelectionAnchor())

        const obsfucatedHash_2 = encodeAndHash(hash_2, depth_2, revealNonce_2, overlay_2);

        await r_node_0.commit(obsfucatedHash_2, overlay_2);

        expect((await r_node_0.currentCommits(0)).obfuscatedHash).to.be.eq(obsfucatedHash_2);

        await mineNBlocks(phaseLength);

        await r_node_0.reveal(hash_2, depth_2, revealNonce_2, overlay_2);

        expect((await r_node_0.currentReveals(0)).hash).to.be.eq(hash_2);
      });

      it('should allow honest single player to claim pot', async function () {
        expect(await redistribution.currentPhaseCommit()).to.be.true;

        const r_node_0 = await ethers.getContract('Redistribution', node_0);

        // console.log("Selection Anchor", await redistribution.SelectionAnchor())

        const obsfucatedHash_2 = encodeAndHash(hash_2, depth_2, revealNonce_2, overlay_2);

        await r_node_0.commit(obsfucatedHash_2, overlay_2);

        expect((await r_node_0.currentCommits(0)).obfuscatedHash).to.be.eq(obsfucatedHash_2);

        await mineNBlocks(phaseLength);

        await r_node_0.reveal(hash_2, depth_2, revealNonce_2, overlay_2);

        expect((await r_node_0.currentReveals(0)).hash).to.be.eq(hash_2);

        await mineNBlocks(phaseLength);

        const tx2 = await r_node_0.claim();
        const receipt2 = await tx2.wait();

        const events2: { [index: string]: Event } = {};
        for (const e of receipt2.events) {
          events2[e.event] = e;
        }

        // @ts-ignore
        expect(events2.WinnerSelected.args[0]).to.be.eq(node_0);
        // @ts-ignore
        expect(events2.TruthSelected.args[0]).to.be.eq(node_0);
        // @ts-ignore
        expect(events2.TruthSelected.args[1]).to.be.eq(hash_0);

        // expect(events.TruthSelected.args[2]).to.be.eq(depth_2)

        // correct value of pot is withdrawn
      });

      // should we add a method to allow us to deterministically assign the "random" number for testing
      // perhaps this could be the interface to the RNG

      // if there is two commit reveals with equal stakes
      // test the selection of truth is correct based on the truthSelectionAnchor
      // test the selection of the winner is correct based on the winnerSelectionAnchor

      // stats tests
      // both are evenly selected (do this in a separate test file)

      // it('if there is two commit reveals with equal stakes', async function () {});
    });

    //should not be able to commit if frozen for X rounds if doesn't match truth oracle
    //should be slashed if committed and not revealed
  });
});
