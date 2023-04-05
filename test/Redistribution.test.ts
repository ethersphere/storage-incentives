import { expect } from './util/chai';
import { ethers, deployments, getNamedAccounts } from 'hardhat';
import { BigNumber, Contract, getDefaultProvider, providers, Wallet } from 'ethers';
import { mineNBlocks, getBlockNumber, encodeAndHash, mintAndApprove } from './util/tools';

const phaseLength = 38;
const roundLength = 152;

const increaseRate = [0, 1036, 1027, 1025, 1024, 1023, 1021, 1017, 1012];

const round2Anchor = '0xa6eef7e35abe7026729641147f7915573c7e97b47efa546f5f6e3230263bcb49';
const round3AnchoIfNoReveals = '0xac33ff75c19e70fe83507db0d683fd3465c996598dc972688b7ace676c89077b';

const maxInt256 = 0xffff; //js can't handle the full maxInt256 value

// Named accounts used by tests.
let deployer: string, stamper: string;

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
const stakeAmount_1 = '100000000000000000';
const nonce_1 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';
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
const depth_5 = '0x02';
const reveal_nonce_5 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';

// Before the tests, assign accounts
before(async function () {
  const namedAccounts = await getNamedAccounts();
  deployer = namedAccounts.deployer;
  stamper = namedAccounts.stamper;
  node_0 = namedAccounts.node_0;
  node_1 = namedAccounts.node_1;
  node_2 = namedAccounts.node_2;
  node_3 = namedAccounts.node_3;
  node_4 = namedAccounts.node_4;
  node_5 = namedAccounts.node_5;
});

const errors = {
  commit: {
    notOwner: 'owner must match sender',
    notStaked: 'stake must exceed minimum',
    stakedRecently: 'stake updated recently',
    alreadyCommited: 'only one commit each per round',
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

        const currentRound = await r_node_3.currentRound();
        await r_node_3.commit(obsfucatedHash, overlay_3, currentRound);

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
          expect(await redistribution.currentPhaseCommit()).to.be.true;
          const r_node_5 = await ethers.getContract('Redistribution', node_5);
          const sanityHash = '0x68f0edd3c3dc674236c7a27ee5c06fdc65b18ec9a532e21a15393d77d3aa24aa';
          const sanityDepth = '0x00'; //TODO with depth 2 (sampling with the correct overlay)

          const obsfucatedHash = encodeAndHash(overlay_5, sanityDepth, sanityHash, reveal_nonce_5);

          const currentRound = await r_node_5.currentRound();
          const currentSeed = await redistribution.currentSeed();
          console.log('Anchor', currentSeed);
          await r_node_5.commit(obsfucatedHash, overlay_5, currentRound);

          expect((await r_node_5.currentCommits(0)).obfuscatedHash).to.be.eq(obsfucatedHash);

          await mineNBlocks(phaseLength);

          await r_node_5.reveal(overlay_5, sanityDepth, sanityHash, reveal_nonce_2);

          const currentSeeed = await redistribution.currentSeed();
          console.log('Anchor2', currentSeeed);

          expect((await r_node_5.currentReveals(0)).hash).to.be.eq(sanityHash);
          expect((await r_node_5.currentReveals(0)).overlay).to.be.eq(overlay_5);
          expect((await r_node_5.currentReveals(0)).owner).to.be.eq(node_5);
          expect((await r_node_5.currentReveals(0)).stake).to.be.eq(stakeAmount_5);
          expect((await r_node_5.currentReveals(0)).depth).to.be.eq(parseInt(sanityDepth));

          await mineNBlocks(phaseLength);
          const proof1 = {
            proofSegments: [
              '0x000046fa2570ad9d3e29fc7174f2b2dee13febc77d28a11a5339a32c0507ec4d',
              '0xa897b7e490aa0825b4d950415b1d200a237af2e41f5d951e68830a9a8243a4c5',
              '0xeaaddfb6b5e2b7b0d1e026816824cee29964153fdff5f0beba9b07fb9bb47547',
              '0x0927f60771ca65552e75d8f79d75c60d5b5ce10d341519e0df120eb63ee22d0f',
              '0x00c80922a147fe02dfae9d0f479668b77f0f65d87f18b901f38a62b531054117',
              '0x0eb01ebfc9ed27500cd4dfc979272d1f0913cc9f66540d7e8005811109e1cf2d',
              '0x887c22bd8750d34016ac3c66b5ff102dacdd73f6b014e710b51e8022af9a1968',
            ],
            proveSegment: '0x506208613c9f517152251de468b48892f279c8d39a7112d0494de9f6281f5cfd',
            proofSegments2: [
              '0x315bf9838e71d8210240c23c2159ecb4a52a133b663f93fc8012a079c7283798',
              '0x914c28674d542979dbe19ce49dd78a40d5826fb7d0fd44139d5b3f39436c6209',
              '0x0c86a4bd6293c08351deefb62612e28cdf563ed82944929d041f70d638b1e62d',
              '0x81b41c2aa8eaf9561b0499d7b2155e7d0e1a4b88d81fbcea6bc034bb07ce7099',
              '0xce8ce57fdd4ef6912a463ea9dbdc50d1ff136cb14e5fade92b116635cd0ee7d0',
              '0x5dd96db629bbbe4d751db3ce7591a3446165f87baeae3f9e038124725d3771f3',
              '0x1a841c60cb299453e4414ea8b4afdb5470595f73234722f9925545ca49007f5f',
            ],
            proveSegment2: '0xedbcddde9e2570df6e4e320f9859a46ddc9b47904f33cdc22d8885d462ffb5b0',
            chunkSpan: 4096,
            proofSegments3: [
              '0x315bf9838e71d8210240c23c2159ecb4a52a133b663f93fc8012a079c7283798',
              '0x720ebcf3fe3244ac69519fe74a162d31623feba9e07b842566c1aa0b2495ff93',
              '0x2231123bd58d7ad9476ace8d61eb78c2d77206343a135ad1215765f9a0ffeba9',
              '0xaf2354e89aeec4697d1043d5f67e17b580e4cfa40f276e1e4e1dba6f3f6f286d',
              '0xbcfda2209908e1d557bf9c308348675d7373530d502f8f4db3d9feed8f204b5b',
              '0xe6c8ec4b033bf61d98b7e53120e66489dab793a38d0721839ec9984a84894017',
              '0x09f7e6f6f70d0262656e91289c8ee0a5df36686a877b6a185a4aba8ad6239948',
            ],
            signer: '0x26234a2ad3ba8b398a762f279b792cfacd536a3f',
            signature:
              '0x54e892bc39e760b2212016889bc1b82d6fbb6e044a109d4a9828830bb5f2ea2a77251f0b142a589d8635e707786e3be68bc6a5f87eb3e7a8f16819891e6579d11b',
            chunkAddr: '0x506208613c9f517152251de468b48892f279c8d39a7112d0494de9f6281f5cfd',
            postageId: '0xc58cfde99cb6ae71c9485057c5e6194e303dba7a9e8a82201aa3a117a45237bb',
            index: '0x000050620000000f',
            timeStamp: '0x175173b0fbc488a3',
            socProofAttached: [],
          };
          const proof2 = {
            proofSegments: [
              '0x0000c0500c74c6a6201d0aa4349b4d4399a136156b111207d3c1285de58bdc08',
              '0x5a5d171be4828e358c5beef2580400becf69a087f340e06f4c26fdf722938298',
              '0x6e4a802ef7af46a1dbc09648d6f527e3a156dac39b338a98b59791c6c9acb80e',
              '0x29a54b68c80366632f7a5da3849d44c6ac7fe34057483060eaeed7e028c21617',
              '0x79cc755e6634f472c743f9522dbccdf49314d3823be409b085b42436588878fd',
              '0x0eb01ebfc9ed27500cd4dfc979272d1f0913cc9f66540d7e8005811109e1cf2d',
              '0x887c22bd8750d34016ac3c66b5ff102dacdd73f6b014e710b51e8022af9a1968',
            ],
            proveSegment: '0x66fe8ec62b532cd397b59cd9f2f50a57c698a04b5c9f42bb2e432db8c659f11d',
            proofSegments2: [
              '0x2286cca7fd51ab30e573c33f0e03a40833345b1db9ec1aa156e585379912d40a',
              '0x47ba7f4568d8fbb4d3d7d211cedf329927e65129530233b07d7fdb2214a5a239',
              '0x5e53ed23000a33d5db1d0719bd6917003d91f3cc53746e762bc85605fd6ae6b7',
              '0x0e2dfb4b5b71ac1d016c7361e1788f567e3ea8bdb82e625944ba18976d6eac3e',
              '0x3fa9e8ef6b21f91dd0707713bd1c2e321dcd1d2261fb2c4c60159d76120e1a7a',
              '0xe3ffab1f353520057ee198ce759e2f4bc3a7de46e058dd03c763b961cdced73a',
              '0xb1b6c47e389147f020c067f248770676c68c6d93dc45fc3995c4821ef8aaf655',
            ],
            proveSegment2: '0xacab96a91176330f0be68acf5a79761fa6aed3716fa524106c98a3dc6bdb6eee',
            chunkSpan: 4096,
            proofSegments3: [
              '0x2286cca7fd51ab30e573c33f0e03a40833345b1db9ec1aa156e585379912d40a',
              '0x6d4781d8bf806915712f8bb5bdc6617d7c62b9a152b7e092c302823a4d4e9f27',
              '0x55122159abd98e04c513c5e0fa1335741ec8a95ee5f9ccf828adf9018e5deeac',
              '0x10affdb0b3d54ec7214246ed0d8aaf22aa5d3f9b3d0552ce038c6ae0b8844501',
              '0x952898b0ac301c0adfe2efa3f974253e64428d4f4615953d9ebfbc8c7ac027a9',
              '0xf6ff2d1e8a913c12df8656e23b9b072119d27c94ea4061e908d2db4bb95ed13e',
              '0xc21d9575c126015b603a0b7591484d716bf5987f1e354b75447205df5e16c473',
            ],
            signer: '0x26234a2ad3ba8b398a762f279b792cfacd536a3f',
            signature:
              '0x2d81f504f2d4dfd740f077fca3d7e52adf392bf810b08b1d86cb8fca75340f9729ccdcb2304d0bd967a002ad11ddb949df4326167557271034f2cf611a20f93b1b',
            chunkAddr: '0x66fe8ec62b532cd397b59cd9f2f50a57c698a04b5c9f42bb2e432db8c659f11d',
            postageId: '0xc58cfde99cb6ae71c9485057c5e6194e303dba7a9e8a82201aa3a117a45237bb',
            index: '0x000066fe00000025',
            timeStamp: '0x17519106a71e7360',
            socProofAttached: [],
          };
          const proofLast = {
            proofSegments: [
              '0x0000d583bd3b31260ce2208e756907ca2385a409b6785dbd43616a28965bcce4',
              '0x4a7982c1e030bfedc49eebc06f3521baebb021851c5dc5c256ddd945f3477bb0',
              '0x6e4a802ef7af46a1dbc09648d6f527e3a156dac39b338a98b59791c6c9acb80e',
              '0x29a54b68c80366632f7a5da3849d44c6ac7fe34057483060eaeed7e028c21617',
              '0x79cc755e6634f472c743f9522dbccdf49314d3823be409b085b42436588878fd',
              '0x0eb01ebfc9ed27500cd4dfc979272d1f0913cc9f66540d7e8005811109e1cf2d',
              '0x887c22bd8750d34016ac3c66b5ff102dacdd73f6b014e710b51e8022af9a1968',
            ],
            proveSegment: '0x7d9f8f77a88fefb813050911e2f2d3b07687348004f786d3e9282dbf65bafe4e',
            proofSegments2: [
              '0x5f5062500ad07960935ca2d5a4162de872ee755c856586b5a5a40cdfbe6c3c3e',
              '0x56f40ecbde394c4bed4412838939979ec71ee3392de25df88fd7314c23e193d8',
              '0xd4198d19dec00d00e081b47ec1bf261684efb2d3833e39f663489eb4520e3944',
              '0xad27e0e971ec6e813590d66968114f951da15e772ed330fa682a1bded3cd9a35',
              '0x1794f901233be79a4075af9b4d39fae1db43e9065314b2909328d1982cc8e6d3',
              '0x997c84f55704f9e6146f08753b5400df0e717e8263b0f877022339e10ad14a7b',
              '0x0a4039c5d200874f61c570fe632b9f96c43614580b67e2dab8f3e058d29ee853',
            ],
            proveSegment2: '0x3a083361212560c68c1bdebffaa2ff02d7962d8b9d040e4cdb4639d01311791e',
            chunkSpan: 4096,
            proofSegments3: [
              '0x5f5062500ad07960935ca2d5a4162de872ee755c856586b5a5a40cdfbe6c3c3e',
              '0xe9a701f13309492778a9f3c28ffbc30ab6ed919aac09036f158ab99c7fbe5e19',
              '0xfb9d1dba010d7658ae53400dc9c09373cbfa0a3bdfaddaf8f14e570a9b269417',
              '0x5c9fda5e3d50f6804168c457de264b7516db6950cb1d3fa160e52d3307d8cb9c',
              '0x1441ea808197e2d8b89d5fe2bb83028a39c7ff449ea91a634e2560e9f59ea1cc',
              '0x3cf619c97f029287ae3fd78932f5ded765bc72c5ba1c7676d045511e22d5cf90',
              '0xb887be343a4078915b502d4cbee5cbe321543008bf04bf90a24926e65db86891',
            ],
            signer: '0x26234a2ad3ba8b398a762f279b792cfacd536a3f',
            signature:
              '0xfd17d3df147a08ef41d777fc71d085d80e7a6bf3d02af7362b176602672daefa17088d6e7eea1f54456e08e0208336081dbde84e0ab17be86a1cc71307cd3a3b1b',
            chunkAddr: '0x7d9f8f77a88fefb813050911e2f2d3b07687348004f786d3e9282dbf65bafe4e',
            postageId: '0xc58cfde99cb6ae71c9485057c5e6194e303dba7a9e8a82201aa3a117a45237bb',
            index: '0x00007d9f00000019',
            timeStamp: '0x1751873a0eb5bfa1',
            socProofAttached: [],
          };
          // migrate batch with which the chunk was signed
          const postageAdmin = await ethers.getContract('PostageStamp', deployer);
          // set minimum required blocks for postage stamp lifetime to 0 for tests
          // NOTE: it does not work if copy above (until claim function)
          await postageAdmin.setMinimumValidityBlocks(0);
          const initialBalance = 100_000_000;
          const postageDepth = 27;
          const bzzFund = BigNumber.from(initialBalance).mul(BigNumber.from(2).pow(postageDepth));
          await mintAndApprove(deployer, deployer, postage.address, bzzFund.toString());
          const copyBatchTx = await postageAdmin.copyBatch(
            '0x26234a2ad3ba8b398a762f279b792cfacd536a3f', // owner
            initialBalance, // initial balance per chunk
            postageDepth, // depth
            16, // bucketdepth
            '0xc58cfde99cb6ae71c9485057c5e6194e303dba7a9e8a82201aa3a117a45237bb',
            true // immutable
          );
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

          const currentBlockNumber = await getBlockNumber();
          const expectedPotPayout = (currentBlockNumber - copyBatchTx.blockNumber) * price1 * 2 ** 20; // TODO

          expect(await token.balanceOf(node_2)).to.be.eq(expectedPotPayout);

          expect(CountCommitsEvent.args[0]).to.be.eq(1);
          expect(CountRevealsEvent.args[0]).to.be.eq(1);

          expect(WinnerSelectedEvent.args[0][0]).to.be.eq(node_5);
          expect(WinnerSelectedEvent.args[0][1]).to.be.eq(overlay_5);
          expect(WinnerSelectedEvent.args[0][2]).to.be.eq(stakeAmount_5);
          expect(WinnerSelectedEvent.args[0][3]).to.be.eq(
            BigNumber.from(stakeAmount_0).mul(BigNumber.from(2).pow(sanityDepth))
          ); //stakedensity?
          expect(WinnerSelectedEvent.args[0][4]).to.be.eq(sanityHash);
          expect(WinnerSelectedEvent.args[0][5]).to.be.eq(parseInt(sanityDepth));

          expect(TruthSelectedEvent.args[0]).to.be.eq(sanityHash);
          expect(TruthSelectedEvent.args[1]).to.be.eq(parseInt(sanityDepth));
        });
      });

      describe('two commits with equal stakes', async function () {
        let priceOracle: Contract;
        let r_node_1: Contract;
        let r_node_2: Contract;
        let currentRound: number;

        beforeEach(async () => {
          priceOracle = await ethers.getContract('PriceOracle', deployer);
          await priceOracle.unPause(); // TODO: remove when price oracle is not paused by default.

          r_node_1 = await ethers.getContract('Redistribution', node_1);
          r_node_2 = await ethers.getContract('Redistribution', node_2);

          currentRound = await r_node_1.currentRound();

          const obsfucatedHash_1 = encodeAndHash(overlay_1, depth_1, hash_1, reveal_nonce_1);
          await r_node_1.commit(obsfucatedHash_1, overlay_1, currentRound);

          const obsfucatedHash_2 = encodeAndHash(overlay_2, depth_2, hash_2, reveal_nonce_2);
          await r_node_2.commit(obsfucatedHash_2, overlay_2, currentRound);

          await mineNBlocks(phaseLength);
        });

        it('if only one reveal, should freeze non-revealer and select revealer as winner', async function () {
          const nodesInNeighbourhood = 1;

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

          const currentBlockNumber = await getBlockNumber();
          const expectedPotPayout = (currentBlockNumber - stampCreatedBlock) * price1 * 2 ** batch.depth;

          expect(await token.balanceOf(node_2)).to.be.eq(expectedPotPayout);

          expect(CountCommitsEvent.args[0]).to.be.eq(2);
          expect(CountRevealsEvent.args[0]).to.be.eq(1);

          expect(WinnerSelectedEvent.args[0][0]).to.be.eq(node_2);
          expect(WinnerSelectedEvent.args[0][1]).to.be.eq(overlay_2);
          expect(WinnerSelectedEvent.args[0][2]).to.be.eq(stakeAmount_2);

          expect(WinnerSelectedEvent.args[0][3]).to.be.eq('6400000000000000000');
          expect(WinnerSelectedEvent.args[0][4]).to.be.eq(hash_2);
          expect(WinnerSelectedEvent.args[0][5]).to.be.eq(parseInt(depth_2));

          expect(TruthSelectedEvent.args[0]).to.be.eq(hash_2);
          expect(TruthSelectedEvent.args[1]).to.be.eq(parseInt(depth_2));

          expect(WinnerSelectedEvent.args[0][5]).to.be.eq(parseInt(depth_2));

          const newPrice = (increaseRate[nodesInNeighbourhood] * price1) / 1024;
          expect(await postage.lastPrice()).to.be.eq(newPrice);

          const sr = await ethers.getContract('StakeRegistry');

          //node_2 stake is preserved and not frozen
          expect(await sr.usableStakeOfOverlay(overlay_2)).to.be.eq(stakeAmount_2);

          //node_1 is frozen but not slashed
          expect(await sr.usableStakeOfOverlay(overlay_1)).to.be.eq(0);
        });

        it('if both reveal, should select correct winner', async function () {
          const nodesInNeighbourhood = 2;

          await r_node_1.reveal(overlay_1, depth_1, hash_1, reveal_nonce_1);
          await r_node_2.reveal(overlay_2, depth_2, hash_2, reveal_nonce_2);

          await mineNBlocks(phaseLength);

          expect(await r_node_1.isWinner(overlay_1)).to.be.false;
          expect(await r_node_2.isWinner(overlay_2)).to.be.true;

          const tx2 = await r_node_1.claim();
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

          const currentBlockNumber = await getBlockNumber();
          const expectedPotPayout = (currentBlockNumber - stampCreatedBlock) * price1 * 2 ** batch.depth;

          expect(await token.balanceOf(node_2)).to.be.eq(expectedPotPayout);

          expect(CountCommitsEvent.args[0]).to.be.eq(2);
          expect(CountRevealsEvent.args[0]).to.be.eq(2);

          expect(WinnerSelectedEvent.args[0][0]).to.be.eq(node_2);
          expect(WinnerSelectedEvent.args[0][1]).to.be.eq(overlay_2);
          expect(WinnerSelectedEvent.args[0][2]).to.be.eq(stakeAmount_2);
          expect(WinnerSelectedEvent.args[0][3]).to.be.eq('6400000000000000000'); //stakedensity?
          expect(WinnerSelectedEvent.args[0][4]).to.be.eq(hash_2);
          expect(WinnerSelectedEvent.args[0][5]).to.be.eq(parseInt(depth_2));

          const newPrice = (increaseRate[nodesInNeighbourhood] * price1) / 1024;
          expect(await postage.lastPrice()).to.be.eq(newPrice);

          expect(TruthSelectedEvent.args[0]).to.be.eq(hash_2);
          expect(TruthSelectedEvent.args[1]).to.be.eq(parseInt(depth_2));

          const sr = await ethers.getContract('StakeRegistry');

          //node_1 stake is preserved and not frozen
          expect(await sr.usableStakeOfOverlay(overlay_1)).to.be.eq(stakeAmount_1);

          //node_2 stake is preserved and not frozen
          expect(await sr.usableStakeOfOverlay(overlay_2)).to.be.eq(stakeAmount_2);

          await expect(r_node_1.claim()).to.be.revertedWith(errors.claim.alreadyClaimed);
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
      });
    });
  });
});
