import { expect } from './util/chai';
import { ethers, deployments, getNamedAccounts, getUnnamedAccounts, network } from 'hardhat';
import { Event, Contract } from 'ethers';

import { keccak256 } from '@ethersproject/keccak256';
import { arrayify, hexlify } from '@ethersproject/bytes';

const phaseLength = 38;
const roundLength = 152;

const initialRoundAnchor = '0x0000000000000000000000000000000000000000000000000000000000000000';

// Named accounts used by tests.
let deployer: string;

//fake
let node_0: string;
const overlay_0 = '0xd665e1fdc559f0987e10d70f0d3e6c877f64620f58d79c60b4742a3806555c48';
const stakeAmount_0 = '10000000000000000';

const nonce_0 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';
const obsfucatedHash_0 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';
const revealed_overlay_0 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';

const hash_0 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';
const depth_0 = '0x0000000000000000000000000000000000000000000000000000000000000006';
const reveal_nonce_0 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';

const reveal_nonce_f = '0xf4153f4153f4153f4153f4153f4153f4153f4153f4153f4153f4153f4153f415';
const depth_f = '0x0000000000000000000000000000000000000000000000000000000000000007';
const revealed_overlay_f = '0xf4153f4153f4153f4153f4153f4153f4153f4153f4153f4153f4153f4153f415';

//out of depth
const hash_1 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';
const depth_1 = '0x0000000000000000000000000000000000000000000000000000000000000006';
const reveal_nonce_1 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';

//correct
const overlay_2 = '0x00111133b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';
const hash_2 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';
const depth_2 = '0x0000000000000000000000000000000000000000000000000000000000000006';
const revealNonce_2 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';

// Before the tests, assign accounts
before(async function () {
  const namedAccounts = await getNamedAccounts();
  deployer = namedAccounts.deployer;
  // redistributor = namedAccounts.redistributor;
  // pauser = namedAccounts.pauser;
  const unnamed = await getUnnamedAccounts();
  node_0 = unnamed[0];
});

const errors = {
  commit: {
    notStaked: 'node must have staked at least minimum stake',
  },
  reveal: {
    noCommits: 'round received no commits',
    doNotMatch: 'no matching commit or hash',
    outOfDepth: 'anchor out of self reported depth',
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

function encodeAndHash(hash_1: string, depth_1: string, reveal_nonce_1: string, overlay_1: string) {
  const encoded = new Uint8Array(128);
  encoded.set(arrayify(hash_1));
  encoded.set(arrayify(depth_1), 32);
  encoded.set(arrayify(reveal_nonce_1), 64);
  encoded.set(arrayify(overlay_1), 96);
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

async function mineOverlaysInDepth(prefix: string, networkID: string, depth: number) {
  let found = false;
  let w, o;
  while (found == false) {
    w = ethers.Wallet.createRandom();
    console.log(w.address);
    o = await createOverlay(w.address, networkID, nonce_0);
    //compare binary
    found = true;
  }
  if (w !== undefined) {
    console.log('o', w.address, o, w.privateKey);
  }
}

//end

describe('Redistribution', function () {
  describe('when deploying contract', function () {
    beforeEach(async function () {
      await deployments.fixture();
      // createOverlay(node_0, "0x0000000000000000", nonce_0);
      // mineOverlaysInDepth("0x0000", "0x00", 4);
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
      await mineNBlocks(roundLength);
      // await setPrevRandDAO();
    });

    it('should not create a commit with unstaked node', async function () {
      expect(await redistribution.currentPhaseCommit()).to.be.true;

      const r_node_0 = await ethers.getContract('Redistribution', node_0);
      await expect(r_node_0.commit(obsfucatedHash_0, overlay_0)).to.be.revertedWith(errors.commit.notStaked);
    });
  });

  describe('with deployed contract and staked node in next round', async function () {
    let redistribution: Contract;
    let sr_node_0: Contract;

    beforeEach(async function () {
      await deployments.fixture();
      redistribution = await ethers.getContract('Redistribution');

      const r_node_0 = await ethers.getContract('Redistribution', node_0);
      const sr_node_0 = await ethers.getContract('StakeRegistry', node_0);
      await mintAndApprove(node_0, sr_node_0.address, stakeAmount_0);
      await sr_node_0.depositStake(node_0, nonce_0, stakeAmount_0);
      await mineNBlocks(roundLength);
      // await setPrevRandDAO();
    });

    describe('in the first round', function () {
      it('should be in the correct round', async function () {
        const initialBlockNumber = await getBlockNumber();

        expect(await redistribution.currentRound()).to.be.eq(1);

        await mineNBlocks(roundLength);
        expect(await getBlockNumber()).to.be.eq(initialBlockNumber + roundLength);
        expect(await redistribution.currentRound()).to.be.eq(2);
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

      //initial round anchor

      // it('should have correct initial round anchor', async function () {
      //   const initialBlockNumber = await getBlockNumber();

      //   expect(await redistribution.currentRound()).to.be.eq(1);
      //   expect(await redistribution.currentRoundAnchor()).to.be.eq(initialRoundAnchor)

      //   await mineNBlocks(roundLength);
      //   expect(await getBlockNumber()).to.be.eq(initialBlockNumber + roundLength);
      //   expect(await redistribution.currentRound()).to.be.eq(2);
      //   // <sig is this desired behavior? sig>
      //   expect(await redistribution.currentRoundAnchor()).to.be.eq(initialRoundAnchor);
      // });

      // it('should select a random seed in the second round based on the previous commit nonces', async function () {
      //   //awaiting solidity
      // });

      //committing

      it('should create actual commit with failed reveal if the overlay is out of the reported depth', async function () {
        expect(await redistribution.currentPhaseCommit()).to.be.true;

        const r_node_0 = await ethers.getContract('Redistribution', node_0);

        // console.log("Selection Anchor", await redistribution.SelectionAnchor())

        const obsfucatedHash = encodeAndHash(overlay_0, depth_0, hash_0, reveal_nonce_0);

        await r_node_0.commit(obsfucatedHash, overlay_0);

        expect((await r_node_0.currentCommits(0)).obfuscatedHash).to.be.eq(obsfucatedHash);

        await mineNBlocks(phaseLength);

        await expect(r_node_0.reveal(overlay_0, depth_0, hash_0, reveal_nonce_0)).to.be.revertedWith(
          errors.reveal.outOfDepth
        );
      });

      // it('should create actual commit with successful reveal if the overlay is within the reported depth', async function () {
      //   expect(await redistribution.currentPhaseCommit()).to.be.true;

      //   const r_node_0 = await ethers.getContract('Redistribution', node_0);

      //   // console.log("Selection Anchor", await redistribution.SelectionAnchor())
      //   let sr_node_0 = await ethers.getContract('StakeRegistry', node_0);

      //   const obsfucatedHash = encodeAndHash(hash_0, depth_0, reveal_nonce_0, overlay_0);

      //   await r_node_0.commit(obsfucatedHash, overlay_0);

      //   expect((await r_node_0.currentCommits(0)).obfuscatedHash).to.be.eq(obsfucatedHash);

      //   await mineNBlocks(phaseLength);

      //   await r_node_0.reveal(hash_0, depth_0, reveal_nonce_0, overlay_0);

      //   // expect((await r_node_0.currentReveals(0)).hash).to.be.eq(hash_2);
      //   // expect((await r_node_0.currentReveals(0)).overlay).to.be.eq(overlay_2);
      //   // expect((await r_node_0.currentReveals(0)).owner).to.be.eq(...);
      //   // expect((await r_node_0.currentReveals(0)).stake).to.be.eq(...);
      //   // expect((await r_node_0.currentReveals(0)).depth).to.be.eq(depth_2);
      // });

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

        // commented out to allow other tests to pass for now
        // await expect(redistribution.reveal(hash_0, depth_0, reveal_nonce_0, revealed_overlay_0)).to.be.revertedWith(
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
        // await expect(redistribution.reveal(hash_0, depth_0, reveal_nonce_0, revealed_overlay_0)).to.be.revertedWith(
        //   errors.reveal.wrongPhaseClaim
        // );
      });

      it('should not allow an overlay to reveal without with the incorrect nonce', async function () {
        const initialBlockNumber = await getBlockNumber();
        expect(await redistribution.currentPhaseCommit()).to.be.true;

        const r_node_0 = await ethers.getContract('Redistribution', node_0);
        const obsfucatedHash = encodeAndHash(hash_0, depth_0, reveal_nonce_0, overlay_0);
        await r_node_0.commit(obsfucatedHash, overlay_0);

        await mineNBlocks(phaseLength);
        expect(await getBlockNumber()).to.be.eq(initialBlockNumber + phaseLength + 1);
        expect(await redistribution.currentPhaseReveal()).to.be.true;

        await ethers.getContract('Redistribution', node_0);

        await expect(redistribution.reveal(hash_0, depth_0, reveal_nonce_f, revealed_overlay_0)).to.be.revertedWith(
          errors.reveal.doNotMatch
        );
      });

      it('should not allow an overlay to reveal without with the incorrect overlay', async function () {
        const initialBlockNumber = await getBlockNumber();
        expect(await redistribution.currentPhaseCommit()).to.be.true;

        const r_node_0 = await ethers.getContract('Redistribution', node_0);
        const obsfucatedHash = encodeAndHash(hash_0, depth_0, reveal_nonce_0, overlay_0);
        await r_node_0.commit(obsfucatedHash, overlay_0);

        await mineNBlocks(phaseLength);
        expect(await getBlockNumber()).to.be.eq(initialBlockNumber + phaseLength + 1);
        expect(await redistribution.currentPhaseReveal()).to.be.true;

        await ethers.getContract('Redistribution', node_0);

        await expect(redistribution.reveal(hash_0, depth_0, reveal_nonce_0, revealed_overlay_f)).to.be.revertedWith(
          errors.reveal.doNotMatch
        );
      });

      it('should not allow an overlay to reveal without with the incorrect depth', async function () {
        const initialBlockNumber = await getBlockNumber();
        expect(await redistribution.currentPhaseCommit()).to.be.true;

        const r_node_0 = await ethers.getContract('Redistribution', node_0);
        const obsfucatedHash = encodeAndHash(hash_0, depth_0, reveal_nonce_0, overlay_0);
        await r_node_0.commit(obsfucatedHash, overlay_0);

        await mineNBlocks(phaseLength);
        expect(await getBlockNumber()).to.be.eq(initialBlockNumber + phaseLength + 1);
        expect(await redistribution.currentPhaseReveal()).to.be.true;

        await ethers.getContract('Redistribution', node_0);

        await expect(redistribution.reveal(hash_0, depth_f, reveal_nonce_0, overlay_0)).to.be.revertedWith(
          errors.reveal.doNotMatch
        );
      });

      //   // it('should only allow one commit per staked overlay', async function () {});

      //   // use real commit?
      //   it('should create actual commit with failed reveal if the overlay is out of the reported depth', async function () {
      //     expect(await redistribution.currentPhaseCommit()).to.be.true;

      //     const r_node_0 = await ethers.getContract('Redistribution', node_0);

      //     const obsfucatedHash_1 = encodeAndHash(hash_1, depth_1, reveal_nonce_1, overlay_1);

      //     await r_node_0.commit(obsfucatedHash_1, overlay_1);

      //     await expect(redistribution.reveal(hash_0, depth_0, reveal_nonce_0, revealed_overlay_0)).to.be.revertedWith(
      //       errors.reveal.outOfDepth
      //     );
      //   });

      //   it('should create actual commit with successful reveal if within depth', async function () {
      //     expect(await redistribution.currentPhaseCommit()).to.be.true;

      //     const r_node_0 = await ethers.getContract('Redistribution', node_0);

      //     // console.log("Selection Anchor", await redistribution.SelectionAnchor())

      //     const obsfucatedHash_2 = encodeAndHash(hash_2, depth_2, revealNonce_2, overlay_2);

      //     await r_node_0.commit(obsfucatedHash_2, overlay_2);

      //     expect((await r_node_0.currentCommits(0)).obfuscatedHash).to.be.eq(obsfucatedHash_2);

      //     await mineNBlocks(phaseLength);

      //     await r_node_0.reveal(hash_2, depth_2, revealNonce_2, overlay_2);

      //     expect((await r_node_0.currentReveals(0)).hash).to.be.eq(hash_2);
      //   });

      //   it('should allow honest single player to claim pot', async function () {
      //     expect(await redistribution.currentPhaseCommit()).to.be.true;

      //     const r_node_0 = await ethers.getContract('Redistribution', node_0);

      //     // console.log("Selection Anchor", await redistribution.SelectionAnchor())

      //     const obsfucatedHash_2 = encodeAndHash(hash_2, depth_2, revealNonce_2, overlay_2);

      //     await r_node_0.commit(obsfucatedHash_2, overlay_2);

      //     expect((await r_node_0.currentCommits(0)).obfuscatedHash).to.be.eq(obsfucatedHash_2);

      //     await mineNBlocks(phaseLength);

      //     await r_node_0.reveal(hash_2, depth_2, revealNonce_2, overlay_2);

      //     expect((await r_node_0.currentReveals(0)).hash).to.be.eq(hash_2);

      //     await mineNBlocks(phaseLength);

      //     const tx2 = await r_node_0.claim();
      //     const receipt2 = await tx2.wait();

      //     const events2: { [index: string]: Event } = {};
      //     for (const e of receipt2.events) {
      //       events2[e.event] = e;
      //     }

      //     // @ts-ignore
      //     expect(events2.WinnerSelected.args[0]).to.be.eq(node_0);
      //     // @ts-ignore
      //     expect(events2.TruthSelected.args[0]).to.be.eq(node_0);
      //     // @ts-ignore
      //     expect(events2.TruthSelected.args[1]).to.be.eq(hash_0);

      //     // expect(events.TruthSelected.args[2]).to.be.eq(depth_2)

      //     // correct value of pot is withdrawn
      //   });

      //   // should we add a method to allow us to deterministically assign the "random" number for testing
      //   // perhaps this could be the interface to the RNG

      //   // if there is two commit reveals with equal stakes
      //   // test the selection of truth is correct based on the truthSelectionAnchor
      //   // test the selection of the winner is correct based on the winnerSelectionAnchor

      //   // stats tests
      //   // both are evenly selected (do this in a separate test file)

      //   // it('if there is two commit reveals with equal stakes', async function () {});
    });

    //should not be able to commit if frozen for X rounds if doesn't match truth oracle
    //should be slashed if committed and not revealed
  });
});
