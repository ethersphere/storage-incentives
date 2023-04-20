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
          const sanityHash = '0x55bf7024605c9399996151d0dc3d0314cc7545df3c2ed07488767886ce0bee3b';
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
              '0x00000f192a4cca46896300f1a012b1cb37d5982a73881937a633aba17c592ff0',
              '0x18b12d79d59f5ebe7fe93d618e67258d0733c7524605ca1cce49ab8fa153b2ba',
              '0xa86c741126dadda7480790c8f06fb376ef5d14b511538c37a2aa6708f45d89d3',
              '0x2f80294a89371f799c271f81e4a978532aa1cc11093c4298cfcbd30da6560b51',
              '0x3ec366648492196cc175bb66162fefe42b3cd2818732a28650e103e1bbff89d2',
              '0x0eb01ebfc9ed27500cd4dfc979272d1f0913cc9f66540d7e8005811109e1cf2d',
              '0x887c22bd8750d34016ac3c66b5ff102dacdd73f6b014e710b51e8022af9a1968',
            ],
            proveSegment: '0x6990b9d3c121e232e1aee448367602c50a1addad3a5e79e2f4330f118dee8b0f',
            proofSegments2: [
              '0x83df47f3fef5f54c0ddf249ed0981ace619a9eac2e42c6dcb59c688d61ef6dc0',
              '0x43b87299a4396f171dbe7ecccfff796e9abc6694ed4e3563906ec51e26268a8c',
              '0xadc211ed02fe8e5a2d376a8f2bef4d0f82308758c2ac38023109b408e0e543e1',
              '0x6121b4142fd52360a2c26487dd4cee0afb9712ac8400dcb054c18dd55a458f33',
              '0x276be514bfb54ddca4f1828a13ee8ebf692922354539b0a62cb241f25d58b372',
              '0x0f956eff1fc3260331c1f745c1307cccd18c38e72f3998aefafff94dbdc397f2',
              '0x8ffb04a6b64e670d29c977952163e42a59714cef4aa840ecbb422df422c8906b',
            ],
            proveSegment2: '0x141e0e60163c674ae13d6a06c916a040c4170d79cc529c98d394b5fd35989d37',
            chunkSpan: 4096,
            proofSegments3: [
              '0x83df47f3fef5f54c0ddf249ed0981ace619a9eac2e42c6dcb59c688d61ef6dc0',
              '0x909aec456ab2b220d82749cc20591b3a42daf4d0bea5b24215c4a6cdffc42934',
              '0xe1315df2838f4eac38eba05b3c5caa05bd680ef628daf689cee22c6b1f192263',
              '0x3ae45243db92a5c6496351a3ba12223b507ecd74477b1dcf64332355cb1d2541',
              '0xc9f5566b14798a94b677c8c9dce520c32dc20a7d271c6aa46b74f61cc7c97a81',
              '0x1e0b7e137a9e722a2f0a38aac6907f3ed5ee50c185febccaa5b102b1f81b393d',
              '0xd38bb358743c354a4475af97d9ab50a8cfc49e607b141aaddeb608b5d13bc662',
            ],
            signer: '0x26234a2ad3ba8b398a762f279b792cfacd536a3f',
            signature:
              '0xdd4c9ee08e554c327964e8ecd404bfbbb7631abb1948920f5f2e1062af752e4239f469b89c1a51ab752d1f22baff34024813e00fb272538ef3175a67b3a720f31b',
            chunkAddr: '0x6990b9d3c121e232e1aee448367602c50a1addad3a5e79e2f4330f118dee8b0f',
            postageId: '0xc58cfde99cb6ae71c9485057c5e6194e303dba7a9e8a82201aa3a117a45237bb',
            index: '0x0000699000000025',
            timeStamp: '0x175190f7b03ad2c2',
            socProofAttached: [],
          };
          const proof2 = {
            proofSegments: [
              '0x000064a5ddfba477ef2311316ee62d7ab23e3c611a9c2efa3d8bcc05a1dd0418',
              '0x6f916eacf17f2d7a0df696fd757eb56f95ef66a9d3e323b5e9a5c1e81ae78e57',
              '0xa0ea9d1d1c5ad5afdfd4e4a5dfb4a70e547ff6020a3a3f90770d4df5d4c4ab62',
              '0xd419e6356e0609131fb841abbe512a6707e7df5849b81181ecc30d7c2e948b02',
              '0xdb5250abd7a2024fe90b242d366d758c88c88c5a1943db513d5cae7224000138',
              '0x0eb01ebfc9ed27500cd4dfc979272d1f0913cc9f66540d7e8005811109e1cf2d',
              '0x887c22bd8750d34016ac3c66b5ff102dacdd73f6b014e710b51e8022af9a1968',
            ],
            proveSegment: '0x590a83c704c1a883bc153c23a291a78ce14b18218bce064b56c393d2ec0ffc07',
            proofSegments2: [
              '0xfde8891e5c3cab4843aaf0d3df400207d0ad494c84d44470c8d1fb480049c147',
              '0xea157a10d804599a03674ebd14c130777eeced23bd09371f8e980bc3d21dbba9',
              '0xb576d0ef88df6ac978dd0d52b40f5ee437a47a348486e923b3dbb2dcd6308b75',
              '0xdf1ed31e8f4b243990910bfeaa7ae1bf838e9f282d9d9aa6f0c456556a20e4d1',
              '0xdc90bf97ab47be7eba03e6a30ebdacd5bd99b7cf05d751abada1a06bd99fdfcf',
              '0x3a5700f34adc77ade74968f08d4b9f9af5a59f5d9cda7729fb744cb36402dd74',
              '0x96ff7682efa0ab1a22a62ef2d7b581f222f4204d250c6aaf552175b2f911d87e',
            ],
            proveSegment2: '0x4dd8cb1939b1b3441637b3eaea0b6c4f533e1aaba928d0f60aa2fba53dbaad8f',
            chunkSpan: 4096,
            proofSegments3: [
              '0xfde8891e5c3cab4843aaf0d3df400207d0ad494c84d44470c8d1fb480049c147',
              '0x9f6e17194e7c27bcdbcabaa45bddaaec7452b9847c102df5b886e018219beecb',
              '0xedfe6f7e8ed37fb36010485d42690dfe1396e4d4fa3f479ea13e2486c3212e06',
              '0xdd55666f022fe20cddf5f81ff098633f29d2a74554315bef498e72761a2221ff',
              '0x794162c86e9726936ed6cc564b27e2c380f8a1a8b35fe5e586f1c0480cd62c8d',
              '0xa4dea10a9448d68d8e6459da9b7ecf5cda887219feac173ae82f465ccddf19cb',
              '0x774fc23407a7919f3ca6aea64af89ddd0cb3479bced64beaab7e5f3119ee3385',
            ],
            signer: '0x26234a2ad3ba8b398a762f279b792cfacd536a3f',
            signature:
              '0x3d10c2327318acf8fda2202c44afe5fc27527b7732c7a6cb5cc95fec2700e87927051c78c1dd83c07724aea63c7d624165330ff76a0ad42a4bb808b68ad7bacc1b',
            chunkAddr: '0x590a83c704c1a883bc153c23a291a78ce14b18218bce064b56c393d2ec0ffc07',
            postageId: '0xc58cfde99cb6ae71c9485057c5e6194e303dba7a9e8a82201aa3a117a45237bb',
            index: '0x0000590a00000023',
            timeStamp: '0x175220d4c695281f',
            socProofAttached: [],
          };
          const proofLast = {
            proofSegments: [
              '0x00006829034ff570fe03a91f72437ebc27f1718b77f3ea5ae10c28dad3b87569',
              '0x92bed13ea63cb001694d7cd0b1d8ed4a9ca9759ceca92eccd76809b718cecc4f',
              '0xa0ea9d1d1c5ad5afdfd4e4a5dfb4a70e547ff6020a3a3f90770d4df5d4c4ab62',
              '0xd419e6356e0609131fb841abbe512a6707e7df5849b81181ecc30d7c2e948b02',
              '0xdb5250abd7a2024fe90b242d366d758c88c88c5a1943db513d5cae7224000138',
              '0x0eb01ebfc9ed27500cd4dfc979272d1f0913cc9f66540d7e8005811109e1cf2d',
              '0x887c22bd8750d34016ac3c66b5ff102dacdd73f6b014e710b51e8022af9a1968',
            ],
            proveSegment: '0x6980bcddb97047aaaec76772114013651ca2e9031f92f3cc1e8136ff6c3a78aa',
            proofSegments2: [
              '0x3467db541a584350980b7e800a0aaf1af051ead96d8e23122c4532b987fed52f',
              '0x952f6770eefcc7833e8b7ed8820d49727744aef56edbc25bf4c501c3aa6d183f',
              '0x9b7f8c36036f5e66b021e3253420e295c678910af2d03a6da78f118f7f69c8de',
              '0xf3634f753f61d222067483d1676ea8afda2d897c0b9b0e4eec29b179861ecc59',
              '0x68cbbff270cfeae0648800731f4359980d8c0bf66faf0e4d1f96a4251101801b',
              '0x8bd62add431a4441e59d2f0f83362d52a446949227a160407098f61464459516',
              '0xb758a8c76cff96c102fd7eba3c4a6d44aa0c05f15f49a6428924430aedafb952',
            ],
            proveSegment2: '0xfa654ebfd40bf7cdaa27504fbd5cc938ba4d76f327f08a5d1efefc67ccba7772',
            chunkSpan: 4096,
            proofSegments3: [
              '0x3467db541a584350980b7e800a0aaf1af051ead96d8e23122c4532b987fed52f',
              '0xcbb1f10676559d66add0aa2ada272ca132f6748e6d760800bc174ecf781ddf28',
              '0xa480f6103cbf3168a3ecdc762ec2555fbb5ef80aa60f3c173d6e9ca7c28045e4',
              '0x8a9692bd18745062d5c16265217f470ce8432209716eb7f22839fbcdfbe2d869',
              '0x7950319d18c93a71bd170e22d2e6f07e8bb919f8153c87c6cdfab53b6d31d2a5',
              '0x6d53b3aee05b9b4e4cc4286ffbf35187f4fde5a6aa93902c344401e15e71c917',
              '0x014b3dff33c6856ae822e433f43c00c8fe1bfae79aa2bcdaf90f76c464a4a6e5',
            ],
            signer: '0x26234a2ad3ba8b398a762f279b792cfacd536a3f',
            signature:
              '0xb0428004374d42a20e6381a896f9a65819c9179c089471a01288b0b33f0994b342decd062fa67ec3c9ae8d7fcd838a75da39bc3b972e80366f06eea73576a6291b',
            chunkAddr: '0x6980bcddb97047aaaec76772114013651ca2e9031f92f3cc1e8136ff6c3a78aa',
            postageId: '0xc58cfde99cb6ae71c9485057c5e6194e303dba7a9e8a82201aa3a117a45237bb',
            index: '0x0000698000000030',
            timeStamp: '0x1752c0bf80b32258',
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
