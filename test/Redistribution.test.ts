import { expect } from './util/chai';
import { ethers, deployments, getNamedAccounts } from 'hardhat';
import { BigNumber, Contract } from 'ethers';
import {
  mineNBlocks,
  getBlockNumber,
  encodeAndHash,
  mintAndApprove,
  ZERO_32_BYTES,
  nextAnchorIfNoReveal,
  startRoundFixture,
  copyBatchForClaim,
  mineToRevealPhase,
  calculateStakeDensity,
} from './util/tools';
import { proximity } from './util/tools';
import { node5_proof1 } from './claim-proofs';

const { read, execute } = deployments;
const phaseLength = 38;
const roundLength = 152;

const increaseRate = [0, 1036, 1027, 1025, 1024, 1023, 1021, 1017, 1012];

// round anchor after startRoundFixture()
const round2Anchor = '0xac33ff75c19e70fe83507db0d683fd3465c996598dc972688b7ace676c89077b';
// start round number after mintToNode(red, 0) -> without claim
const roundAnchorBase = '0xa54b3e90672405a607381bd4d34034a12c5aad31607067a7ad26573f504ad6e2';

const maxInt256 = 0xffff; //js can't handle the full maxInt256 value

// Named accounts used by tests.
let deployer: string, stamper: string, pauser: string;

let node_0: string;
const overlay_0 = '0xa602fa47b3e8ce39ffc2017ad9069ff95eb58c051b1cfa2b0d86bc44a5433733';
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

let node_1: string;
const overlay_1 = '0xa6f955c72d7053f96b91b5470491a0c732b0175af56dcfb7a604b82b16719406';
const overlay_1_n_25 = '0x676766bbae530fd0483e4734e800569c95929b707b9c50f8717dc99f9f91e915';
const stakeAmount_1 = '100000000000000000';
const nonce_1 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';
const nonce_1_n_25 = '0x00000000000000000000000000000000000000000000000000000000000325dd';
const hash_1 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';
const depth_1 = '0x06';
const reveal_nonce_1 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';

let node_2: string;
const overlay_2 = '0xa40db58e368ea6856a24c0264ebd73b049f3dc1c2347b1babc901d3e09842dec';
const stakeAmount_2 = '100000000000000000';
const nonce_2 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';
const hash_2 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';
const depth_2 = '0x06';
const reveal_nonce_2 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';

let node_3: string;
const overlay_3 = '0xaf217eb0d652baf39ec9464a350c7afc812743fd75ccadf4fcceb6d19a1f190c';
const stakeAmount_3 = '100000000000000000';
const nonce_3 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';
const hash_3 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';
const depth_3 = '0x06';
const reveal_nonce_3 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';

let node_4: string;
const overlay_4 = '0xaedb2a8007316805b4d64b249ea39c5a1c4a9ce51dc8432724241f41ecb02efb';
const nonce_4 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';
const depth_4 = '0x06';
// FDP Play node keys - claim data
// queen node
let node_5: string;
const overlay_5 = '0x676720d79d609ed462fadf6f14eb1bf9ec1a90999dd45a671d79a89c7b5ac9d8';
const stakeAmount_5 = '100000000000000000';
const nonce_5 = '0x0000000000000000000000000000000000000000000000000000000000003ba6';
const reveal_nonce_5 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';
const { depth: depth_5, hash: hash_5 } = node5_proof1;

// start round number after startRoundFixture()
const startRoundNumber = 3;
// start round number after mintToNode(red, 0) -> without claim
const startRndNumBase = 38;

/**
 * Mines blocks until the given node's neighbourhood
 * @param redistribution inited Redistribution contract
 * @param nodeNo node's index in the top-level defined node data.
 */
const mineToNode = async (redistribution: Contract, nodeNo: number) => {
  let currentSeed = await redistribution.currentSeed();
  while (proximity(currentSeed, eval(`overlay_${nodeNo}`)) < Number(eval(`depth_${nodeNo}`))) {
    await mineNBlocks(roundLength);
    currentSeed = await redistribution.currentSeed();
  }
};

// Before the tests, assign accounts
before(async function () {
  const namedAccounts = await getNamedAccounts();
  deployer = namedAccounts.deployer;
  stamper = namedAccounts.stamper;
  pauser = namedAccounts.pauser;
  node_0 = namedAccounts.node_0;
  node_1 = namedAccounts.node_1;
  node_2 = namedAccounts.node_2;
  node_3 = namedAccounts.node_3;
  node_4 = namedAccounts.node_4;
  node_5 = namedAccounts.node_5;
});

const errors = {
  commit: {
    notOwner: 'NotMatchingOwner()',
    notStaked: 'BelowMinimumStake()',
    stakedRecently: 'MustStake2Rounds()',
    alreadyCommited: 'AlreadyCommited()',
  },
  reveal: {
    noCommits: 'NoCommitsReceived()',
    doNotMatch: 'NoMatchingCommit()',
    outOfDepth: 'OutOfDepth()',
    notInReveal: 'NotRevealPhase()',
  },
  claim: {
    noReveals: 'NoReveals()',
    alreadyClaimed: 'AlreadyClaimed()',
  },
};

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

    beforeEach(async function () {
      await deployments.fixture();
      redistribution = await ethers.getContract('Redistribution');
      await mineNBlocks(roundLength * 2);
      // await setPrevRandDAO();
    });

    it('should not create a commit with unstaked node', async function () {
      expect(await redistribution.currentPhaseCommit()).to.be.true;

      const r_node_0 = await ethers.getContract('Redistribution', node_0);
      const currentRound = await r_node_0.currentRound();
      await expect(r_node_0.commit(obsfucatedHash_0, overlay_0, currentRound)).to.be.revertedWith(
        errors.commit.notStaked
      );
    });

    it('should not create a commit with recently staked node', async function () {
      const sr_node_0 = await ethers.getContract('StakeRegistry', node_0);
      await mintAndApprove(deployer, node_0, sr_node_0.address, stakeAmount_0);
      await sr_node_0.depositStake(node_0, nonce_0, stakeAmount_0);

      expect(await redistribution.currentPhaseCommit()).to.be.true;

      const r_node_0 = await ethers.getContract('Redistribution', node_0);
      await expect(r_node_0.isParticipatingInUpcomingRound(overlay_0, depth_0)).to.be.revertedWith(
        errors.commit.stakedRecently
      );
    });

    it('should create a commit with staked node', async function () {
      const sr_node_0 = await ethers.getContract('StakeRegistry', node_0);
      await mintAndApprove(deployer, node_0, sr_node_0.address, stakeAmount_0);
      await sr_node_0.depositStake(node_0, nonce_0, stakeAmount_0);

      expect(await redistribution.currentPhaseCommit()).to.be.true;

      const r_node_0 = await ethers.getContract('Redistribution', node_0);
      await expect(r_node_0.isParticipatingInUpcomingRound(overlay_0, depth_0)).to.be.revertedWith(
        errors.commit.stakedRecently
      );
    });
  });

  describe('with deployed contract and staked node in next round', async function () {
    let redistribution: Contract;
    let token: Contract;
    let postage: Contract;
    const price1 = 2048;
    const batch = {
      nonce: '0x000000000000000000000000000000000000000000000000000000000000abcd',
      initialPaymentPerChunk: 2000000000,
      depth: 17,
      bucketDepth: 16,
      immutable: false,
      blocks: 100,
    };
    let stampCreatedBlock: number;

    beforeEach(async function () {
      await deployments.fixture();
      redistribution = await ethers.getContract('Redistribution');
      token = await ethers.getContract('TestToken', deployer);

      const pauserRole = await read('StakeRegistry', 'PAUSER_ROLE');
      await execute('StakeRegistry', { from: deployer }, 'grantRole', pauserRole, pauser);

      //initialise, set minimum price, todo: move to deployment
      const priceOracle = await ethers.getContract('PriceOracle', deployer);
      await priceOracle.setPrice(price1);

      const batchSize = 2 ** batch.depth;
      const transferAmount = batch.initialPaymentPerChunk * batchSize;

      postage = await ethers.getContract('PostageStamp', stamper);

      await mintAndApprove(deployer, stamper, postage.address, transferAmount.toString());

      await postage.expireLimited(maxInt256); //for testing
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
      await mintAndApprove(deployer, node_0, sr_node_0.address, stakeAmount_0);
      await sr_node_0.depositStake(node_0, nonce_0, stakeAmount_0);

      const sr_node_1 = await ethers.getContract('StakeRegistry', node_1);
      await mintAndApprove(deployer, node_1, sr_node_1.address, stakeAmount_1);
      await sr_node_1.depositStake(node_1, nonce_1, stakeAmount_1);

      // 16 depth neighbourhood with node_5
      const sr_node_1_n_25 = await ethers.getContract('StakeRegistry', node_1);
      await mintAndApprove(deployer, node_1, sr_node_1_n_25.address, stakeAmount_1);
      await sr_node_1.depositStake(node_1, nonce_1_n_25, stakeAmount_1);

      const sr_node_2 = await ethers.getContract('StakeRegistry', node_2);
      await mintAndApprove(deployer, node_2, sr_node_2.address, stakeAmount_2);
      await sr_node_2.depositStake(node_2, nonce_2, stakeAmount_2);

      const sr_node_3 = await ethers.getContract('StakeRegistry', node_3);
      await mintAndApprove(deployer, node_3, sr_node_3.address, stakeAmount_3);
      await sr_node_3.depositStake(node_3, nonce_3, stakeAmount_3);

      const sr_node_4 = await ethers.getContract('StakeRegistry', node_4);
      await mintAndApprove(deployer, node_4, sr_node_4.address, stakeAmount_3);
      await sr_node_4.depositStake(node_4, nonce_4, stakeAmount_3);

      const sr_node_5 = await ethers.getContract('StakeRegistry', node_5);
      await mintAndApprove(deployer, node_5, sr_node_5.address, stakeAmount_5);
      await sr_node_5.depositStake(node_5, nonce_5, stakeAmount_5);

      await mineNBlocks(roundLength * 2);
      await startRoundFixture();
      // await setPrevRandDAO();
    });

    describe('round numbers and phases', function () {
      it('should be in the correct round', async function () {
        const initialBlockNumber = await getBlockNumber();

        expect(await redistribution.currentRound()).to.be.eq(startRoundNumber);

        await mineNBlocks(roundLength);
        expect(await getBlockNumber()).to.be.eq(initialBlockNumber + roundLength);
        expect(await redistribution.currentRound()).to.be.eq(startRoundNumber + 1);
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
        await mineNBlocks(1); //because strict equality enforcing time since staking
        await mineToNode(redistribution, 0);
        expect(await redistribution.currentRound()).to.be.eq(startRndNumBase);
        // 0xa6ee...
        const firstAnchor = await redistribution.currentRoundAnchor();
        expect(firstAnchor).to.be.eq(roundAnchorBase);

        expect(await redistribution.inProximity(roundAnchorBase, overlay_0, depth_0)).to.be.true;
        expect(await redistribution.inProximity(roundAnchorBase, overlay_1, depth_1)).to.be.true;
        expect(await redistribution.inProximity(roundAnchorBase, overlay_2, depth_2)).to.be.true;

        // 0xac33...
        expect(await redistribution.inProximity(roundAnchorBase, overlay_3, depth_3)).to.be.false;
        expect(await redistribution.inProximity(roundAnchorBase, overlay_4, depth_4)).to.be.false;

        // 0x00...
        expect(await redistribution.isParticipatingInUpcomingRound(overlay_0, depth_0)).to.be.true;
        expect(await redistribution.isParticipatingInUpcomingRound(overlay_1, depth_1)).to.be.true;
        expect(await redistribution.isParticipatingInUpcomingRound(overlay_2, depth_2)).to.be.true;

        // 0xa6...
        expect(await redistribution.isParticipatingInUpcomingRound(overlay_3, depth_3)).to.be.false;
        expect(await redistribution.isParticipatingInUpcomingRound(overlay_4, depth_4)).to.be.false;

        await mineNBlocks(roundLength);

        const roundNo = Number(await redistribution.currentRound());
        const nextAnchor = nextAnchorIfNoReveal(ZERO_32_BYTES, roundNo);
        expect(roundNo).to.be.eq(startRndNumBase + 1);
        expect(await redistribution.currentRoundAnchor()).to.be.eq(nextAnchor);

        await mineToNode(redistribution, 3);
        // test out anchor that mined to address satisfy inProximity and isParticipatingInUpcomingRound
        const nextAnchor2 = redistribution.currentSeed();

        expect(await redistribution.inProximity(nextAnchor2, overlay_0, depth_0)).to.be.false;
        expect(await redistribution.inProximity(nextAnchor2, overlay_1, depth_1)).to.be.false;
        expect(await redistribution.inProximity(nextAnchor2, overlay_2, depth_2)).to.be.false;

        expect(await redistribution.inProximity(nextAnchor2, overlay_3, depth_3)).to.be.true;
        expect(await redistribution.inProximity(nextAnchor2, overlay_4, depth_4)).to.be.true;

        expect(await redistribution.isParticipatingInUpcomingRound(overlay_0, depth_0)).to.be.false;
        expect(await redistribution.isParticipatingInUpcomingRound(overlay_1, depth_1)).to.be.false;
        expect(await redistribution.isParticipatingInUpcomingRound(overlay_2, depth_2)).to.be.false;

        expect(await redistribution.isParticipatingInUpcomingRound(overlay_3, depth_3)).to.be.true;
        expect(await redistribution.isParticipatingInUpcomingRound(overlay_4, depth_4)).to.be.true;
      });
    });

    describe('commit phase with no reveals', async function () {
      it('should have correct round anchors', async function () {
        expect(await redistribution.currentPhaseCommit()).to.be.true;
        expect(await redistribution.currentRound()).to.be.eq(startRoundNumber);
        expect(await redistribution.currentRoundAnchor()).to.be.eq(round2Anchor);

        await mineNBlocks(phaseLength);
        expect(await redistribution.currentPhaseReveal()).to.be.true;
        expect(await redistribution.currentRoundAnchor()).to.be.eq(round2Anchor);

        await mineNBlocks(phaseLength);
        const nextAnchor = nextAnchorIfNoReveal(ZERO_32_BYTES, startRoundNumber + 1);
        expect(await redistribution.currentPhaseClaim()).to.be.true;
        expect(await redistribution.currentRoundAnchor()).to.be.eq(nextAnchor);

        await mineNBlocks(phaseLength * 2);
        expect(await redistribution.currentRound()).to.be.eq(startRoundNumber + 1);
        expect(await redistribution.currentRoundAnchor()).to.be.eq(nextAnchor);
      });

      it('should create a commit with failed reveal if the overlay is out of reported depth', async function () {
        expect(await redistribution.currentPhaseCommit()).to.be.true;

        const r_node_3 = await ethers.getContract('Redistribution', node_3);
        expect(await redistribution.currentRoundAnchor()).to.be.eq(round2Anchor);

        const obsfucatedHash = encodeAndHash(overlay_3, '0x08', hash_3, reveal_nonce_3);
        expect(await r_node_3.wrapCommit(overlay_3, '0x08', hash_3, reveal_nonce_3)).to.be.eq(obsfucatedHash);

        const currentRound = await r_node_3.currentRound();
        await r_node_3.commit(obsfucatedHash, overlay_3, currentRound);
        expect((await r_node_3.currentCommits(0)).obfuscatedHash).to.be.eq(obsfucatedHash);

        await mineNBlocks(phaseLength);
        await expect(r_node_3.reveal(overlay_3, '0x08', hash_3, reveal_nonce_3)).to.be.revertedWith(
          errors.reveal.outOfDepth
        );
      });

      it('should create a commit with successful reveal if the overlay is within the reported depth', async function () {
        await mineToNode(redistribution, 2);
        expect(await redistribution.currentPhaseCommit()).to.be.true;

        const r_node_2 = await ethers.getContract('Redistribution', node_2);
        const obsfucatedHash = encodeAndHash(overlay_2, depth_2, hash_2, reveal_nonce_2);
        const currentRound = await r_node_2.currentRound();
        await expect(r_node_2.commit(obsfucatedHash, overlay_2, currentRound))
          .to.emit(redistribution, 'Committed')
          .withArgs(currentRound, overlay_2);
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
        const currentRound = await r_node_0.currentRound();
        await r_node_0.commit(obsfucatedHash_0, overlay_0, currentRound);
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
        const currentRound = await r_node_0.currentRound();
        await expect(r_node_0.commit(obsfucatedHash, overlay_2, currentRound)).to.be.revertedWith(
          errors.commit.notOwner
        );
      });

      it('should not allow duplicate commits', async function () {
        expect(await redistribution.currentPhaseCommit()).to.be.true;

        const r_node_2 = await ethers.getContract('Redistribution', node_2);
        const obsfucatedHash = encodeAndHash(overlay_2, depth_2, hash_2, reveal_nonce_2);
        const currentRound = await r_node_2.currentRound();
        await r_node_2.commit(obsfucatedHash, overlay_2, currentRound);
        expect((await r_node_2.currentCommits(0)).obfuscatedHash).to.be.eq(obsfucatedHash);

        await expect(r_node_2.commit(obsfucatedHash, overlay_2, currentRound)).to.be.revertedWith(
          errors.commit.alreadyCommited
        );
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
        const currentRound = await r_node_2.currentRound();
        await r_node_2.commit(obsfucatedHash, overlay_2, currentRound);
        await mineNBlocks(phaseLength);

        expect(await getBlockNumber()).to.be.eq(initialBlockNumber + phaseLength + 1);
        expect(await redistribution.currentPhaseReveal()).to.be.true;
        await expect(r_node_2.reveal(overlay_2, depth_2, hash_2, reveal_nonce_f)).to.be.revertedWith(
          errors.reveal.doNotMatch
        );
      });

      it('should not allow an overlay to reveal without with the incorrect overlay', async function () {
        const initialBlockNumber = await getBlockNumber();
        expect(await redistribution.currentPhaseCommit()).to.be.true;

        const r_node_2 = await ethers.getContract('Redistribution', node_2);
        const obsfucatedHash = encodeAndHash(overlay_2, depth_2, hash_2, reveal_nonce_2);

        const currentRound = await r_node_2.currentRound();
        await r_node_2.commit(obsfucatedHash, overlay_2, currentRound);

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

        const currentRound = await r_node_2.currentRound();
        await r_node_2.commit(obsfucatedHash, overlay_2, currentRound);

        await mineNBlocks(phaseLength);
        expect(await getBlockNumber()).to.be.eq(initialBlockNumber + phaseLength + 1);
        expect(await redistribution.currentPhaseReveal()).to.be.true;

        await expect(redistribution.reveal(overlay_2, depth_f, hash_2, reveal_nonce_2)).to.be.revertedWith(
          errors.reveal.doNotMatch
        );
      });

      describe('when pausing', function () {
        it('should not allow anybody but the pauser to pause', async function () {
          const redistributionContract = await ethers.getContract('Redistribution', stamper);
          await expect(redistributionContract.pause()).to.be.revertedWith('only pauser can pause');
        });
      });

      describe('when unpausing', function () {
        it('should unpause when pause and then unpause', async function () {
          const redistributionContract = await ethers.getContract('Redistribution', deployer);
          await redistributionContract.pause();
          await redistributionContract.unPause();
          expect(await redistributionContract.paused()).to.be.false;
        });

        it('should not allow anybody but the pauser to unpause', async function () {
          const redistributionContract = await ethers.getContract('Redistribution', deployer);
          await redistributionContract.pause();
          const redistributionContract2 = await ethers.getContract('Redistribution', stamper);
          await expect(redistributionContract2.unPause()).to.be.revertedWith('only pauser can unpause');
        });

        it('should not allow unpausing when not paused', async function () {
          const redistributionContract = await ethers.getContract('Redistribution', deployer);
          await expect(redistributionContract.unPause()).to.be.revertedWith('Pausable: not paused');
        });
      });

      it('should emit correct events', async function () {
        await mineToNode(redistribution, 2);
        const initialBlockNumber = await getBlockNumber();
        expect(await redistribution.currentPhaseCommit()).to.be.true;

        const r_node_2 = await ethers.getContract('Redistribution', node_2);
        const obsfucatedHash = encodeAndHash(overlay_2, depth_2, hash_2, reveal_nonce_2);

        const currentRound = await r_node_2.currentRound();
        await r_node_2.commit(obsfucatedHash, overlay_2, parseInt(currentRound));

        await mineNBlocks(phaseLength);
        expect(await getBlockNumber()).to.be.eq(initialBlockNumber + phaseLength + 1);
        expect(await redistribution.currentPhaseReveal()).to.be.true;

        await expect(redistribution.reveal(overlay_2, depth_2, hash_2, reveal_nonce_2))
          .to.emit(redistribution, 'Revealed')
          .withArgs(currentRound, overlay_2, stakeAmount_2, '6400000000000000000', hash_2, parseInt(depth_2));
      });
    });

    describe('claim phase', async function () {
      describe('single player', async function () {
        it('should claim pot', async function () {
          // anchor fixture
          await mineToNode(redistribution, 5);
          let currentSeed = await redistribution.currentSeed();

          expect(await redistribution.currentPhaseCommit()).to.be.true;
          const r_node_5 = await ethers.getContract('Redistribution', node_5);
          const { proof1, proof2, proofLast, hash: sanityHash, depth: sanityDepth } = node5_proof1;
          const obsfucatedHash = encodeAndHash(overlay_5, sanityDepth, sanityHash, reveal_nonce_5);

          const currentRound = await r_node_5.currentRound();
          await r_node_5.commit(obsfucatedHash, overlay_5, currentRound);
          expect((await r_node_5.currentCommits(0)).obfuscatedHash).to.be.eq(obsfucatedHash);

          const { tx: copyBatchTx, postageDepth } = await copyBatchForClaim(deployer);
          await mineToRevealPhase();
          await r_node_5.reveal(overlay_5, sanityDepth, sanityHash, reveal_nonce_2);

          currentSeed = await redistribution.currentSeed();

          expect((await r_node_5.currentReveals(0)).hash).to.be.eq(sanityHash);
          expect((await r_node_5.currentReveals(0)).overlay).to.be.eq(overlay_5);
          expect((await r_node_5.currentReveals(0)).owner).to.be.eq(node_5);
          expect((await r_node_5.currentReveals(0)).stake).to.be.eq(stakeAmount_5);
          expect((await r_node_5.currentReveals(0)).depth).to.be.eq(parseInt(sanityDepth));

          await mineNBlocks(phaseLength);

          const tx2 = await r_node_5.claim(proof1, proof2, proofLast);
          const receipt2 = await tx2.wait();

          let WinnerSelectedEvent, TruthSelectedEvent, CountCommitsEvent, CountRevealsEvent;
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

          const expectedPotPayout =
            (receipt2.blockNumber - copyBatchTx.blockNumber) * price1 * 2 ** postageDepth +
            (receipt2.blockNumber - stampCreatedBlock) * price1 * 2 ** batch.depth; // batch in the beforeHook
          expect(await token.balanceOf(node_5)).to.be.eq(expectedPotPayout);
          expect(CountCommitsEvent.args[0]).to.be.eq(1);
          expect(CountRevealsEvent.args[0]).to.be.eq(1);

          expect(WinnerSelectedEvent.args[0].owner).to.be.eq(node_5);
          expect(WinnerSelectedEvent.args[0].overlay).to.be.eq(overlay_5);
          expect(WinnerSelectedEvent.args[0].stake).to.be.eq(stakeAmount_5);
          expect(WinnerSelectedEvent.args[0].stakeDensity).to.be.eq(
            BigNumber.from(stakeAmount_0).mul(BigNumber.from(2).pow(sanityDepth))
          );
          expect(WinnerSelectedEvent.args[0].hash).to.be.eq(sanityHash);
          expect(WinnerSelectedEvent.args[0].depth).to.be.eq(parseInt(sanityDepth));

          expect(TruthSelectedEvent.args[0]).to.be.eq(sanityHash);
          expect(TruthSelectedEvent.args[1]).to.be.eq(parseInt(sanityDepth));
        });
      });

      describe('two commits with equal stakes', async function () {
        let priceOracle: Contract;
        let r_node_1: Contract;
        let r_node_5: Contract;
        let currentRound: number;
        let copyBatchTx: any;
        let postageDepth: number;
        let proof1: unknown, proof2: unknown, proofLast: unknown;

        // no need to mineToNode function call in test cases
        beforeEach(async () => {
          await startRoundFixture(3);
          // anchor fixture
          await mineToNode(redistribution, 5);

          priceOracle = await ethers.getContract('PriceOracle', deployer);
          await priceOracle.unPause(); // TODO: remove when price oracle is not paused by default.

          r_node_1 = await ethers.getContract('Redistribution', node_1);
          r_node_5 = await ethers.getContract('Redistribution', node_5);

          currentRound = await r_node_1.currentRound();

          const obsfucatedHash_1 = encodeAndHash(overlay_1_n_25, depth_5, hash_5, reveal_nonce_1);
          await r_node_1.commit(obsfucatedHash_1, overlay_1_n_25, currentRound);

          const obsfucatedHash_5 = encodeAndHash(overlay_5, depth_5, hash_5, reveal_nonce_5);
          await r_node_5.commit(obsfucatedHash_5, overlay_5, currentRound);

          const copyBatch = await copyBatchForClaim(deployer);
          copyBatchTx = copyBatch.tx;
          postageDepth = copyBatch.postageDepth;

          proof1 = node5_proof1.proof1;
          proof2 = node5_proof1.proof2;
          proofLast = node5_proof1.proofLast;

          await mineToRevealPhase();
        });

        it('if only one reveal, should freeze non-revealer and select revealer as winner', async function () {
          const nodesInNeighbourhood = 1;

          //do not reveal node_1
          await r_node_5.reveal(overlay_5, depth_5, hash_5, reveal_nonce_5);

          expect((await r_node_5.currentReveals(0)).hash).to.be.eq(hash_5);
          expect((await r_node_5.currentReveals(0)).overlay).to.be.eq(overlay_5);
          expect((await r_node_5.currentReveals(0)).owner).to.be.eq(node_5);
          expect((await r_node_5.currentReveals(0)).stake).to.be.eq(stakeAmount_5);
          expect((await r_node_5.currentReveals(0)).depth).to.be.eq(parseInt(depth_5));

          await mineNBlocks(phaseLength);

          const tx2 = await r_node_5.claim(proof1, proof2, proofLast);
          const receipt2 = await tx2.wait();

          let WinnerSelectedEvent, TruthSelectedEvent, CountCommitsEvent, CountRevealsEvent;
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

          // <sig need something special to get at child events to check stakefrozen event
          // https://github.com/ethers-io/ethers.js/discussions/3057?sort=top

          const expectedPotPayout =
            (receipt2.blockNumber - copyBatchTx.blockNumber) * price1 * 2 ** postageDepth +
            (receipt2.blockNumber - stampCreatedBlock) * price1 * 2 ** batch.depth; // batch in the beforeHook

          expect(await token.balanceOf(node_5)).to.be.eq(expectedPotPayout);

          expect(CountCommitsEvent.args[0]).to.be.eq(2);
          expect(CountRevealsEvent.args[0]).to.be.eq(1);

          expect(WinnerSelectedEvent.args[0].owner).to.be.eq(node_5);
          expect(WinnerSelectedEvent.args[0].overlay).to.be.eq(overlay_5);
          expect(WinnerSelectedEvent.args[0].stake).to.be.eq(stakeAmount_5);
          expect(WinnerSelectedEvent.args[0].stakeDensity).to.be.eq(
            calculateStakeDensity(stakeAmount_5, Number(depth_5))
          );
          expect(WinnerSelectedEvent.args[0].hash).to.be.eq(hash_5);
          expect(WinnerSelectedEvent.args[0].depth).to.be.eq(parseInt(depth_5));

          expect(TruthSelectedEvent.args[0]).to.be.eq(hash_5);
          expect(TruthSelectedEvent.args[1]).to.be.eq(parseInt(depth_5));

          const newPrice = (increaseRate[nodesInNeighbourhood] * price1) / 1024;
          expect(await postage.lastPrice()).to.be.eq(newPrice);

          const sr = await ethers.getContract('StakeRegistry');

          //node_2 stake is preserved and not frozen
          expect(await sr.usableStakeOfOverlay(overlay_2)).to.be.eq(stakeAmount_2);

          //node_1 is frozen but not slashed
          expect(await sr.usableStakeOfOverlay(overlay_1_n_25)).to.be.eq(0);
        });

        it('if both reveal, should select correct winner', async function () {
          const nodesInNeighbourhood = 2;

          await r_node_1.reveal(overlay_1_n_25, depth_5, hash_5, reveal_nonce_1);
          await r_node_5.reveal(overlay_5, depth_5, hash_5, reveal_nonce_5);

          await mineNBlocks(phaseLength);

          expect(await r_node_1.isWinner(overlay_1_n_25)).to.be.false;
          expect(await r_node_5.isWinner(overlay_5)).to.be.true;

          const tx2 = await r_node_5.claim(proof1, proof2, proofLast);
          const receipt2 = await tx2.wait();

          let WinnerSelectedEvent, TruthSelectedEvent, CountCommitsEvent, CountRevealsEvent;
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

          const expectedPotPayout =
            (receipt2.blockNumber - copyBatchTx.blockNumber) * price1 * 2 ** postageDepth +
            (receipt2.blockNumber - stampCreatedBlock) * price1 * 2 ** batch.depth; // batch in the beforeHook

          expect(await token.balanceOf(node_5)).to.be.eq(expectedPotPayout);

          expect(CountCommitsEvent.args[0]).to.be.eq(2);
          expect(CountRevealsEvent.args[0]).to.be.eq(2);

          expect(WinnerSelectedEvent.args[0].owner).to.be.eq(node_5);
          expect(WinnerSelectedEvent.args[0].overlay).to.be.eq(overlay_5);
          expect(WinnerSelectedEvent.args[0].stake).to.be.eq(stakeAmount_5);
          expect(WinnerSelectedEvent.args[0].stakeDensity).to.be.eq(
            calculateStakeDensity(stakeAmount_5, Number(depth_5))
          );
          expect(WinnerSelectedEvent.args[0].hash).to.be.eq(hash_5);
          expect(WinnerSelectedEvent.args[0].depth).to.be.eq(parseInt(depth_5));

          const newPrice = (increaseRate[nodesInNeighbourhood] * price1) / 1024;
          expect(await postage.lastPrice()).to.be.eq(newPrice);

          expect(TruthSelectedEvent.args[0]).to.be.eq(hash_5);
          expect(TruthSelectedEvent.args[1]).to.be.eq(parseInt(depth_5));

          const sr = await ethers.getContract('StakeRegistry');

          //node_1 stake is preserved and not frozen
          expect(await sr.usableStakeOfOverlay(overlay_1_n_25)).to.be.eq(stakeAmount_1);

          //node_2 stake is preserved and not frozen
          expect(await sr.usableStakeOfOverlay(overlay_5)).to.be.eq(stakeAmount_5);

          await expect(r_node_1.claim(proof1, proof2, proofLast)).to.be.revertedWith(errors.claim.alreadyClaimed);
        });

        it('if incorrect winner claims, correct winner is paid', async function () {
          await r_node_1.reveal(overlay_1_n_25, depth_5, hash_5, reveal_nonce_1);
          await r_node_5.reveal(overlay_5, depth_5, hash_5, reveal_nonce_5);

          await mineNBlocks(phaseLength);

          const tx2 = await r_node_5.claim(proof1, proof2, proofLast);
          const receipt2 = await tx2.wait();

          const expectedPotPayout =
            (receipt2.blockNumber - copyBatchTx.blockNumber) * price1 * 2 ** postageDepth +
            (receipt2.blockNumber - stampCreatedBlock) * price1 * 2 ** batch.depth; // batch in the beforeHook

          expect(await token.balanceOf(node_5)).to.be.eq(expectedPotPayout);

          const sr = await ethers.getContract('StakeRegistry');

          //node_1 stake is preserved and not frozen
          expect(await sr.usableStakeOfOverlay(overlay_5)).to.be.eq(stakeAmount_5);
          //node_2 stake is preserved and not frozen
          expect(await sr.usableStakeOfOverlay(overlay_1)).to.be.eq(stakeAmount_1);
        });
      });
    });
  });
});
