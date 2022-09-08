import { expect } from './util/chai';
import { ethers, deployments, getNamedAccounts, getUnnamedAccounts } from 'hardhat';
import { Contract, Signer } from 'ethers';

const phaseLength = 38;
const roundLength = 146;

// Named accounts used by tests.
let node_0: string;
let node_1: string;
let node_2: string;

// Before the tests, assign accounts
before(async function () {
  let unnamed = await getUnnamedAccounts();
  node_0 = unnamed[0];
  node_1 = unnamed[1];
  node_2 = unnamed[2];
});

let overlay_0 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';
let obsfucatedHash_0 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';
let hash_0 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';
let depth_0 = 6;
let revealNonce_0 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';
let revealed_overlay_0 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';

let errors = {
  reveal: {
    noCommits: 'round received no commits',
    doNotMatch: 'revealed values do not match commited hash',
  },
};

async function mineNBlocks(n: number) {
  for (let index = 0; index < n; index++) {
    await ethers.provider.send('evm_mine', []);
  }
}

async function getBlockNumber() {
  let blockNumber = await ethers.provider.send('eth_blockNumber', []);
  return parseInt(blockNumber);
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
        let initialBlockNumber = await getBlockNumber();
        expect(await redistribution.currentRound()).to.be.eq(0);

        await mineNBlocks(roundLength);

        expect(await getBlockNumber()).to.be.eq(initialBlockNumber+roundLength);
        expect(await redistribution.currentRound()).to.be.eq(1);
      });

      it('should be in the correct phase', async function () {
        let initialBlockNumber = await getBlockNumber();
        expect(await redistribution.currentPhaseCommit()).to.be.true;

        await mineNBlocks(phaseLength);
        expect(await getBlockNumber()).to.be.eq(initialBlockNumber+phaseLength);
        expect(await redistribution.currentPhaseReveal()).to.be.true;

        await mineNBlocks(phaseLength);
        expect(await getBlockNumber()).to.be.eq(initialBlockNumber+(2*phaseLength));
        expect(await redistribution.currentPhaseClaim()).to.be.true;
      });

      it('should not allow reveal without commits', async function () {
        let initialBlockNumber = await getBlockNumber();
        expect(await redistribution.currentPhaseCommit()).to.be.true;

        await mineNBlocks(phaseLength);
        expect(await getBlockNumber()).to.be.eq(initialBlockNumber+phaseLength);
        expect(await redistribution.currentPhaseReveal()).to.be.true;

        let r_node_0 = await ethers.getContract('Redistribution', node_0);

        await redistribution.reveal(hash_0, depth_0, revealNonce_0, revealed_overlay_0);

        await expect(redistribution.reveal(hash_0, depth_0, revealNonce_0, revealed_overlay_0)).to.be.revertedWith(
          errors.reveal.noCommits
        );
      });

      it('should create fake commit', async function () {
        let initialBlockNumber = await getBlockNumber();
        expect(await redistribution.currentPhaseCommit()).to.be.true;

        let r_node_0 = await ethers.getContract('Redistribution', node_0);
        await r_node_0.commit(obsfucatedHash_0, overlay_0);

        let commit_0 = await r_node_0.currentCommits(0);
        expect(commit_0.overlay).to.be.eq(overlay_0);
        expect(commit_0.obfuscatedHash).to.be.eq(obsfucatedHash_0);

        expect(await getBlockNumber()).to.be.eq(initialBlockNumber+1);
      });

      it('should create fake commit with failed reveal', async function () {
        let initialBlockNumber = await getBlockNumber();
        expect(await redistribution.currentPhaseCommit()).to.be.true;

        let r_node_0 = await ethers.getContract('Redistribution', node_0);
        await r_node_0.commit(obsfucatedHash_0, overlay_0);

        let commit_0 = await r_node_0.currentCommits(0);
        expect(commit_0.overlay).to.be.eq(overlay_0);
        expect(commit_0.obfuscatedHash).to.be.eq(obsfucatedHash_0);

        expect(await getBlockNumber()).to.be.eq(initialBlockNumber+1);

        await mineNBlocks(phaseLength);

        expect(await getBlockNumber()).to.be.eq(initialBlockNumber+1+phaseLength);
        expect(await redistribution.currentPhaseReveal()).to.be.true;

        await expect(redistribution.reveal(hash_0, depth_0, revealNonce_0, revealed_overlay_0)).to.be.revertedWith(
          errors.reveal.doNotMatch
        );
      });
    });
  });
});
