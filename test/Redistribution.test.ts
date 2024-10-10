import { expect } from './util/chai';
import { ethers, deployments, getNamedAccounts } from 'hardhat';
import { BigNumber, Contract, ContractTransaction } from 'ethers';
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
  getWalletOfFdpPlayQueen,
  WITNESS_COUNT,
  skippedRoundsIncrease,
} from './util/tools';
import { proximity } from './util/tools';
import { node5_proof1, node5_soc_proof1 } from './claim-proofs';
import {
  getClaimProofs,
  loadWitnesses,
  makeSample,
  numberToArray,
  calculateTransformedAddress,
  inProximity,
  mineCacWitness,
  setWitnesses,
  getSocProofAttachment,
} from './util/proofs';
import { arrayify, hexlify } from 'ethers/lib/utils';
import { makeChunk } from '@fairdatasociety/bmt-js';
import { randomBytes } from 'crypto';
import { constructPostageStamp } from './util/postage';

const { read, execute } = deployments;
const phaseLength = 38;
const roundLength = 152;

const increaseRate = [524324, 524315, 524306, 524297, 524288, 524279, 524270, 524261, 524252];

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
const effectiveStakeAmount_0 = '99999999999984000';
const obfuscatedHash_0 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';
const height_0 = 0;
const height_0_n_2 = 2;

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
const stakeAmount_1_n_25 = '200000000000000000';
const depth_1 = '0x06';
const reveal_nonce_1 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';
const height_1 = 0;

let node_2: string;
const overlay_2 = '0xa40db58e368ea6856a24c0264ebd73b049f3dc1c2347b1babc901d3e09842dec';
const stakeAmount_2 = '100000000000000000';
const effectiveStakeAmount_2 = '99999999999984000';
const effectiveStakeAmount_2_n_2 = '100000000000000000';
const nonce_2 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';
const hash_2 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';
const depth_2 = '0x06';
const reveal_nonce_2 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';
const height_2 = 0;
const height_2_n_2 = 2;

let node_3: string;
const overlay_3 = '0xaf217eb0d652baf39ec9464a350c7afc812743fd75ccadf4fcceb6d19a1f190c';
const stakeAmount_3 = '100000000000000000';
const nonce_3 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';
const hash_3 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';
const depth_3 = '0x06';
const reveal_nonce_3 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';
const height_3_n_2 = 3;
const effectiveStakeAmount_3 = '100000000000000000';

let node_4: string;
const overlay_4 = '0xaedb2a8007316805b4d64b249ea39c5a1c4a9ce51dc8432724241f41ecb02efb';
const nonce_4 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';
const depth_4 = '0x06';
const height_4 = 0;
// FDP Play node keys - claim data
// queen node
let node_5: string;
const overlay_5 = '0x676720d79d609ed462fadf6f14eb1bf9ec1a90999dd45a671d79a89c7b5ac9d8';
const stakeAmount_5 = '100000000000000000';
const effectiveStakeAmount_5 = '99999999999984000';
const nonce_5 = '0x0000000000000000000000000000000000000000000000000000000000003ba6';
const reveal_nonce_5 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';
const { depth: depth_5, hash: hash_5 } = node5_proof1;
const height_5 = 0;

let node_6: string;
const overlay_6 = '0x141680b0d9c7ab250672fd4603ac13e39e47de6e2c93d71bbdc66459a6c5e39f';
const stakeAmount_6 = '100000000000000000';

const nonce_6 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';
const hash_6 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';
const depth_6 = '0x06';
const reveal_nonce_6 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';

let node_7: string;
const overlay_7 = '0x152d169abc6e6a0e0a2a7b78dcfea0bebe32942f05e9bb10ee2996203d5361ef';
const stakeAmount_7 = '100000000000000000';
const nonce_7 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';
const hash_7 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';
const depth_7 = '0x06';
const reveal_nonce_7 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';

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
  node_6 = namedAccounts.node_6;
  node_7 = namedAccounts.node_7;
});

const errors = {
  commit: {
    notOwner: 'NotMatchingOwner()',
    notStaked: 'NotStaked()',
    stakedRecently: 'MustStake2Rounds()',
    alreadyCommitted: 'AlreadyCommitted()',
  },
  reveal: {
    noCommits: 'NoCommitsReceived()',
    doNotMatch: 'NoMatchingCommit()',
    outOfDepth: 'OutOfDepth()',
    outOfDepthReveal: 'OutOfDepthReveal()',
    notInReveal: 'NotRevealPhase()',
  },
  claim: {
    noReveals: 'NoReveals()',
    alreadyClaimed: 'AlreadyClaimed()',
    randomCheckFailed: 'RandomElementCheckFailed()',
    outOfDepth: 'OutOfDepth()',
    reserveCheckFailed: 'ReserveCheckFailed()',
    indexOutsideSet: 'IndexOutsideSet()',
    batchDoesNotExist: 'BatchDoesNotExist()',
    bucketDiffers: 'BucketDiffers()',
    sigRecoveryFailed: 'SigRecoveryFailed()',
    inclusionProofFailed1: 'InclusionProofFailed',
    inclusionProofFailed2: 'InclusionProofFailed',
    inclusionProofFailed3: 'InclusionProofFailed',
    inclusionProofFailed4: 'InclusionProofFailed',
    socVerificationFailed: 'SocVerificationFailed()',
    socCalcNotMatching: 'SocCalcNotMatching()',
  },
  general: {
    onlyPauser: 'OnlyPauser()',
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
    });

    it('should not create a commit with unstaked node', async function () {
      expect(await redistribution.currentPhaseCommit()).to.be.true;

      const r_node_0 = await ethers.getContract('Redistribution', node_0);
      const currentRound = await r_node_0.currentRound();
      await expect(r_node_0.commit(obfuscatedHash_0, currentRound)).to.be.revertedWith(errors.commit.notStaked);
    });

    it('should not participation with unstaked node', async function () {
      expect(await redistribution.currentPhaseCommit()).to.be.true;

      const r_node_0 = await ethers.getContract('Redistribution', node_0);
      const currentRound = await r_node_0.currentRound();
      await expect(r_node_0['isParticipatingInUpcomingRound(address,uint8)'](node_0, depth_0)).to.be.revertedWith(
        errors.commit.notStaked
      );
    });

    it('should not create a commit with recently staked node', async function () {
      const sr_node_0 = await ethers.getContract('StakeRegistry', node_0);
      await mintAndApprove(deployer, node_0, sr_node_0.address, stakeAmount_0);
      await sr_node_0.manageStake(nonce_0, stakeAmount_0, height_0);

      expect(await redistribution.currentPhaseCommit()).to.be.true;

      const r_node_0 = await ethers.getContract('Redistribution', node_0);
      await expect(r_node_0['isParticipatingInUpcomingRound(address,uint8)'](node_0, depth_0)).to.be.revertedWith(
        errors.commit.stakedRecently
      );
    });

    it('should create a commit with staked node', async function () {
      const sr_node_0 = await ethers.getContract('StakeRegistry', node_0);
      await mintAndApprove(deployer, node_0, sr_node_0.address, stakeAmount_0);
      await sr_node_0.manageStake(nonce_0, stakeAmount_0, height_0);

      expect(await redistribution.currentPhaseCommit()).to.be.true;

      const r_node_0 = await ethers.getContract('Redistribution', node_0);
      await expect(r_node_0['isParticipatingInUpcomingRound(address,uint8)'](node_0, depth_0)).to.be.revertedWith(
        errors.commit.stakedRecently
      );
    });

    it('should create a commit with staked node and height 2', async function () {
      const sr_node_0 = await ethers.getContract('StakeRegistry', node_0);
      await mintAndApprove(deployer, node_0, sr_node_0.address, stakeAmount_0);
      await sr_node_0.manageStake(nonce_0, stakeAmount_0, height_0_n_2);

      expect(await redistribution.currentPhaseCommit()).to.be.true;

      const r_node_0 = await ethers.getContract('Redistribution', node_0);
      await expect(r_node_0['isParticipatingInUpcomingRound(address,uint8)'](node_0, depth_0)).to.be.revertedWith(
        errors.commit.stakedRecently
      );
    });
  });

  describe('with deployed contract and staked node in next round', async function () {
    let redistribution: Contract;
    let token: Contract;
    let postage: Contract;
    const price1 = 48000;
    const batch = {
      nonce: '0x000000000000000000000000000000000000000000000000000000000000abcd',
      initialPaymentPerChunk: 20000000000,
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

      const pauserRole = await read('StakeRegistry', 'DEFAULT_ADMIN_ROLE');
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
      await sr_node_0.manageStake(nonce_0, stakeAmount_0, height_0);

      const sr_node_1 = await ethers.getContract('StakeRegistry', node_1);
      await mintAndApprove(deployer, node_1, sr_node_1.address, stakeAmount_1);
      await sr_node_1.manageStake(nonce_1, stakeAmount_1, height_1);

      // 16 depth neighbourhood with node_5
      const sr_node_1_n_25 = await ethers.getContract('StakeRegistry', node_1);
      await mintAndApprove(deployer, node_1, sr_node_1_n_25.address, stakeAmount_1);
      await sr_node_1_n_25.manageStake(nonce_1_n_25, stakeAmount_1, height_1);

      const sr_node_2 = await ethers.getContract('StakeRegistry', node_2);
      await mintAndApprove(deployer, node_2, sr_node_2.address, stakeAmount_2);
      await sr_node_2.manageStake(nonce_2, stakeAmount_2, height_2);

      const sr_node_3 = await ethers.getContract('StakeRegistry', node_3);
      await mintAndApprove(deployer, node_3, sr_node_3.address, stakeAmount_3);
      await sr_node_3.manageStake(nonce_3, stakeAmount_3, height_4);

      const sr_node_4 = await ethers.getContract('StakeRegistry', node_4);
      await mintAndApprove(deployer, node_4, sr_node_4.address, stakeAmount_3);
      await sr_node_4.manageStake(nonce_4, stakeAmount_3, height_4);

      const sr_node_5 = await ethers.getContract('StakeRegistry', node_5);
      await mintAndApprove(deployer, node_5, sr_node_5.address, stakeAmount_5);
      await sr_node_5.manageStake(nonce_5, stakeAmount_5, height_5);

      // We need to mine 2 rounds to make the staking possible
      // as this is the minimum time between staking and committing
      await mineNBlocks(roundLength * 2 + 3);
      await startRoundFixture();
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
        const obfuscatedHash = encodeAndHash(overlay_0, depth_0, hash_0, reveal_nonce_0);

        expect(await redistribution.wrapCommit(overlay_0, depth_0, hash_0, reveal_nonce_0)).to.be.eq(obfuscatedHash);
      });

      it('should correctly wrap another commit', async function () {
        const obfuscatedHash = encodeAndHash(overlay_3, depth_3, hash_3, reveal_nonce_3);

        expect(await redistribution.wrapCommit(overlay_3, depth_3, hash_3, reveal_nonce_3)).to.be.eq(obfuscatedHash);
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
        expect(await redistribution['isParticipatingInUpcomingRound(address,uint8)'](node_0, depth_0)).to.be.true;
        // Should be false as we are using different nhood then anchor via node_1_25
        expect(await redistribution['isParticipatingInUpcomingRound(address,uint8)'](node_1, depth_1)).to.be.false;
        expect(await redistribution['isParticipatingInUpcomingRound(address,uint8)'](node_2, depth_2)).to.be.true;

        // 0xa6...
        expect(await redistribution['isParticipatingInUpcomingRound(address,uint8)'](node_3, depth_3)).to.be.false;
        expect(await redistribution['isParticipatingInUpcomingRound(address,uint8)'](node_4, depth_4)).to.be.false;

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

        expect(await redistribution['isParticipatingInUpcomingRound(address,uint8)'](node_0, depth_0)).to.be.false;
        expect(await redistribution['isParticipatingInUpcomingRound(address,uint8)'](node_1, depth_1)).to.be.false;
        expect(await redistribution['isParticipatingInUpcomingRound(address,uint8)'](node_2, depth_2)).to.be.false;

        expect(await redistribution['isParticipatingInUpcomingRound(address,uint8)'](node_3, depth_3)).to.be.true;
        expect(await redistribution['isParticipatingInUpcomingRound(address,uint8)'](node_4, depth_4)).to.be.true;
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

        const obfuscatedHash = encodeAndHash(overlay_3, '0x08', hash_3, reveal_nonce_3);
        expect(await r_node_3.wrapCommit(overlay_3, '0x08', hash_3, reveal_nonce_3)).to.be.eq(obfuscatedHash);
        const currentRound = await r_node_3.currentRound();
        await r_node_3.commit(obfuscatedHash, currentRound);

        expect((await r_node_3.currentCommits(0)).obfuscatedHash).to.be.eq(obfuscatedHash);
        await mineNBlocks(phaseLength);
        await expect(r_node_3.reveal('0x08', hash_3, reveal_nonce_3)).to.be.revertedWith(
          errors.reveal.outOfDepthReveal
        );
      });

      it('should create a commit with failed reveal if the overlay is out of reported depth but good reveal if height is changed', async function () {
        expect(await redistribution.currentPhaseCommit()).to.be.true;
        const r_node_3 = await ethers.getContract('Redistribution', node_3);
        expect(await redistribution.currentRoundAnchor()).to.be.eq(round2Anchor);

        const obfuscatedHash = encodeAndHash(overlay_3, '0x08', hash_3, reveal_nonce_3);
        expect(await r_node_3.wrapCommit(overlay_3, '0x08', hash_3, reveal_nonce_3)).to.be.eq(obfuscatedHash);
        const currentRound = await r_node_3.currentRound();
        await r_node_3.commit(obfuscatedHash, currentRound);

        expect((await r_node_3.currentCommits(0)).obfuscatedHash).to.be.eq(obfuscatedHash);
        await mineNBlocks(phaseLength);
        await expect(r_node_3.reveal('0x08', hash_3, reveal_nonce_3)).to.be.revertedWith(
          errors.reveal.outOfDepthReveal
        );

        // Change height and check if node is playing
        const sr_node_3 = await ethers.getContract('StakeRegistry', node_3);
        await sr_node_3.manageStake(nonce_3, 0, height_3_n_2);
        await mineNBlocks(3 * phaseLength);
        await mineToNode(redistribution, 3);

        expect(await redistribution.currentPhaseCommit()).to.be.true;
        const obfuscatedHash2 = encodeAndHash(overlay_3, depth_3, hash_3, reveal_nonce_3);
        const currentRound2 = await r_node_3.currentRound();

        await expect(r_node_3.commit(obfuscatedHash2, currentRound2))
          .to.emit(redistribution, 'Committed')
          .withArgs(currentRound2, overlay_3);

        expect((await r_node_3.currentCommits(0)).obfuscatedHash).to.be.eq(obfuscatedHash2);

        await mineNBlocks(phaseLength);
        await r_node_3.reveal(depth_3, hash_3, reveal_nonce_3);

        expect((await r_node_3.currentReveals(0)).hash).to.be.eq(hash_3);
        expect((await r_node_3.currentReveals(0)).overlay).to.be.eq(overlay_3);
        expect((await r_node_3.currentReveals(0)).owner).to.be.eq(node_3);
        expect((await r_node_3.currentReveals(0)).stake).to.be.eq(effectiveStakeAmount_3);
        expect((await r_node_3.currentReveals(0)).depth).to.be.eq(parseInt(depth_3));
      });

      it('should create a commit with successful reveal if the overlay is within the reported depth', async function () {
        const r_node_2 = await ethers.getContract('Redistribution', node_2);

        await mineToNode(redistribution, 2);
        expect(await redistribution.currentPhaseCommit()).to.be.true;

        const obfuscatedHash = encodeAndHash(overlay_2, depth_2, hash_2, reveal_nonce_2);

        const currentRound = await r_node_2.currentRound();

        await expect(r_node_2.commit(obfuscatedHash, currentRound))
          .to.emit(redistribution, 'Committed')
          .withArgs(currentRound, overlay_2);

        expect((await r_node_2.currentCommits(0)).obfuscatedHash).to.be.eq(obfuscatedHash);

        await mineNBlocks(phaseLength);

        await r_node_2.reveal(depth_2, hash_2, reveal_nonce_2);

        expect((await r_node_2.currentReveals(0)).hash).to.be.eq(hash_2);
        expect((await r_node_2.currentReveals(0)).overlay).to.be.eq(overlay_2);
        expect((await r_node_2.currentReveals(0)).owner).to.be.eq(node_2);
        expect((await r_node_2.currentReveals(0)).stake).to.be.eq(effectiveStakeAmount_2);
        expect((await r_node_2.currentReveals(0)).depth).to.be.eq(parseInt(depth_2));
      });

      it('should create a commit with successful reveal if the overlay is within the reported depth with height 2', async function () {
        const r_node_2 = await ethers.getContract('Redistribution', node_2);
        const sr_node_2 = await ethers.getContract('StakeRegistry', node_2);
        await sr_node_2.manageStake(nonce_2, 0, height_2_n_2);

        await mineToNode(redistribution, 2);
        expect(await redistribution.currentPhaseCommit()).to.be.true;

        const obfuscatedHash = encodeAndHash(overlay_2, depth_2, hash_2, reveal_nonce_2);

        const currentRound = await r_node_2.currentRound();

        await expect(r_node_2.commit(obfuscatedHash, currentRound))
          .to.emit(redistribution, 'Committed')
          .withArgs(currentRound, overlay_2);

        expect((await r_node_2.currentCommits(0)).obfuscatedHash).to.be.eq(obfuscatedHash);

        await mineNBlocks(phaseLength);

        await r_node_2.reveal(depth_2, hash_2, reveal_nonce_2);

        expect((await r_node_2.currentReveals(0)).hash).to.be.eq(hash_2);
        expect((await r_node_2.currentReveals(0)).overlay).to.be.eq(overlay_2);
        expect((await r_node_2.currentReveals(0)).owner).to.be.eq(node_2);
        expect((await r_node_2.currentReveals(0)).stake).to.be.eq(effectiveStakeAmount_2_n_2);
        expect((await r_node_2.currentReveals(0)).depth).to.be.eq(parseInt(depth_2));
      });

      it('should create a fake commit with failed reveal', async function () {
        const initialBlockNumber = await getBlockNumber();
        expect(await redistribution.currentPhaseCommit()).to.be.true;

        const r_node_0 = await ethers.getContract('Redistribution', node_0);
        const currentRound = await r_node_0.currentRound();
        await r_node_0.commit(obfuscatedHash_0, currentRound);

        const commit_0 = await r_node_0.currentCommits(0);
        expect(commit_0.overlay).to.be.eq(overlay_0);
        expect(commit_0.obfuscatedHash).to.be.eq(obfuscatedHash_0);

        expect(await getBlockNumber()).to.be.eq(initialBlockNumber + 1);

        await mineNBlocks(phaseLength);

        expect(await getBlockNumber()).to.be.eq(initialBlockNumber + 1 + phaseLength);
        expect(await r_node_0.currentPhaseReveal()).to.be.true;

        await expect(r_node_0.reveal(depth_0, reveal_nonce_0, revealed_overlay_0)).to.be.revertedWith(
          errors.reveal.doNotMatch
        );
      });

      it('should not allow duplicate commits', async function () {
        expect(await redistribution.currentPhaseCommit()).to.be.true;

        const r_node_2 = await ethers.getContract('Redistribution', node_2);

        const obfuscatedHash = encodeAndHash(overlay_2, depth_2, hash_2, reveal_nonce_2);

        const currentRound = await r_node_2.currentRound();

        await r_node_2.commit(obfuscatedHash, currentRound);

        expect((await r_node_2.currentCommits(0)).obfuscatedHash).to.be.eq(obfuscatedHash);

        await expect(r_node_2.commit(obfuscatedHash, currentRound)).to.be.revertedWith(errors.commit.alreadyCommitted);
      });
    });

    describe('reveal phase', async function () {
      it('should not allow an overlay to reveal without commits', async function () {
        const initialBlockNumber = await getBlockNumber();
        expect(await redistribution.currentPhaseCommit()).to.be.true;

        await mineNBlocks(phaseLength);
        expect(await getBlockNumber()).to.be.eq(initialBlockNumber + phaseLength);
        expect(await redistribution.currentPhaseReveal()).to.be.true;

        const r_node_0 = await ethers.getContract('Redistribution', node_0);

        await expect(r_node_0.reveal(depth_0, reveal_nonce_0, revealed_overlay_0)).to.be.revertedWith(
          errors.reveal.noCommits
        );
      });

      it('should not allow reveal in commit phase', async function () {
        expect(await redistribution.currentPhaseCommit()).to.be.true;

        const r_node_0 = await ethers.getContract('Redistribution', node_0);

        await expect(r_node_0.reveal(depth_0, reveal_nonce_0, revealed_overlay_0)).to.be.revertedWith(
          errors.reveal.notInReveal
        );
      });

      it('should not allow reveal in claim phase', async function () {
        const initialBlockNumber = await getBlockNumber();
        expect(await redistribution.currentPhaseCommit()).to.be.true;

        expect(await getBlockNumber()).to.be.eq(initialBlockNumber);
        expect(await redistribution.currentPhaseReveal()).to.be.false;

        const r_node_0 = await ethers.getContract('Redistribution', node_0);

        await mineNBlocks(phaseLength * 2);
        expect(await redistribution.currentPhaseClaim()).to.be.true;

        // commented out to allow other tests to pass for now
        await expect(r_node_0.reveal(depth_0, reveal_nonce_0, revealed_overlay_0)).to.be.revertedWith(
          errors.reveal.notInReveal
        );
      });

      it('should not allow an overlay to reveal with the incorrect nonce', async function () {
        const initialBlockNumber = await getBlockNumber();
        expect(await redistribution.currentPhaseCommit()).to.be.true;

        const r_node_2 = await ethers.getContract('Redistribution', node_2);

        const obfuscatedHash = encodeAndHash(overlay_2, depth_2, hash_2, reveal_nonce_2);

        const currentRound = await r_node_2.currentRound();
        await r_node_2.commit(obfuscatedHash, currentRound);

        await mineNBlocks(phaseLength);
        expect(await getBlockNumber()).to.be.eq(initialBlockNumber + phaseLength + 1);
        expect(await redistribution.currentPhaseReveal()).to.be.true;

        await expect(r_node_2.reveal(depth_2, hash_2, reveal_nonce_f)).to.be.revertedWith(errors.reveal.doNotMatch);
      });

      it('should not allow an overlay to reveal without with the incorrect depth', async function () {
        const initialBlockNumber = await getBlockNumber();
        expect(await redistribution.currentPhaseCommit()).to.be.true;

        const r_node_2 = await ethers.getContract('Redistribution', node_2);
        const obfuscatedHash = encodeAndHash(overlay_2, depth_2, hash_2, reveal_nonce_2);

        const currentRound = await r_node_2.currentRound();
        await r_node_2.commit(obfuscatedHash, currentRound);

        await mineNBlocks(phaseLength);
        expect(await getBlockNumber()).to.be.eq(initialBlockNumber + phaseLength + 1);
        expect(await redistribution.currentPhaseReveal()).to.be.true;

        await expect(r_node_2.reveal(depth_f, hash_2, reveal_nonce_2)).to.be.revertedWith(errors.reveal.doNotMatch);
      });

      describe('when pausing', function () {
        it('should not allow anybody but the pauser to pause', async function () {
          const redistributionContract = await ethers.getContract('Redistribution', stamper);
          await expect(redistributionContract.pause()).to.be.revertedWith(errors.general.onlyPauser);
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
          await expect(redistributionContract2.unPause()).to.be.revertedWith(errors.general.onlyPauser);
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
        const obfuscatedHash = encodeAndHash(overlay_2, depth_2, hash_2, reveal_nonce_2);

        const currentRound = await r_node_2.currentRound();
        await r_node_2.commit(obfuscatedHash, parseInt(currentRound));

        await mineNBlocks(phaseLength);
        expect(await getBlockNumber()).to.be.eq(initialBlockNumber + phaseLength + 1);
        expect(await redistribution.currentPhaseReveal()).to.be.true;

        await expect(r_node_2.reveal(depth_2, hash_2, reveal_nonce_2))
          .to.emit(redistribution, 'Revealed')
          .withArgs(currentRound, overlay_2, effectiveStakeAmount_2, '6399999999998976000', hash_2, parseInt(depth_2));
      });
    });

    describe('claim phase', async function () {
      let skippedRounds: number;
      describe('single player', async function () {
        let copyBatch: Awaited<ReturnType<typeof copyBatchForClaim>>, currentSeed: string, r_node_5: Contract;
        const depth = 1;
        const generatedSampling = async (socAttachment = false) => {
          const anchor1 = arrayify(currentSeed);
          const witnessChunks = socAttachment
            ? await setWitnesses('claim-pot-soc', anchor1, depth, true)
            : await setWitnesses('claim-pot', anchor1, depth);

          const sampleChunk = makeSample(witnessChunks);

          const sampleHashString = hexlify(sampleChunk.address());

          const obfuscatedHash = encodeAndHash(overlay_5, hexlify(depth), sampleHashString, reveal_nonce_5);

          const currentRound = await r_node_5.currentRound();
          await r_node_5.commit(obfuscatedHash, currentRound);

          expect((await r_node_5.currentCommits(0)).obfuscatedHash).to.be.eq(obfuscatedHash);

          await mineToRevealPhase();

          await r_node_5.reveal(hexlify(depth), sampleHashString, reveal_nonce_5);

          const anchor2 = await redistribution.currentSeed();

          const { proofParams } = await getClaimProofs(
            witnessChunks,
            sampleChunk,
            anchor1,
            anchor2,
            copyBatch.batchOwner,
            copyBatch.batchId
          );

          expect((await r_node_5.currentReveals(0)).hash).to.be.eq(sampleHashString);
          expect((await r_node_5.currentReveals(0)).overlay).to.be.eq(overlay_5);
          expect((await r_node_5.currentReveals(0)).owner).to.be.eq(node_5);
          expect((await r_node_5.currentReveals(0)).stake).to.be.eq(effectiveStakeAmount_5);
          expect((await r_node_5.currentReveals(0)).depth).to.be.eq(depth);

          await mineNBlocks(phaseLength);

          return { proofParams, sampleHashString };
        };
        const claimEventChecks = async (
          claimTx: ContractTransaction,
          sanityHash: string,
          sanityDepth: string,
          options?: {
            additionalReward?: number; // in case of there was another copybatch before claim
          }
        ) => {
          const receipt2 = await claimTx.wait();

          let WinnerSelectedEvent, TruthSelectedEvent, CountCommitsEvent, CountRevealsEvent;
          if (!receipt2.events) {
            throw new Error('The transaction does not produced any events');
          }
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
          if (!CountCommitsEvent || !CountCommitsEvent.args) {
            throw new Error('CountCommitsEvent has not triggered');
          }
          if (!WinnerSelectedEvent || !WinnerSelectedEvent.args) {
            throw new Error('CountCommitsEvent has not triggered');
          }
          if (!CountRevealsEvent || !CountRevealsEvent.args) {
            throw new Error('CountCommitsEvent has not triggered');
          }
          if (!TruthSelectedEvent || !TruthSelectedEvent.args) {
            throw new Error('CountCommitsEvent has not triggered');
          }

          const expectedPotPayout =
            (receipt2.blockNumber - copyBatch.tx.blockNumber) * price1 * 2 ** copyBatch.postageDepth +
            (receipt2.blockNumber - stampCreatedBlock) * price1 * 2 ** batch.depth + // batch in the beforeHook
            (options?.additionalReward ? options?.additionalReward : 0);

          expect(await token.balanceOf(node_5)).to.be.eq(expectedPotPayout);

          expect(CountCommitsEvent.args[0]).to.be.eq(1);
          expect(CountRevealsEvent.args[0]).to.be.eq(1);

          expect(WinnerSelectedEvent.args[0].owner).to.be.eq(node_5);
          expect(WinnerSelectedEvent.args[0].overlay).to.be.eq(overlay_5);
          expect(WinnerSelectedEvent.args[0].stake).to.be.eq(effectiveStakeAmount_5);
          expect(WinnerSelectedEvent.args[0].stakeDensity).to.be.eq(
            BigNumber.from(effectiveStakeAmount_0).mul(BigNumber.from(2).pow(parseInt(sanityDepth)))
          );
          expect(WinnerSelectedEvent.args[0].hash).to.be.eq(sanityHash);
          expect(WinnerSelectedEvent.args[0].depth).to.be.eq(parseInt(sanityDepth));

          expect(TruthSelectedEvent.args[0]).to.be.eq(sanityHash);
          expect(TruthSelectedEvent.args[1]).to.be.eq(parseInt(sanityDepth));
        };

        beforeEach(async () => {
          //copying batch for claim
          copyBatch = await copyBatchForClaim(
            deployer,
            '0x5bee6f33f47fbe2c3ff4c853dbc95f1a6a4a4191a1a7e3ece999a76c2790a83f'
          );
          // anchor fixture
          await mineToNode(redistribution, 5);
          currentSeed = await redistribution.currentSeed();
          expect(await redistribution.currentPhaseCommit()).to.be.true;
          r_node_5 = await ethers.getContract('Redistribution', node_5);
        });

        it('should claim pot by bee CAC sampling', async function () {
          const { proof1, proof2, proofLast, hash: sanityHash, depth: sanityDepth } = node5_proof1;

          const obfuscatedHash = encodeAndHash(overlay_5, sanityDepth, sanityHash, reveal_nonce_5);

          const currentRound = await r_node_5.currentRound();
          await r_node_5.commit(obfuscatedHash, currentRound);

          expect((await r_node_5.currentCommits(0)).obfuscatedHash).to.be.eq(obfuscatedHash);

          await mineToRevealPhase();

          await r_node_5.reveal(sanityDepth, sanityHash, reveal_nonce_5);

          currentSeed = await redistribution.currentSeed();

          expect((await r_node_5.currentReveals(0)).hash).to.be.eq(sanityHash);
          expect((await r_node_5.currentReveals(0)).overlay).to.be.eq(overlay_5);
          expect((await r_node_5.currentReveals(0)).owner).to.be.eq(node_5);
          expect((await r_node_5.currentReveals(0)).stake).to.be.eq(effectiveStakeAmount_5);
          expect((await r_node_5.currentReveals(0)).depth).to.be.eq(parseInt(sanityDepth));

          await mineNBlocks(phaseLength);

          const tx2 = await r_node_5.claim(proof1, proof2, proofLast);
          await claimEventChecks(tx2, sanityHash, sanityDepth);
        });

        it('should claim pot by bee SOC sampling', async function () {
          //copying batch for claim because pull sync does not work correctly
          const copyBatch2 = await copyBatchForClaim(
            deployer,
            '0x6cccd65a68bc5f7c19a273e9567ebf4b968a13c9be74fc99ad90159730eff219'
          );

          const { proof1, proof2, proofLast, hash: sanityHash, depth: sanityDepth } = node5_soc_proof1;

          const obsfucatedHash = encodeAndHash(overlay_5, sanityDepth, sanityHash, reveal_nonce_5);

          const currentRound = await r_node_5.currentRound();
          await r_node_5.commit(obsfucatedHash, currentRound);

          expect((await r_node_5.currentCommits(0)).obfuscatedHash).to.be.eq(obsfucatedHash);

          await mineToRevealPhase();

          await r_node_5.reveal(sanityDepth, sanityHash, reveal_nonce_5);

          currentSeed = await redistribution.currentSeed();

          expect((await r_node_5.currentReveals(0)).hash).to.be.eq(sanityHash);
          expect((await r_node_5.currentReveals(0)).overlay).to.be.eq(overlay_5);
          expect((await r_node_5.currentReveals(0)).owner).to.be.eq(node_5);
          expect((await r_node_5.currentReveals(0)).stake).to.be.eq(effectiveStakeAmount_5);
          expect((await r_node_5.currentReveals(0)).depth).to.be.eq(parseInt(sanityDepth));

          await mineNBlocks(phaseLength);

          const tx2 = await r_node_5.claim(proof1, proof2, proofLast);
          const receipt2 = await tx2.wait();
          await claimEventChecks(tx2, sanityHash, sanityDepth, {
            additionalReward:
              (receipt2.blockNumber - copyBatch2.tx.blockNumber) * price1 * 2 ** copyBatch2.postageDepth,
          });
        });

        it('should claim pot by generated CAC sampling', async function () {
          const { sampleHashString, proofParams } = await generatedSampling();

          expect(proofParams.proof1.socProof).to.have.length(0);
          expect(proofParams.proof2.socProof).to.have.length(0);
          expect(proofParams.proofLast.socProof).to.have.length(0);
          const tx2 = await r_node_5.claim(proofParams.proof1, proofParams.proof2, proofParams.proofLast);
          await claimEventChecks(tx2, sampleHashString, hexlify(depth));
        });

        it('should claim pot by generated SOC sampling', async function () {
          const { sampleHashString, proofParams } = await generatedSampling(true);

          expect(proofParams.proof1.socProof).to.have.length(1);
          expect(proofParams.proof2.socProof).to.have.length(1);
          expect(proofParams.proofLast.socProof).to.have.length(1);
          const tx2 = await r_node_5.claim(proofParams.proof1, proofParams.proof2, proofParams.proofLast);
          await claimEventChecks(tx2, sampleHashString, hexlify(depth));
        });

        it('should not claim pot because of wrong witness order', async () => {
          const anchor1 = arrayify(currentSeed);

          let witnessChunks = loadWitnesses('claim-pot');
          witnessChunks = witnessChunks.reverse();

          const sampleChunk = makeSample(witnessChunks);

          const sampleHashString = hexlify(sampleChunk.address());

          const obfuscatedHash = encodeAndHash(overlay_5, hexlify(depth), sampleHashString, reveal_nonce_5);

          const currentRound = await r_node_5.currentRound();
          await r_node_5.commit(obfuscatedHash, currentRound);

          expect((await r_node_5.currentCommits(0)).obfuscatedHash).to.be.eq(obfuscatedHash);

          await mineToRevealPhase();

          await r_node_5.reveal(hexlify(depth), sampleHashString, reveal_nonce_5);

          const anchor2 = await redistribution.currentSeed();

          await mineNBlocks(phaseLength);

          const { proofParams } = await getClaimProofs(
            witnessChunks,
            sampleChunk,
            anchor1,
            anchor2,
            copyBatch.batchOwner,
            copyBatch.batchId
          );

          await expect(
            r_node_5.claim(proofParams.proof1, proofParams.proof2, proofParams.proofLast)
          ).to.be.revertedWith(errors.claim.randomCheckFailed);
        });

        it('should not claim pot because of a witness is not in depth', async () => {
          const anchor1 = arrayify(currentSeed);

          // create witnesses
          let witnessChunks: ReturnType<typeof mineCacWitness>[] = [];

          for (let i = 0; i < WITNESS_COUNT; i++) {
            // NOTE do not do estimation mining because that takes long
            const nonce = i;
            const nonceBuf = numberToArray(nonce);
            const transformedAddress = calculateTransformedAddress(nonceBuf, anchor1);
            witnessChunks.push({ nonce, transformedAddress });
          }
          // sort witness chunks to be descendant because of the
          witnessChunks = witnessChunks.sort((a, b) => {
            const aBn = BigNumber.from(a.transformedAddress);
            const bBn = BigNumber.from(b.transformedAddress);
            if (aBn.lt(bBn)) {
              return -1;
            }
            if (bBn.lt(aBn)) {
              return 1;
            }
            return 0;
          });

          const sampleChunk = makeSample(witnessChunks);

          const sampleHashString = hexlify(sampleChunk.address());

          const obfuscatedHash = encodeAndHash(overlay_5, hexlify(depth), sampleHashString, reveal_nonce_5);

          const currentRound = await r_node_5.currentRound();
          await r_node_5.commit(obfuscatedHash, currentRound);

          expect((await r_node_5.currentCommits(0)).obfuscatedHash).to.be.eq(obfuscatedHash);

          await mineToRevealPhase();

          await r_node_5.reveal(hexlify(depth), sampleHashString, reveal_nonce_5);

          const anchor2 = await redistribution.currentSeed();

          await mineNBlocks(phaseLength);

          const { proofParams } = await getClaimProofs(
            witnessChunks,
            sampleChunk,
            anchor1,
            anchor2,
            copyBatch.batchOwner,
            copyBatch.batchId
          );

          await expect(
            r_node_5.claim(proofParams.proof1, proofParams.proof2, proofParams.proofLast)
          ).to.be.revertedWith(errors.claim.outOfDepth);
        });

        it('should not claim pot because of estimation check', async () => {
          const anchor1 = arrayify(currentSeed);

          // create witnesses
          let witnessChunks: ReturnType<typeof mineCacWitness>[] = [];

          let j = 0;
          for (let i = 0; i < WITNESS_COUNT; i++) {
            // mine nonce until transformed address is in depth
            while (true) {
              const nonce = j++;
              const nonceBuf = numberToArray(nonce);
              const transformedAddress = calculateTransformedAddress(nonceBuf, anchor1);
              if (inProximity(makeChunk(nonceBuf).address(), anchor1, depth)) {
                witnessChunks.push({ nonce, transformedAddress });
                j++;
                break;
              }
            }
          }
          // sort witness chunks to be descendant because of the order check
          witnessChunks = witnessChunks.sort((a, b) => {
            const aBn = BigNumber.from(a.transformedAddress);
            const bBn = BigNumber.from(b.transformedAddress);
            if (aBn.lt(bBn)) {
              return -1;
            }
            if (bBn.lt(aBn)) {
              return 1;
            }
            return 0;
          });

          const sampleChunk = makeSample(witnessChunks);

          const sampleHashString = hexlify(sampleChunk.address());

          const obfuscatedHash = encodeAndHash(overlay_5, hexlify(depth), sampleHashString, reveal_nonce_5);

          const currentRound = await r_node_5.currentRound();
          await r_node_5.commit(obfuscatedHash, currentRound);

          expect((await r_node_5.currentCommits(0)).obfuscatedHash).to.be.eq(obfuscatedHash);

          await mineToRevealPhase();

          await r_node_5.reveal(hexlify(depth), sampleHashString, reveal_nonce_5);

          const anchor2 = await redistribution.currentSeed();

          await mineNBlocks(phaseLength);

          const { proofParams } = await getClaimProofs(
            witnessChunks,
            sampleChunk,
            anchor1,
            anchor2,
            copyBatch.batchOwner,
            copyBatch.batchId
          );

          await expect(
            r_node_5.claim(proofParams.proof1, proofParams.proof2, proofParams.proofLast)
          ).to.be.revertedWith(errors.claim.reserveCheckFailed);
        });

        describe('should not claim pot because of SOC checks', async () => {
          it('wrong SOC signature', async function () {
            const { proofParams } = await generatedSampling(true);

            // alter the identifier into random one
            proofParams.proof1.socProof![0].identifier = randomBytes(32);

            await expect(
              r_node_5.claim(proofParams.proof1, proofParams.proof2, proofParams.proofLast)
            ).to.be.revertedWith(errors.claim.socVerificationFailed);
          });

          it('SOC attachment does not match with witness', async function () {
            const { proofParams } = await generatedSampling(true);

            proofParams.proof1.socProof![0] = await getSocProofAttachment(
              proofParams.proof1.socProof![0].chunkAddr,
              randomBytes(32),
              depth
            );

            await expect(
              r_node_5.claim(proofParams.proof1, proofParams.proof2, proofParams.proofLast)
            ).to.be.revertedWith(errors.claim.socCalcNotMatching);
          });
        });

        describe('should not claim pot because of postage stamp checks', async () => {
          it('stamp index is out of range', async function () {
            const { proofParams } = await generatedSampling();

            const index = Buffer.from(proofParams.proof1.postageProof.index);
            index.writeUInt32BE(2 ** 30, 4);
            proofParams.proof1.postageProof.index = index;

            await expect(
              r_node_5.claim(proofParams.proof1, proofParams.proof2, proofParams.proofLast)
            ).to.be.revertedWith(errors.claim.indexOutsideSet);
          });

          it('stamp is not valid anymore', async function () {
            const { proofParams } = await generatedSampling();

            const wallet = getWalletOfFdpPlayQueen();
            const postage = await ethers.getContract('PostageStamp', deployer);
            const validityBlockTx = await postage.setMinimumValidityBlocks(1);
            await validityBlockTx.wait();
            const initialPaymentPerChunk = price1 * 2 - 1;
            const batchSize = 2 ** batch.depth;
            const transferAmount = initialPaymentPerChunk * batchSize;
            await mintAndApprove(deployer, deployer, postage.address, transferAmount.toString());
            const batchTx = await postage.createBatch(
              wallet.address,
              initialPaymentPerChunk,
              batch.depth,
              batch.bucketDepth,
              '0x00000000000000000000000000000000000000000000000000000000b0bafe77',
              batch.immutable
            );
            await mineNBlocks(1); // in order to expire batch
            await postage.expireLimited(1); // remove batch
            const batchReceipt = await batchTx.wait();
            const batchCreatedEvent = batchReceipt.events.filter((e: { event: string }) => e.event === 'BatchCreated');
            const batchId = Buffer.from(arrayify(batchCreatedEvent[0].args[0]));
            const chunkAddr = Buffer.from(proofParams.proof1.proveSegment);
            const { index, signature, timeStamp } = await constructPostageStamp(batchId, chunkAddr, wallet);

            proofParams.proof1.postageProof.postageId = batchId;
            proofParams.proof1.postageProof.signature = signature;
            proofParams.proof1.postageProof.index = index;
            proofParams.proof1.postageProof.timeStamp = timeStamp;

            await expect(
              r_node_5.claim(proofParams.proof1, proofParams.proof2, proofParams.proofLast)
            ).to.be.revertedWith(errors.claim.batchDoesNotExist);
          });

          it('postage bucket and address bucket do not match', async function () {
            const { proofParams } = await generatedSampling();

            const index = Buffer.from(proofParams.proof1.postageProof.index);
            index.writeUInt32BE(0, 0);
            proofParams.proof1.postageProof.index = index;

            await expect(
              r_node_5.claim(proofParams.proof1, proofParams.proof2, proofParams.proofLast)
            ).to.be.revertedWith(errors.claim.bucketDiffers);
          });

          it('wrong postage stamp signature', async function () {
            const { proofParams } = await generatedSampling();

            const index = Buffer.from(proofParams.proof1.postageProof.index);
            index.writeUInt32BE(1, 4);
            proofParams.proof1.postageProof.index = index;

            await expect(
              r_node_5.claim(proofParams.proof1, proofParams.proof2, proofParams.proofLast)
            ).to.be.revertedWith(errors.claim.sigRecoveryFailed);
          });
        });

        describe('should not claim pot because of inclusion proof checks', async () => {
          it('wrong proof segments for the reserve commitment', async function () {
            const { proofParams } = await generatedSampling();

            proofParams.proof1.proofSegments[0] = randomBytes(32);

            await expect(
              r_node_5.claim(proofParams.proof1, proofParams.proof2, proofParams.proofLast)
            ).to.be.revertedWith(errors.claim.inclusionProofFailed1);
          });

          it('wrong proof segments for the original chunk', async function () {
            const { proofParams } = await generatedSampling();

            proofParams.proof1.proofSegments2[1] = randomBytes(32);

            await expect(
              r_node_5.claim(proofParams.proof1, proofParams.proof2, proofParams.proofLast)
            ).to.be.revertedWith(errors.claim.inclusionProofFailed3);
          });

          it('wrong proof segments for the transformed chunk', async function () {
            const { proofParams } = await generatedSampling();

            proofParams.proof1.proofSegments3[1] = randomBytes(32);

            await expect(
              r_node_5.claim(proofParams.proof1, proofParams.proof2, proofParams.proofLast)
            ).to.be.revertedWith(errors.claim.inclusionProofFailed4);
          });

          it('first inclusion proof segment of transformed and original do not match', async function () {
            const { proofParams } = await generatedSampling();

            proofParams.proof1.proofSegments2[0] = randomBytes(32);

            await expect(
              r_node_5.claim(proofParams.proof1, proofParams.proof2, proofParams.proofLast)
            ).to.be.revertedWith(errors.claim.inclusionProofFailed2);
          });
        });

        describe('two commits with equal stakes', async function () {
          let priceOracle: Contract;
          let r_node_1: Contract;
          let r_node_5: Contract;
          let currentRound: number;
          let basePrice: number;
          let currentPriceUpScaled: number;
          let proof1: unknown, proof2: unknown, proofLast: unknown;

          // no need to mineToNode function call in test cases
          beforeEach(async () => {
            await startRoundFixture(3);
            // anchor fixture
            await mineToNode(redistribution, 5);

            priceOracle = await ethers.getContract('PriceOracle', deployer);

            r_node_1 = await ethers.getContract('Redistribution', node_1);
            r_node_5 = await ethers.getContract('Redistribution', node_5);

            // Set price base
            basePrice = await priceOracle.priceBase();
            currentRound = await r_node_1.currentRound();
            currentPriceUpScaled = await priceOracle.currentPriceUpScaled();

            const obfuscatedHash_1 = encodeAndHash(overlay_1_n_25, depth_5, hash_5, reveal_nonce_1);
            await r_node_1.commit(obfuscatedHash_1, currentRound);

            const obfuscatedHash_5 = encodeAndHash(overlay_5, depth_5, hash_5, reveal_nonce_5);
            await r_node_5.commit(obfuscatedHash_5, currentRound);

            proof1 = node5_proof1.proof1;
            proof2 = node5_proof1.proof2;
            proofLast = node5_proof1.proofLast;

            await mineToRevealPhase();
          });

          it('if only one reveal, should freeze non-revealer and select revealer as winner', async function () {
            const nodesInNeighbourhood = 1;

            //do not reveal node_1
            await r_node_5.reveal(depth_5, hash_5, reveal_nonce_5);

            expect((await r_node_5.currentReveals(0)).hash).to.be.eq(hash_5);
            expect((await r_node_5.currentReveals(0)).overlay).to.be.eq(overlay_5);
            expect((await r_node_5.currentReveals(0)).owner).to.be.eq(node_5);
            expect((await r_node_5.currentReveals(0)).stake).to.be.eq(effectiveStakeAmount_5);
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
              (receipt2.blockNumber - copyBatch.tx.blockNumber) * price1 * 2 ** copyBatch.postageDepth +
              (receipt2.blockNumber - stampCreatedBlock) * price1 * 2 ** batch.depth; // batch in the beforeHook

            expect(await token.balanceOf(node_5)).to.be.eq(expectedPotPayout);

            expect(CountCommitsEvent.args[0]).to.be.eq(2);
            expect(CountRevealsEvent.args[0]).to.be.eq(1);

            expect(WinnerSelectedEvent.args[0].owner).to.be.eq(node_5);
            expect(WinnerSelectedEvent.args[0].overlay).to.be.eq(overlay_5);
            expect(WinnerSelectedEvent.args[0].stake).to.be.eq(effectiveStakeAmount_5);

            expect(WinnerSelectedEvent.args[0].stakeDensity).to.be.eq(
              calculateStakeDensity(effectiveStakeAmount_5, Number(depth_5))
            );
            expect(WinnerSelectedEvent.args[0].hash).to.be.eq(hash_5);
            expect(WinnerSelectedEvent.args[0].depth).to.be.eq(parseInt(depth_5));

            expect(TruthSelectedEvent.args[0]).to.be.eq(hash_5);
            expect(TruthSelectedEvent.args[1]).to.be.eq(parseInt(depth_5));

            expect(WinnerSelectedEvent.args[0].depth).to.be.eq(parseInt(depth_5));

            // Check if the increase is properly applied, we have 3 skipped round here
            currentPriceUpScaled = (increaseRate[nodesInNeighbourhood] * currentPriceUpScaled) / basePrice;
            skippedRounds = 3;
            expect(await postage.lastPrice()).to.be.eq(
              await skippedRoundsIncrease(skippedRounds, currentPriceUpScaled, basePrice, increaseRate[0])
            );

            const sr = await ethers.getContract('StakeRegistry');

            //node_2 stake is preserved and not frozen
            expect(await sr.nodeEffectiveStake(node_2)).to.be.eq(stakeAmount_2);

            //node_1 is frozen but not slashed
            expect(await sr.nodeEffectiveStake(node_1)).to.be.eq(0);
          });

          it('if both reveal, should select correct winner', async function () {
            const nodesInNeighbourhood = 2;

            await r_node_1.reveal(depth_5, hash_5, reveal_nonce_1);
            await r_node_5.reveal(depth_5, hash_5, reveal_nonce_5);

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
              (receipt2.blockNumber - copyBatch.tx.blockNumber) * price1 * 2 ** copyBatch.postageDepth +
              (receipt2.blockNumber - stampCreatedBlock) * price1 * 2 ** batch.depth; // batch in the beforeHook

            expect(await token.balanceOf(node_5)).to.be.eq(expectedPotPayout);

            expect(CountCommitsEvent.args[0]).to.be.eq(2);
            expect(CountRevealsEvent.args[0]).to.be.eq(2);

            expect(WinnerSelectedEvent.args[0].owner).to.be.eq(node_5);
            expect(WinnerSelectedEvent.args[0].overlay).to.be.eq(overlay_5);
            expect(WinnerSelectedEvent.args[0].stake).to.be.eq(effectiveStakeAmount_5);
            expect(WinnerSelectedEvent.args[0].stakeDensity).to.be.eq(
              calculateStakeDensity(effectiveStakeAmount_5, Number(depth_5))
            );
            expect(WinnerSelectedEvent.args[0].hash).to.be.eq(hash_5);
            expect(WinnerSelectedEvent.args[0].depth).to.be.eq(parseInt(depth_5));

            // Check if the increase is properly applied, we have 3 skipped round here
            currentPriceUpScaled = (increaseRate[nodesInNeighbourhood] * currentPriceUpScaled) / basePrice;
            skippedRounds = 3;
            expect(await postage.lastPrice()).to.be.eq(
              await skippedRoundsIncrease(skippedRounds, currentPriceUpScaled, basePrice, increaseRate[0])
            );

            expect(TruthSelectedEvent.args[0]).to.be.eq(hash_5);
            expect(TruthSelectedEvent.args[1]).to.be.eq(parseInt(depth_5));

            const sr = await ethers.getContract('StakeRegistry');

            // node_1 stake is preserved and not frozen
            // stake is double the size as it has been deposited 2 times
            expect(await sr.nodeEffectiveStake(node_1)).to.be.eq(stakeAmount_1_n_25);

            //node_2 stake is preserved and not frozen
            expect(await sr.nodeEffectiveStake(node_5)).to.be.eq(stakeAmount_5);

            await expect(r_node_1.claim(proof1, proof2, proofLast)).to.be.revertedWith(errors.claim.alreadyClaimed);
          });

          it('if incorrect winner claims, correct winner is paid', async function () {
            await r_node_1.reveal(depth_5, hash_5, reveal_nonce_1);
            await r_node_5.reveal(depth_5, hash_5, reveal_nonce_5);

            await mineNBlocks(phaseLength);

            const tx2 = await r_node_5.claim(proof1, proof2, proofLast);
            const receipt2 = await tx2.wait();

            const expectedPotPayout =
              (receipt2.blockNumber - copyBatch.tx.blockNumber) * price1 * 2 ** copyBatch.postageDepth +
              (receipt2.blockNumber - stampCreatedBlock) * price1 * 2 ** batch.depth; // batch in the beforeHook
            expect(await token.balanceOf(node_5)).to.be.eq(expectedPotPayout);

            const sr = await ethers.getContract('StakeRegistry');

            // node_1 stake is preserved and not frozen
            expect(await sr.nodeEffectiveStake(node_5)).to.be.eq(stakeAmount_5);
            // node_2 stake is preserved and not frozen
            // amount is double the size on node_1 as deposit has been made twice
            expect(await sr.nodeEffectiveStake(node_1)).to.be.eq(stakeAmount_1_n_25);
          });

          // describe('testing skipped rounds and price changes', async function () {
          //   let priceOracle: Contract;
          //   let r_node_5: Contract;
          //   let r_node_6: Contract;
          //   let currentRound: number;
          //   let priceBaseNumber: number;

          //   beforeEach(async () => {
          //     // //  This 2 nodes are used for round 5
          //     const sr_node_5 = await ethers.getContract('StakeRegistry', node_5);
          //     await mintAndApprove(deployer, node_5, sr_node_5.address, stakeAmount_5);
          //     await sr_node_5.manageStake(node_5, nonce_5, stakeAmount_5);

          //     const sr_node_6 = await ethers.getContract('StakeRegistry', node_6);
          //     await mintAndApprove(deployer, node_6, sr_node_6.address, stakeAmount_6);
          //     await sr_node_6.manageStake(node_6, nonce_6, stakeAmount_6);

          //     priceOracle = await ethers.getContract('PriceOracle', deployer);

          //     // Set price base
          //     basePrice = await priceOracle.priceBase();
          //
          //     // We skip N rounds to test price changes, we choose 3 rounds as good enough random range
          //     // Each transaction mines one addtional block, so we get to phase limit after many transactions
          //     // So to offset that we need to substract number of blocks mined
          //     await mineNBlocks(roundLength * 3 - 10);

          //     r_node_5 = await ethers.getContract('Redistribution', node_5);
          //     r_node_6 = await ethers.getContract('Redistribution', node_6);

          //     currentRound = await r_node_5.currentRound();

          //     const obsfucatedHash_5 = encodeAndHash(overlay_5, depth_5, hash_5, reveal_nonce_5);
          //     await r_node_5.commit(obsfucatedHash_5, currentRound);

          //     const obsfucatedHash_6 = encodeAndHash(overlay_6, depth_6, hash_6, reveal_nonce_6);
          //     await r_node_6.commit(obsfucatedHash_6, currentRound);

          //     await mineNBlocks(phaseLength);

          //     await r_node_5.reveal( depth_5, hash_5, reveal_nonce_5);
          //     await r_node_6.reveal( depth_6, hash_6, reveal_nonce_6);
          //     await mineNBlocks(phaseLength - 1);

          //     expect(await r_node_5.isWinner(overlay_5)).to.be.true;
          //     expect(await r_node_6.isWinner(overlay_6)).to.be.false;

          //     await r_node_6.claim();
          //   });

          //   it('if both reveal, after 4 skipped rounds, check proper price increase', async function () {
          //     const nodesInNeighbourhood = 2;

          //     // Check if the increase is properly applied, we have four skipped rounds here
          //     const newPrice = Math.floor((increaseRate[nodesInNeighbourhood] * price1) / basePrice);
          //     skippedRounds = 4;
          //     expect(await postage.lastPrice()).to.be.eq(
          //       await skippedRoundsIncrease(skippedRounds, newPrice, basePrice, increaseRate[0])
          //     );
          //   });
          // });
        });
      });
    });
  });
});
