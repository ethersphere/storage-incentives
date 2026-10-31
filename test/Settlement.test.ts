import { expect } from './util/chai';
import { ethers, network } from 'hardhat';
import { BigNumber, Contract, Signer } from 'ethers';

// Settlement replaces Redistribution: the game runs off chain (prover/crates/vm), this contract checks
// the public inputs of a proof against the chain and executes the outcome. These tests use
// SP1MockVerifier, so they exercise everything except the proof itself.

const ROUND_LENGTH = 152;
const COMMIT_END = 38;
const ANCHOR_END = 57;
const SEED_OFFSET = 114;
const coder = ethers.utils.defaultAbiCoder;
const { keccak256, solidityPack } = ethers.utils;

const PV_TYPE =
  'tuple(' +
  'tuple(uint256 chainId,address settlement,uint64 round,bytes32 roundAnchor,bytes32 selectionSeed,' +
  'bytes32 commitsHash,uint32 commitCount,bytes32 forcedCommitsHash,bytes32 forcedRevealsHash,' +
  'uint64 lastClaimRound,uint8 lastWinnerDepth,uint8 penaltyMultiplierDisagreement,' +
  'uint8 penaltyMultiplierNonRevealed,uint8 penaltyRandomFactor,address[] participants,bytes32 stakeDigest,' +
  'uint32 stakePrice) inputs,' +
  'tuple(bool hasTruth,bytes32 truthHash,uint8 truthDepth,address winner,bytes32 winnerOverlay,' +
  'uint256 winnerStakeDensity,uint16 redundancy,address[] freezeOwners,uint256[] freezeDurations) outcome)';

const ZERO = ethers.constants.HashZero;

async function mineTo(block: number) {
  const now = await ethers.provider.getBlockNumber();
  if (block > now) await network.provider.send('hardhat_mine', ['0x' + (block - now).toString(16)]);
}

// Mine so that the NEXT transaction lands at `offset` within a round.
async function mineToOffset(offset: number, minRound = 0) {
  const now = await ethers.provider.getBlockNumber();
  let round = Math.max(Math.floor((now + 1) / ROUND_LENGTH), minRound);
  if (round * ROUND_LENGTH + offset <= now) round++;
  await mineTo(round * ROUND_LENGTH + offset - 1);
  return round;
}

describe('Settlement', function () {
  let deployer: Signer;
  let nodes: Signer[];
  let token: Contract, postage: Contract, oracle: Contract, staking: Contract, settlement: Contract;

  beforeEach(async function () {
    const signers = await ethers.getSigners();
    deployer = signers[0];
    nodes = signers.slice(6, 10);

    token = await (await ethers.getContractFactory('TestToken')).deploy('sBZZ', 'sBZZ', '1' + '0'.repeat(30));
    postage = await (await ethers.getContractFactory('PostageStamp')).deploy(token.address, 16);
    oracle = await (await ethers.getContractFactory('PriceOracle')).deploy(postage.address);
    staking = await (await ethers.getContractFactory('StakeRegistry')).deploy(token.address, 0, oracle.address);
    const verifier = await (await ethers.getContractFactory('SP1MockVerifier')).deploy();
    settlement = await (
      await ethers.getContractFactory('Settlement')
    ).deploy(staking.address, postage.address, oracle.address, verifier.address, keccak256('0x01'));

    await postage.grantRole(await postage.PRICE_ORACLE_ROLE(), oracle.address);
    await postage.grantRole(await postage.REDISTRIBUTOR_ROLE(), settlement.address);
    await staking.grantRole(await staking.REDISTRIBUTOR_ROLE(), settlement.address);
    await oracle.grantRole(await oracle.PRICE_UPDATER_ROLE(), settlement.address);
    await oracle.setPrice(24000);

    // A batch so the pot grows.
    await token.approve(postage.address, ethers.constants.MaxUint256);
    const perChunk = (await postage.minimumInitialBalancePerChunk()).mul(2);
    await postage.createBatch(await deployer.getAddress(), perChunk, 20, 17, ZERO, false);

    for (const [i, n] of nodes.entries()) {
      const stake = BigNumber.from('100000000000000000').mul(i + 1);
      await token.transfer(await n.getAddress(), stake);
      await token.connect(n).approve(staking.address, stake);
      await staking.connect(n).manageStake(keccak256(solidityPack(['uint8'], [i])), stake, 0);
    }
    // Stakes must be older than two rounds.
    await mineTo((await ethers.provider.getBlockNumber()) + 3 * ROUND_LENGTH);
  });

  async function stakeDigest(owners: string[]) {
    let d = ZERO;
    for (const o of owners) {
      const r = await staking.stakes(o);
      d = keccak256(
        solidityPack(
          ['bytes32', 'address', 'bytes32', 'uint256', 'uint256', 'uint8', 'uint256'],
          [d, o, r.overlay, r.committedStake, r.potentialStake, r.height, r.lastUpdatedBlockNumber]
        )
      );
    }
    return d;
  }

  // Public values as the VM would produce them for `round`, with the outcome supplied by the test.
  async function publicValues(round: number, participants: string[], outcome: Record<string, unknown>) {
    const ri = await settlement.rounds(round);
    return {
      inputs: {
        chainId: network.config.chainId,
        settlement: settlement.address,
        round,
        roundAnchor: ri.roundAnchor,
        selectionSeed: await settlement.selectionSeed(round),
        commitsHash: ri.commitsHash,
        commitCount: ri.commitCount,
        forcedCommitsHash: ri.forcedCommitsHash,
        forcedRevealsHash: ri.forcedRevealsHash,
        lastClaimRound: await settlement.lastClaimRound(),
        lastWinnerDepth: await settlement.lastWinnerDepth(),
        penaltyMultiplierDisagreement: 1,
        penaltyMultiplierNonRevealed: 2,
        penaltyRandomFactor: 100,
        participants,
        stakeDigest: await stakeDigest(participants),
        stakePrice: await oracle.currentPrice(),
      },
      outcome: {
        hasTruth: false,
        truthHash: ZERO,
        truthDepth: 0,
        winner: ethers.constants.AddressZero,
        winnerOverlay: ZERO,
        winnerStakeDensity: 0,
        redundancy: 0,
        freezeOwners: [],
        freezeDurations: [],
        ...outcome,
      },
    };
  }

  const encode = (pv: unknown) => coder.encode([PV_TYPE], [pv]);

  async function anchoredRound(commitsHash = keccak256('0x'), count = 0) {
    const round = await mineToOffset(COMMIT_END);
    await settlement.anchorRound(round, commitsHash, count, ZERO);
    return round;
  }

  describe('phases', function () {
    it('only anchors in the anchor phase, once, with ANCHOR_ROLE', async function () {
      let round = await mineToOffset(COMMIT_END - 1);
      await expect(settlement.anchorRound(round, ZERO, 0, ZERO)).to.be.revertedWith('NotAnchorPhase');
      round = await mineToOffset(COMMIT_END);
      await expect(settlement.connect(nodes[0]).anchorRound(round, ZERO, 0, ZERO)).to.be.revertedWith('NotAdmin');
      await expect(settlement.anchorRound(round + 1, ZERO, 0, ZERO)).to.be.revertedWith('WrongRound');
      await settlement.anchorRound(round, ZERO, 0, ZERO);
      await expect(settlement.anchorRound(round, ZERO, 0, ZERO)).to.be.revertedWith('AlreadyAnchored');
      const ri = await settlement.rounds(round);
      expect(ri.anchored).to.be.true;
      expect(ri.roundAnchor).to.eq(await settlement.roundAnchor(round));
    });

    it('keeps forced commits and reveals as hash chains, inside their windows', async function () {
      const round = await mineToOffset(10);
      const a = await nodes[0].getAddress();
      const b = await nodes[1].getAddress();
      await settlement.connect(nodes[0]).forceCommit(round, keccak256('0x01'));
      await settlement.connect(nodes[1]).forceCommit(round, keccak256('0x02'));
      let expected = keccak256(solidityPack(['bytes32', 'address', 'bytes32'], [ZERO, a, keccak256('0x01')]));
      expected = keccak256(solidityPack(['bytes32', 'address', 'bytes32'], [expected, b, keccak256('0x02')]));
      expect((await settlement.rounds(round)).forcedCommitsHash).to.eq(expected);

      await expect(settlement.forceReveal(round, ZERO, 1, ZERO, ZERO)).to.be.revertedWith('NotRevealPhase');
      await mineToOffset(ANCHOR_END, round);
      await expect(settlement.forceCommit(round, ZERO)).to.be.revertedWith('NotCommitPhase');
      await settlement.forceReveal(round, keccak256('0x03'), 2, keccak256('0x04'), keccak256('0x05'));
      const r = keccak256(
        solidityPack(
          ['bytes32', 'bytes32', 'uint8', 'bytes32', 'bytes32'],
          [ZERO, keccak256('0x03'), 2, keccak256('0x04'), keccak256('0x05')]
        )
      );
      expect((await settlement.rounds(round)).forcedRevealsHash).to.eq(r);
    });

    it('seed is unavailable until after the seed block', async function () {
      const round = await anchoredRound();
      await mineTo(round * ROUND_LENGTH + SEED_OFFSET - 1);
      await expect(settlement.selectionSeed(round)).to.be.revertedWith('SeedNotAvailable');
      await mineTo(round * ROUND_LENGTH + SEED_OFFSET + 1);
      expect(await settlement.selectionSeed(round)).to.not.eq(ZERO);
    });
  });

  describe('helpers match the VM encoding', function () {
    it('wrapCommit and commitDigest', async function () {
      const o = keccak256('0x0a');
      expect(await settlement.wrapCommit(o, 3, ZERO, ZERO)).to.eq(
        keccak256(solidityPack(['bytes32', 'uint8', 'bytes32', 'bytes32'], [o, 3, ZERO, ZERO]))
      );
      const typehash = keccak256(
        ethers.utils.toUtf8Bytes(
          'SwarmSettlementCommit(uint256 chainId,address settlement,uint64 round,bytes32 obfuscatedHash)'
        )
      );
      expect(await settlement.commitDigest(7, o)).to.eq(
        keccak256(
          coder.encode(
            ['bytes32', 'uint256', 'address', 'uint64', 'bytes32'],
            [typehash, network.config.chainId, settlement.address, 7, o]
          )
        )
      );
    });
  });

  describe('settleRound', function () {
    it('pays the winner, pays the prover fee, freezes, adjusts price, moves game state', async function () {
      const owners = await Promise.all(nodes.map((n) => n.getAddress()));
      const round = await anchoredRound(keccak256('0xaa'), 4);
      await mineTo(round * ROUND_LENGTH + SEED_OFFSET + 1);

      const winner = owners[1];
      const frozen = owners[3];
      const pv = await publicValues(round, owners, {
        hasTruth: true,
        truthHash: keccak256('0xbb'),
        truthDepth: 2,
        winner,
        winnerOverlay: await staking.overlayOfAddress(winner),
        winnerStakeDensity: 1,
        redundancy: 3,
        freezeOwners: [frozen],
        freezeDurations: [2 * ROUND_LENGTH * 4],
      });

      const prover = nodes[0];
      const before = await token.balanceOf(winner);
      const proverBefore = await token.balanceOf(owners[0]);
      const tx = await settlement.connect(prover).settleRound(encode(pv), '0x');
      const rc = await tx.wait();

      const won = (await token.balanceOf(winner)).sub(before);
      const fee = (await token.balanceOf(owners[0])).sub(proverBefore);
      expect(won.gt(0)).to.be.true;
      expect(fee).to.eq(won.add(fee).mul(100).div(10000));
      expect(await staking.lastUpdatedBlockNumberOfAddress(frozen)).to.eq(rc.blockNumber + 2 * ROUND_LENGTH * 4);
      expect(await settlement.lastClaimRound()).to.eq(round);
      expect(await settlement.lastWinnerDepth()).to.eq(2);
      expect(await settlement.lastSettledRound()).to.eq(round);
      const topics = rc.logs.map((l: { topics: string[] }) => l.topics[0]);
      expect(topics).to.include(oracle.interface.getEventTopic('PriceUpdate'));
      expect(topics).to.include(settlement.interface.getEventTopic('RoundSettled'));

      await expect(settlement.settleRound(encode(pv), '0x')).to.be.revertedWith('AlreadySettled');
    });

    it('stake digest does not change when a freeze expires between proving and settling', async function () {
      // Regression: the first version hashed nodeEffectiveStake, which flips to 0 and back with the block
      // number while a node is frozen. A proof built one block before the expiry then failed InputMismatch(8).
      const owners = await Promise.all(nodes.map((n) => n.getAddress()));
      const r1 = await anchoredRound();
      await mineTo(r1 * ROUND_LENGTH + SEED_OFFSET + 1);
      const pv1 = await publicValues(r1, owners, {
        hasTruth: true,
        truthHash: keccak256('0xbb'),
        winner: owners[0],
        redundancy: 1,
        freezeOwners: [owners[3]],
        freezeDurations: [ROUND_LENGTH + 10],
      });
      await settlement.settleRound(encode(pv1), '0x');
      const frozenUntil = (await staking.lastUpdatedBlockNumberOfAddress(owners[3])).toNumber();

      const r2 = await mineToOffset(COMMIT_END, r1 + 1);
      await settlement.anchorRound(r2, keccak256('0x'), 0, ZERO);
      await mineTo(Math.max(r2 * ROUND_LENGTH + SEED_OFFSET + 1, frozenUntil - 1));
      const pv2 = await publicValues(r2, owners, {});
      await mineTo(frozenUntil + 2);
      await settlement.settleRound(encode(pv2), '0x');
      expect(await settlement.lastSettledRound()).to.eq(r2);
    });

    it('a round without truth changes nothing but is marked settled', async function () {
      const round = await anchoredRound();
      await mineTo(round * ROUND_LENGTH + SEED_OFFSET + 1);
      const pv = await publicValues(round, [], {});
      await settlement.settleRound(encode(pv), '0x');
      expect(await settlement.lastSettledRound()).to.eq(round);
      expect(await settlement.lastClaimRound()).to.eq(0);
    });

    it('rejects public inputs that do not match the chain', async function () {
      const owners = await Promise.all(nodes.map((n) => n.getAddress()));
      const round = await anchoredRound();
      await mineTo(round * ROUND_LENGTH + SEED_OFFSET + 1);
      const good = await publicValues(round, owners, {});

      const cases: [number, (pv: any) => void][] = [
        [0, (pv) => (pv.inputs.chainId = 1)],
        [1, (pv) => (pv.inputs.roundAnchor = keccak256('0x01'))],
        [2, (pv) => (pv.inputs.selectionSeed = keccak256('0x01'))],
        [3, (pv) => (pv.inputs.commitsHash = keccak256('0x01'))],
        [3, (pv) => (pv.inputs.commitCount = 9)],
        [4, (pv) => (pv.inputs.forcedCommitsHash = keccak256('0x01'))],
        [5, (pv) => (pv.inputs.forcedRevealsHash = keccak256('0x01'))],
        [6, (pv) => (pv.inputs.lastWinnerDepth = 3)],
        [7, (pv) => (pv.inputs.penaltyRandomFactor = 50)],
        [8, (pv) => (pv.inputs.stakeDigest = keccak256('0x01'))],
        [8, (pv) => (pv.inputs.participants = owners.slice(1))],
        [9, (pv) => (pv.inputs.stakePrice = 1)],
      ];
      for (const [code, mutate] of cases) {
        const pv = JSON.parse(JSON.stringify(good));
        mutate(pv);
        await expect(settlement.settleRound(encode(pv), '0x')).to.be.revertedWith(`InputMismatch\\(${code}\\)`);
      }
    });

    it('rejects a non-empty proof with the mock verifier', async function () {
      const round = await anchoredRound();
      await mineTo(round * ROUND_LENGTH + SEED_OFFSET + 1);
      const pv = await publicValues(round, [], {});
      await expect(settlement.settleRound(encode(pv), '0x01')).to.be.reverted;
    });

    it('settles in increasing round order only', async function () {
      const r1 = await anchoredRound();
      const r2 = await mineToOffset(COMMIT_END, r1 + 1);
      await settlement.anchorRound(r2, keccak256('0x'), 0, ZERO);
      await mineTo(r2 * ROUND_LENGTH + SEED_OFFSET + 1);
      await settlement.settleRound(encode(await publicValues(r2, [], {})), '0x');
      await expect(settlement.settleRound(encode(await publicValues(r1, [], {})), '0x')).to.be.revertedWith(
        'RoundOutOfOrder'
      );
    });

    it('cannot settle before the seed block', async function () {
      const round = await anchoredRound();
      await mineTo(round * ROUND_LENGTH + SEED_OFFSET + 1);
      const pv = await publicValues(round, [], {});
      // Same inputs, but submitted from a fresh deployment's point of view is not possible here, so
      // instead check the seed guard directly on the next round.
      const next = await mineToOffset(COMMIT_END, round + 1);
      await settlement.anchorRound(next, keccak256('0x'), 0, ZERO);
      pv.inputs.round = next;
      pv.inputs.roundAnchor = (await settlement.rounds(next)).roundAnchor;
      await expect(settlement.settleRound(encode(pv), '0x')).to.be.revertedWith('SeedNotAvailable');
    });
  });
});
