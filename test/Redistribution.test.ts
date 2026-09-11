import { expect } from './util/chai';
import { ethers, deployments, getNamedAccounts } from 'hardhat';
import { BigNumber, Contract, ContractTransaction } from 'ethers';
import {
  STS_PHASES,
  mineToPhase,
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

const increaseRate = [1049417, 1049206, 1048996, 1048786, 1048576, 1048366, 1048156, 1047946, 1047736];

// round anchor after startRoundFixture()
const round2Anchor = '0xac33ff75c19e70fe83507db0d683fd3465c996598dc972688b7ace676c89077b';
// start round number after mintToNode(red, 0) -> without claim
const roundAnchorBase = '0xa54b3e90672405a607381bd4d34034a12c5aad31607067a7ad26573f504ad6e2';

// SWIP-050 binds a commitment to its round and fixes the chunk transform root in stage one.
// These tests exercise the commit/reveal state machine rather than the stamp binding, so they
// use an empty root; the binding itself is covered in test/RedistributionSts.test.ts.
const ZERO_ROOT = '0x0000000000000000000000000000000000000000000000000000000000000000';

async function commitHash(
  overlay: string,
  depth: string,
  hash: string,
  nonce: string,
  round?: number
): Promise<string> {
  const redistribution = await ethers.getContract('Redistribution');
  const commitRound = round ?? (await redistribution.currentRound()).toNumber();
  return encodeAndHash(commitRound, overlay, depth, hash, ZERO_ROOT, nonce);
}

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
const stakeAmount_0_n_2 = '400000000000000000';
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
    notStaked: 'NotStaked()',
    mustStake2Rounds: 'MustStake2Rounds()',
    alreadyCommitted: 'AlreadyCommitted()',
    depthNotGreaterThanHeight: 'DepthNotGreaterThanHeight()',
    outOfDepth: 'OutOfDepth()',
  },
  reveal: {
    noCommits: 'NoCommitsReceived()',
    doNotMatch: 'NoMatchingCommit()',
    outOfDepthReveal: 'OutOfDepthReveal()',
    notInReveal: 'NotRevealPhase()',
    depthMismatch: 'DepthMismatch()',
  },
  claim: {
    noReveals: 'NoReveals()',
    alreadyClaimed: 'AlreadyClaimed()',
    randomCheckFailed: 'RandomElementCheckFailed()',
    outOfDepth: 'OutOfDepthClaim',
    reserveCheckFailed: 'ReserveCheckFailed()',
    indexOutsideSet: 'IndexOutsideSet()',
    batchNotUsable: 'BatchNotUsableForRedistribution',
    batchBelowThreshold: 'BatchNotUsableForTargetRound',
    bucketDiffers: 'BucketDiffers()',
    sigRecoveryFailed: 'SigRecoveryFailed()',
    inclusionProofFailed1: 'InclusionProofFailed',
    inclusionProofFailed2: 'InclusionProofFailed',
    inclusionProofFailed3: 'InclusionProofFailed',
    inclusionProofFailed4: 'InclusionProofFailed',
    socVerificationFailed: 'SocVerificationFailed()',
    socCalcNotMatching: 'SocCalcNotMatching()',
  },
  deposit: {
    noBalance: 'ERC20: insufficient allowance',
    noZeroAddress: 'owner cannot be the zero address',
    onlyOwner: 'Unauthorized()',
    belowMinimum: 'BelowMinimumStake()',
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
      await expect(r_node_0.commit(obfuscatedHash_0, currentRound, depth_0)).to.be.revertedWith(
        errors.commit.notStaked
      );
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
        errors.commit.mustStake2Rounds
      );
    });

    it('should create a commit with staked node', async function () {
      const sr_node_0 = await ethers.getContract('StakeRegistry', node_0);
      await mintAndApprove(deployer, node_0, sr_node_0.address, stakeAmount_0);
      await sr_node_0.manageStake(nonce_0, stakeAmount_0, height_0);

      expect(await redistribution.currentPhaseCommit()).to.be.true;

      const r_node_0 = await ethers.getContract('Redistribution', node_0);
      await expect(r_node_0['isParticipatingInUpcomingRound(address,uint8)'](node_0, depth_0)).to.be.revertedWith(
        errors.commit.mustStake2Rounds
      );
    });

    it('should create a commit with staked node and height 2 and not have enough funds', async function () {
      const sr_node_0 = await ethers.getContract('StakeRegistry', node_0);
      await mintAndApprove(deployer, node_0, sr_node_0.address, stakeAmount_0);

      await expect(sr_node_0.manageStake(nonce_0, stakeAmount_0, height_0_n_2)).to.be.revertedWith(
        errors.deposit.belowMinimum
      );
    });

    it('should create a commit with staked node and height 2', async function () {
      const sr_node_0 = await ethers.getContract('StakeRegistry', node_0);
      await mintAndApprove(deployer, node_0, sr_node_0.address, stakeAmount_0_n_2);
      await sr_node_0.manageStake(nonce_0, stakeAmount_0_n_2, height_0_n_2);

      expect(await redistribution.currentPhaseCommit()).to.be.true;

      const r_node_0 = await ethers.getContract('Redistribution', node_0);
      await expect(r_node_0['isParticipatingInUpcomingRound(address,uint8)'](node_0, depth_0)).to.be.revertedWith(
        errors.commit.mustStake2Rounds
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
        // On CI we can occasionally see an extra mined block (e.g. a leftover tx from fixtures
        // being mined after we snapshot the block number). The round logic is what matters.
        expect(await getBlockNumber()).to.be.gte(initialBlockNumber + roundLength);
        expect(await redistribution.currentRound()).to.be.eq(startRoundNumber + 1);
      });

      it('should be in the correct phase', async function () {
        const initialBlockNumber = await getBlockNumber();
        expect(await redistribution.currentPhaseCommit()).to.be.true;

        await mineNBlocks(phaseLength);
        expect(await getBlockNumber()).to.be.gte(initialBlockNumber + phaseLength);
        expect(await redistribution.currentPhaseReveal()).to.be.true;

        // SWIP-050 inserts stamp commit, stamp reveal and proof submission between reveal and
        // claim, so the claim phase now opens at block 133 of the round rather than 76.
        await mineNBlocks(STS_PHASES.stampCommit - STS_PHASES.chunkReveal);
        expect(await redistribution.currentPhaseStampCommit()).to.be.true;

        await mineNBlocks(STS_PHASES.stampReveal - STS_PHASES.stampCommit);
        expect(await redistribution.currentPhaseStampReveal()).to.be.true;

        await mineNBlocks(STS_PHASES.proof - STS_PHASES.stampReveal);
        expect(await redistribution.currentPhaseProof()).to.be.true;

        await mineNBlocks(STS_PHASES.claim - STS_PHASES.proof);
        expect(await redistribution.currentPhaseClaim()).to.be.true;
      });
    });

    describe('utilities', function () {
      it('should correctly wrap a commit', async function () {
        const obfuscatedHash = await commitHash(overlay_0, depth_0, hash_0, reveal_nonce_0);

        const round = (await redistribution.currentRound()).toNumber();
        expect(await redistribution.wrapCommit(round, overlay_0, depth_0, hash_0, ZERO_ROOT, reveal_nonce_0)).to.be.eq(
          obfuscatedHash
        );
      });

      it('should correctly wrap another commit', async function () {
        const obfuscatedHash = await commitHash(overlay_3, depth_3, hash_3, reveal_nonce_3);

        expect(
          await redistribution.wrapCommit(
            (await redistribution.currentRound()).toNumber(),
            overlay_3,
            depth_3,
            hash_3,
            ZERO_ROOT,
            reveal_nonce_3
          )
        ).to.be.eq(obfuscatedHash);
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

        // Once the chunk sample hash reveal phase is over, this round's anchor is spent, so
        // currentRoundAnchor looks ahead from the stamp commit phase onward. Before SWIP-050
        // that switch happened at the claim phase, which was the next phase.
        await mineNBlocks(STS_PHASES.stampCommit - STS_PHASES.chunkReveal);
        const nextAnchor = nextAnchorIfNoReveal(ZERO_32_BYTES, startRoundNumber + 1);
        expect(await redistribution.currentPhaseStampCommit()).to.be.true;
        expect(await redistribution.currentRoundAnchor()).to.be.eq(nextAnchor);

        // Into the commit phase of the next round, where the anchor just derived becomes current.
        await mineNBlocks(roundLength - STS_PHASES.stampCommit);
        expect(await redistribution.currentRound()).to.be.eq(startRoundNumber + 1);
        expect(await redistribution.currentRoundAnchor()).to.be.eq(nextAnchor);
      });

      it('should reject a commit if the overlay is out of reported depth', async function () {
        expect(await redistribution.currentPhaseCommit()).to.be.true;
        const r_node_3 = await ethers.getContract('Redistribution', node_3);
        expect(await redistribution.currentRoundAnchor()).to.be.eq(round2Anchor);

        const obfuscatedHash = await commitHash(overlay_3, '0x08', hash_3, reveal_nonce_3);
        expect(
          await r_node_3.wrapCommit(
            (await r_node_3.currentRound()).toNumber(),
            overlay_3,
            '0x08',
            hash_3,
            ZERO_ROOT,
            reveal_nonce_3
          )
        ).to.be.eq(obfuscatedHash);
        const currentRound = await r_node_3.currentRound();
        // SWIP-51: proximity is now enforced at commit time, so this out-of-depth commit reverts.
        await expect(r_node_3.commit(obfuscatedHash, currentRound, '0x08')).to.be.revertedWith(
          errors.commit.outOfDepth
        );
      });

      it('should reject an out-of-depth commit but accept a valid one once height is increased', async function () {
        expect(await redistribution.currentPhaseCommit()).to.be.true;
        const r_node_3 = await ethers.getContract('Redistribution', node_3);
        expect(await redistribution.currentRoundAnchor()).to.be.eq(round2Anchor);

        const obfuscatedHash = await commitHash(overlay_3, '0x08', hash_3, reveal_nonce_3);
        expect(
          await r_node_3.wrapCommit(
            (await r_node_3.currentRound()).toNumber(),
            overlay_3,
            '0x08',
            hash_3,
            ZERO_ROOT,
            reveal_nonce_3
          )
        ).to.be.eq(obfuscatedHash);
        const currentRound = await r_node_3.currentRound();
        await expect(r_node_3.commit(obfuscatedHash, currentRound, '0x08')).to.be.revertedWith(
          errors.commit.outOfDepth
        );

        // Change height and check if node is playing.
        // manageStake always resets lastUpdatedBlockNumber, so wait 2 rounds even on amount=0.
        const sr_node_3 = await ethers.getContract('StakeRegistry', node_3);
        await sr_node_3.manageStake(nonce_3, 0, height_3_n_2);
        await mineNBlocks(roundLength * 2);
        await startRoundFixture();
        await mineToNode(redistribution, 3);

        expect(await redistribution.currentPhaseCommit()).to.be.true;
        const obfuscatedHash2 = await commitHash(overlay_3, depth_3, hash_3, reveal_nonce_3);
        const currentRound2 = await r_node_3.currentRound();

        await expect(r_node_3.commit(obfuscatedHash2, currentRound2, depth_3))
          .to.emit(redistribution, 'Committed')
          .withArgs(currentRound2, overlay_3, height_3_n_2, parseInt(depth_3));

        expect((await r_node_3.currentCommits(0)).obfuscatedHash).to.be.eq(obfuscatedHash2);

        await mineToPhase(STS_PHASES.chunkReveal);
        await r_node_3.reveal(depth_3, hash_3, ZERO_ROOT, reveal_nonce_3);

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

        const obfuscatedHash = await commitHash(overlay_2, depth_2, hash_2, reveal_nonce_2);

        const currentRound = await r_node_2.currentRound();

        await expect(r_node_2.commit(obfuscatedHash, currentRound, depth_2))
          .to.emit(redistribution, 'Committed')
          .withArgs(currentRound, overlay_2, height_2, parseInt(depth_2));

        expect((await r_node_2.currentCommits(0)).obfuscatedHash).to.be.eq(obfuscatedHash);

        await mineToPhase(STS_PHASES.chunkReveal);

        await r_node_2.reveal(depth_2, hash_2, ZERO_ROOT, reveal_nonce_2);

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

        const obfuscatedHash = await commitHash(overlay_2, depth_2, hash_2, reveal_nonce_2);

        const currentRound = await r_node_2.currentRound();

        await expect(r_node_2.commit(obfuscatedHash, currentRound, depth_2))
          .to.emit(redistribution, 'Committed')
          .withArgs(currentRound, overlay_2, height_2_n_2, parseInt(depth_2));

        expect((await r_node_2.currentCommits(0)).obfuscatedHash).to.be.eq(obfuscatedHash);

        await mineToPhase(STS_PHASES.chunkReveal);

        await r_node_2.reveal(depth_2, hash_2, ZERO_ROOT, reveal_nonce_2);

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
        // Commit at depth 1 with a hash that will not match the reveal pre-image.
        await r_node_0.commit(obfuscatedHash_0, currentRound, '0x01');

        const commit_0 = await r_node_0.currentCommits(0);
        expect(commit_0.overlay).to.be.eq(overlay_0);
        expect(commit_0.obfuscatedHash).to.be.eq(obfuscatedHash_0);

        expect(await getBlockNumber()).to.be.gte(initialBlockNumber + 1);

        await mineToRevealPhase();

        expect(await r_node_0.currentPhaseReveal()).to.be.true;

        // Same declared depth, but scrambled reveal args → NoMatchingCommit.
        await expect(r_node_0.reveal('0x01', reveal_nonce_0, ZERO_ROOT, revealed_overlay_0)).to.be.revertedWith(
          errors.reveal.doNotMatch
        );
      });

      it('should not allow duplicate commits', async function () {
        expect(await redistribution.currentPhaseCommit()).to.be.true;

        const r_node_2 = await ethers.getContract('Redistribution', node_2);

        const obfuscatedHash = await commitHash(overlay_2, depth_2, hash_2, reveal_nonce_2);

        const currentRound = await r_node_2.currentRound();

        // node_2 is within proximity of round2Anchor at depth 1 (depth must exceed height 0).
        await r_node_2.commit(obfuscatedHash, currentRound, '0x01');

        expect((await r_node_2.currentCommits(0)).obfuscatedHash).to.be.eq(obfuscatedHash);

        await expect(r_node_2.commit(obfuscatedHash, currentRound, '0x01')).to.be.revertedWith(
          errors.commit.alreadyCommitted
        );
      });
    });

    describe('reveal phase', async function () {
      it('should not allow an overlay to reveal without commits', async function () {
        const initialBlockNumber = await getBlockNumber();
        expect(await redistribution.currentPhaseCommit()).to.be.true;

        await mineToPhase(STS_PHASES.chunkReveal);
        expect(await redistribution.currentPhaseReveal()).to.be.true;
        expect(await redistribution.currentPhaseReveal()).to.be.true;

        const r_node_0 = await ethers.getContract('Redistribution', node_0);

        await expect(r_node_0.reveal(depth_0, reveal_nonce_0, ZERO_ROOT, revealed_overlay_0)).to.be.revertedWith(
          errors.reveal.noCommits
        );
      });

      it('should not allow reveal in commit phase', async function () {
        expect(await redistribution.currentPhaseCommit()).to.be.true;

        const r_node_0 = await ethers.getContract('Redistribution', node_0);

        // First make a commit so we can test phase validation
        const currentRound = await r_node_0.currentRound();
        await r_node_0.commit(obfuscatedHash_0, currentRound, '0x01');

        await expect(r_node_0.reveal(depth_0, reveal_nonce_0, ZERO_ROOT, revealed_overlay_0)).to.be.revertedWith(
          errors.reveal.notInReveal
        );
      });

      it('should not allow reveal in claim phase', async function () {
        const initialBlockNumber = await getBlockNumber();
        expect(await redistribution.currentPhaseCommit()).to.be.true;

        expect(await getBlockNumber()).to.be.eq(initialBlockNumber);
        expect(await redistribution.currentPhaseReveal()).to.be.false;

        const r_node_0 = await ethers.getContract('Redistribution', node_0);

        // First make a commit so we can test phase validation
        const currentRound = await r_node_0.currentRound();
        await r_node_0.commit(obfuscatedHash_0, currentRound, '0x01');

        await mineToPhase(STS_PHASES.claim);
        expect(await redistribution.currentPhaseClaim()).to.be.true;

        // commented out to allow other tests to pass for now
        await expect(r_node_0.reveal(depth_0, reveal_nonce_0, ZERO_ROOT, revealed_overlay_0)).to.be.revertedWith(
          errors.reveal.notInReveal
        );
      });

      it('should not allow an overlay to reveal with the incorrect nonce', async function () {
        const initialBlockNumber = await getBlockNumber();
        expect(await redistribution.currentPhaseCommit()).to.be.true;

        const r_node_2 = await ethers.getContract('Redistribution', node_2);

        const obfuscatedHash = await commitHash(overlay_2, '0x01', hash_2, reveal_nonce_2);

        const currentRound = await r_node_2.currentRound();
        await r_node_2.commit(obfuscatedHash, currentRound, '0x01');

        await mineToPhase(STS_PHASES.chunkReveal);
        expect(await redistribution.currentPhaseReveal()).to.be.true;
        expect(await redistribution.currentPhaseReveal()).to.be.true;

        await expect(r_node_2.reveal('0x01', hash_2, ZERO_ROOT, reveal_nonce_f)).to.be.revertedWith(
          errors.reveal.doNotMatch
        );
      });

      it('should not allow an overlay to reveal without with the incorrect depth', async function () {
        const initialBlockNumber = await getBlockNumber();
        expect(await redistribution.currentPhaseCommit()).to.be.true;

        const r_node_2 = await ethers.getContract('Redistribution', node_2);
        const obfuscatedHash = await commitHash(overlay_2, '0x01', hash_2, reveal_nonce_2);

        const currentRound = await r_node_2.currentRound();
        await r_node_2.commit(obfuscatedHash, currentRound, '0x01');

        await mineToPhase(STS_PHASES.chunkReveal);
        expect(await redistribution.currentPhaseReveal()).to.be.true;
        expect(await redistribution.currentPhaseReveal()).to.be.true;

        // Depth differs from declaredDepth → DepthMismatch (SWIP-51).
        await expect(r_node_2.reveal(depth_f, hash_2, ZERO_ROOT, reveal_nonce_2)).to.be.revertedWith(
          errors.reveal.depthMismatch
        );
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
        const obfuscatedHash = await commitHash(overlay_2, depth_2, hash_2, reveal_nonce_2);

        const currentRound = await r_node_2.currentRound();
        await r_node_2.commit(obfuscatedHash, parseInt(currentRound), depth_2);

        await mineToPhase(STS_PHASES.chunkReveal);
        expect(await redistribution.currentPhaseReveal()).to.be.true;
        expect(await redistribution.currentPhaseReveal()).to.be.true;

        await expect(r_node_2.reveal(depth_2, hash_2, ZERO_ROOT, reveal_nonce_2))
          .to.emit(redistribution, 'Revealed')
          .withArgs(currentRound, overlay_2, effectiveStakeAmount_2, '6399999999998976000', hash_2, parseInt(depth_2));
      });
    });

    // The chunk-sample claim path this block exercised no longer exists: SWIP-050 replaces it
    // with the STS-1 stamp witness path, covered end to end in test/RedistributionSts.test.ts.
  });

  describe('SWIP-51 Option B', function () {
    let redistribution: Contract;
    let token: Contract;

    beforeEach(async function () {
      await deployments.fixture();
      redistribution = await ethers.getContract('Redistribution');
      token = await ethers.getContract('TestToken');

      const sr_node_2 = await ethers.getContract('StakeRegistry', node_2);
      await mintAndApprove(deployer, node_2, sr_node_2.address, stakeAmount_2);
      await sr_node_2.manageStake(nonce_2, stakeAmount_2, height_2);

      const sr_node_0 = await ethers.getContract('StakeRegistry', node_0);
      await mintAndApprove(deployer, node_0, sr_node_0.address, stakeAmount_0);
      await sr_node_0.manageStake(nonce_0, stakeAmount_0, height_0);

      await mineNBlocks(roundLength * 2);
      await startRoundFixture();
      await mineToNode(redistribution, 2);
    });

    it('rejects commit when depth is not greater than height', async function () {
      const r_node_2 = await ethers.getContract('Redistribution', node_2);
      const currentRound = await r_node_2.currentRound();
      const obfuscatedHash = await commitHash(overlay_2, '0x00', hash_2, reveal_nonce_2);

      await expect(r_node_2.commit(obfuscatedHash, currentRound, '0x00')).to.be.revertedWith(
        errors.commit.depthNotGreaterThanHeight
      );
    });

    it('rejects reveal when depth does not match declaredDepth', async function () {
      const r_node_2 = await ethers.getContract('Redistribution', node_2);
      const currentRound = await r_node_2.currentRound();
      // The obfuscated hash encodes depth 6 (so the reveal at depth 6 resolves the commit), but the
      // declaredDepth passed to commit is 1. The reveal then trips the declaredDepth mismatch check.
      const obfuscatedHash = await commitHash(overlay_2, depth_2, hash_2, reveal_nonce_2);
      await r_node_2.commit(obfuscatedHash, currentRound, '0x01');

      await mineToPhase(STS_PHASES.chunkReveal);
      await expect(r_node_2.reveal(depth_2, hash_2, ZERO_ROOT, reveal_nonce_2)).to.be.revertedWith(
        errors.reveal.depthMismatch
      );
    });

    it('next-round commit gate auto-finalizes the prior round', async function () {
      const r_node_2 = await ethers.getContract('Redistribution', node_2);
      const sr = await ethers.getContract('StakeRegistry');
      const currentRound = await r_node_2.currentRound();
      const obfuscatedHash = await commitHash(overlay_2, '0x01', hash_2, reveal_nonce_2);
      await r_node_2.commit(obfuscatedHash, currentRound, '0x01');
      expect(await sr.nodeEffectiveStake(node_2)).to.not.eq(0);

      // Advance exactly one round into the next commit phase. Use node_0 so the
      // prior non-revealer (node_2), frozen by finalize, is not also the committer.
      await mineNBlocks(roundLength);
      // Stay in commit phase: mineToNode can skip many rounds while searching for proximity.
      // Depth-1 commit only needs PO>=1; mine until node_0 is close enough at depth 1.
      let seed = await redistribution.currentSeed();
      while (proximity(seed, overlay_0) < 1) {
        await mineNBlocks(roundLength);
        seed = await redistribution.currentSeed();
      }
      // Ensure we are in the commit phase of whatever round we landed on.
      while (!(await redistribution.currentPhaseCommit())) {
        await mineNBlocks(1);
      }

      const nextRound = await redistribution.currentRound();
      expect(nextRound).to.be.gt(currentRound);
      expect(await redistribution.participationFinalized(currentRound)).to.be.false;

      const r_node_0 = await ethers.getContract('Redistribution', node_0);
      const obfuscatedHash0 = await commitHash(overlay_0, '0x01', hash_0, reveal_nonce_0);
      const minFreezeDepth = await redistribution.MIN_NONREVEAL_FREEZE_DEPTH();
      const expectedFreeze = BigNumber.from(2).mul(roundLength).mul(BigNumber.from(2).pow(minFreezeDepth));
      await expect(r_node_0.commit(obfuscatedHash0, nextRound, '0x01'))
        .to.emit(redistribution, 'ParticipationFinalized')
        .withArgs(currentRound, 0)
        .and.to.emit(sr, 'StakeFrozen')
        .withArgs(node_2, overlay_2, expectedFreeze);

      expect(await redistribution.participationFinalized(currentRound)).to.be.true;
      // Non-revealer is frozen → effective stake reads as 0.
      expect(await sr.nodeEffectiveStake(node_2)).to.be.eq(0);
    });

    it('rejects a no-show closer after auto-finalize so they cannot take the next slot', async function () {
      const r_node_2 = await ethers.getContract('Redistribution', node_2);
      const sr = await ethers.getContract('StakeRegistry');
      const currentRound = await r_node_2.currentRound();
      await r_node_2.commit(await commitHash(overlay_2, '0x01', hash_2, reveal_nonce_2), currentRound, '0x01');

      await mineNBlocks(roundLength);
      let seed = await redistribution.currentSeed();
      while (proximity(seed, overlay_2) < 1) {
        await mineNBlocks(roundLength);
        seed = await redistribution.currentSeed();
      }
      while (!(await redistribution.currentPhaseCommit())) {
        await mineNBlocks(1);
      }

      const nextRound = await redistribution.currentRound();
      expect(nextRound).to.be.gt(currentRound);

      await expect(r_node_2.commit(await commitHash(overlay_2, '0x01', hash_2, reveal_nonce_2), nextRound, '0x01'))
        .to.emit(redistribution, 'ParticipationFinalized')
        .withArgs(currentRound, 0)
        .and.to.emit(redistribution, 'CommitRejected')
        .withArgs(nextRound, overlay_2);

      expect(await redistribution.participationFinalized(currentRound)).to.be.true;
      expect(await sr.nodeEffectiveStake(node_2)).to.be.eq(0);
      expect(await redistribution.currentCommitRound()).to.be.eq(nextRound);

      seed = await redistribution.currentSeed();
      while (proximity(seed, overlay_0) < 1) {
        await mineNBlocks(roundLength);
        seed = await redistribution.currentSeed();
      }
      while (!(await redistribution.currentPhaseCommit())) {
        await mineNBlocks(1);
      }
      const admitRound = await redistribution.currentRound();
      const r_node_0 = await ethers.getContract('Redistribution', node_0);
      await expect(
        r_node_0.commit(await commitHash(overlay_0, '0x01', hash_0, reveal_nonce_0), admitRound, '0x01')
      ).to.emit(redistribution, 'Committed');
    });

    // Under SWIP-050 a stage one commit is unfinished until it is proof validated, so a
    // revealer that never proved is frozen exactly like a no-show, and a round with no proof
    // validated entry selects no truth at all: the freeze then falls back to the floor depth
    // rather than to some participant's self-reported one.
    it('freezes both the no-show and the revealer that never proved', async function () {
      const r_node_2 = await ethers.getContract('Redistribution', node_2);
      const r_node_0 = await ethers.getContract('Redistribution', node_0);
      const sr = await ethers.getContract('StakeRegistry');

      let seed = await redistribution.currentSeed();
      while (proximity(seed, overlay_0) < 6 || proximity(seed, overlay_2) < 1) {
        await mineNBlocks(roundLength);
        seed = await redistribution.currentSeed();
      }
      while (!(await redistribution.currentPhaseCommit())) {
        await mineNBlocks(1);
      }

      const currentRound = await redistribution.currentRound();
      await r_node_2.commit(await commitHash(overlay_2, '0x01', hash_2, reveal_nonce_2), currentRound, '0x01');
      await r_node_0.commit(await commitHash(overlay_0, depth_0, hash_0, reveal_nonce_0), currentRound, depth_0);

      await mineToPhase(STS_PHASES.chunkReveal);
      await r_node_0.reveal(depth_0, hash_0, ZERO_ROOT, reveal_nonce_0);

      await mineNBlocks(roundLength);
      seed = await redistribution.currentSeed();
      while (proximity(seed, overlay_0) < 1) {
        await mineNBlocks(roundLength);
        seed = await redistribution.currentSeed();
      }
      while (!(await redistribution.currentPhaseCommit())) {
        await mineNBlocks(1);
      }

      const nextRound = await redistribution.currentRound();
      const floorDepth = await redistribution.MIN_NONREVEAL_FREEZE_DEPTH();
      const expectedFreeze = BigNumber.from(2).mul(roundLength).mul(BigNumber.from(2).pow(floorDepth));

      await expect(r_node_0.commit(await commitHash(overlay_0, '0x01', hash_0, reveal_nonce_0), nextRound, '0x01'))
        .to.emit(redistribution, 'ParticipationFinalized')
        .withArgs(currentRound, 1)
        .and.to.emit(sr, 'StakeFrozen')
        .withArgs(node_2, overlay_2, expectedFreeze);

      expect(await sr.nodeEffectiveStake(node_2)).to.be.eq(0);
    });

    it('exposes stake-weighted admissionPriority (lower is better with higher stake)', async function () {
      const seed = await redistribution.currentSeed();
      const round = await redistribution.currentRound();
      const low = await redistribution.admissionPriority(round, seed, overlay_2, 1);
      const high = await redistribution.admissionPriority(round, seed, overlay_2, stakeAmount_2);
      expect(high.lt(low)).to.be.true;
    });
  });
});
