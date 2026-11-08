import { expect } from './util/chai';
import { ethers, network } from 'hardhat';
import { BigNumber, Contract, Signer } from 'ethers';
import { PV_TYPE } from './util/publicValues';

// Settlement replaces Redistribution: the game runs off chain (prover/crates/vm), this contract checks
// the public inputs of a proof against the chain and executes the outcome. These tests use
// SP1MockVerifier, so they exercise everything except the proof itself. Postage is PostageStampZK: the
// proof replays its event log and gives the pot amount (outcome.postage.potAmount).

const ROUND_LENGTH = 64;
const COMMIT_END = 16;
const ANCHOR_END = 20;
const REVEAL_START = 24;
const REVEAL_ANCHOR_START = 40;
const REVEAL_ANCHOR_END = 44;
const REVEAL_END = 48;
const SEED_OFFSET = 48;
const CLAIM_START = 49;
const coder = ethers.utils.defaultAbiCoder;
const { keccak256, solidityPack } = ethers.utils;

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
    postage = await (await ethers.getContractFactory('PostageStampZK')).deploy(token.address, 16);
    oracle = await (await ethers.getContractFactory('PriceOracleZK')).deploy(postage.address);
    staking = await (await ethers.getContractFactory('StakeRegistry')).deploy(token.address, 0, oracle.address);
    const verifier = await (await ethers.getContractFactory('SP1MockVerifier')).deploy();
    settlement = await (
      await ethers.getContractFactory('Settlement')
    ).deploy(staking.address, postage.address, oracle.address, verifier.address, keccak256('0x01'), 7 * 86400);

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

  // The postage inputs of a proof that replays the whole log up to now.
  // The postage inputs of a proof for `round`: the log up to the round's seed block (the cut).
  async function postageInputs(round: number) {
    const prevEventIndex = (await settlement.postageEventIndex()).toNumber();
    const prevEventHash = await settlement.postageEventHash();
    const cutBlock = round * ROUND_LENGTH + SEED_OFFSET;
    const cut = await postage.cutOf(round);
    return {
      prevStateHash: await settlement.postageStateHash(),
      prevEventIndex,
      prevEventHash,
      eventIndex: cut.index.toNumber(),
      eventHash: cut.hash,
      cutBlock,
    };
  }

  const NEW_POSTAGE_STATE = keccak256(ethers.utils.toUtf8Bytes('postage state'));

  // Public values as the VM would produce them for `round`, with the outcome supplied by the test.
  async function publicValues(round: number, participants: string[], outcome: Record<string, unknown>) {
    const ri = await settlement.rounds(round);
    return {
      inputs: {
        chainId: network.config.chainId,
        settlement: settlement.address,
        round,
        anchorBlockHash: ri.anchorBlockHash,
        seedBlockHash: await settlement.seedBlockHash(round),
        commitsHash: ri.commitsHash,
        commitCount: ri.commitCount,
        revealsHash: ri.revealsHash,
        revealCount: ri.revealCount,
        forcedCommitsHash: ri.forcedCommitsHash,
        forcedRevealsHash: ri.forcedRevealsHash,
        lastClaimRound: await settlement.lastClaimRound(),
        lastWinnerDepth: await settlement.lastWinnerDepth(),
        penaltyMultiplierDisagreement: 1,
        penaltyMultiplierNonRevealed: 2,
        penaltyRandomFactor: 100,
        stakeAgeRounds: 2,
        participants,
        stakeDigest: await stakeDigest(participants),
        stakePrice: await oracle.currentPrice(),
        forcedClaimsHash: ri.forcedClaimsHash,
        sampleMaxValue: (await settlement.sampleMaxValue()).toString(),
        postage: await postageInputs(round),
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
        unclaimed: false,
        feeRecipient: await deployer.getAddress(),
        postage: { newStateHash: NEW_POSTAGE_STATE, potAmount: 0, validChunkCount: 1 << 20 },
        ...outcome,
      },
    };
  }

  const encode = (pv: unknown) => coder.encode([PV_TYPE], [pv]);

  async function anchoredRound(commitsHash = ZERO, count = 0) {
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
      expect(ri.anchorBlockHash).to.eq(await settlement.anchorBlockHash(round));
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
      // forceCommit stays open after the anchor phase, so a node left out of the list can react.
      await mineToOffset(REVEAL_START - 1, round);
      await settlement.connect(nodes[2]).forceCommit(round, keccak256('0x06'));
      await expect(settlement.forceCommit(round, ZERO)).to.be.revertedWith('NotCommitPhase');
      const oa = await staking.overlayOfAddress(a);
      await settlement.connect(nodes[0]).forceReveal(round, oa, 2, keccak256('0x04'), keccak256('0x05'));
      const r = keccak256(
        solidityPack(
          ['bytes32', 'bytes32', 'uint8', 'bytes32', 'bytes32'],
          [ZERO, oa, 2, keccak256('0x04'), keccak256('0x05')]
        )
      );
      expect((await settlement.rounds(round)).forcedRevealsHash).to.eq(r);
      // forceReveal stays open after the reveal anchor phase, up to the seed block.
      await mineToOffset(REVEAL_END - 1, round);
      await settlement.connect(nodes[1]).forceReveal(round, await staking.overlayOfAddress(b), 2, ZERO, ZERO);
      await expect(settlement.connect(nodes[2]).forceReveal(round, ZERO, 1, ZERO, ZERO)).to.be.revertedWith(
        'NotRevealPhase'
      );
    });

    it('accepts forced entries only from staked addresses, once per round, for their own overlay', async function () {
      const outsider = (await ethers.getSigners())[15];
      const round = await mineToOffset(10);
      await expect(settlement.connect(outsider).forceCommit(round, keccak256('0x01'))).to.be.revertedWith('NotStaked');
      await settlement.connect(nodes[0]).forceCommit(round, keccak256('0x01'));
      // A second forced commit of the same node in the same round (spam to fill the cap) is refused.
      await expect(settlement.connect(nodes[0]).forceCommit(round, keccak256('0x02'))).to.be.revertedWith(
        'AlreadyForced'
      );

      await mineToOffset(REVEAL_START, round);
      const own = await staking.overlayOfAddress(await nodes[0].getAddress());
      const other = await staking.overlayOfAddress(await nodes[1].getAddress());
      await expect(settlement.connect(nodes[0]).forceReveal(round, other, 1, ZERO, ZERO)).to.be.revertedWith(
        'NotOwnOverlay'
      );
      await expect(settlement.connect(outsider).forceReveal(round, own, 1, ZERO, ZERO)).to.be.revertedWith('NotStaked');
      await settlement.connect(nodes[0]).forceReveal(round, own, 1, ZERO, ZERO);
      await expect(settlement.connect(nodes[0]).forceReveal(round, own, 1, ZERO, ZERO)).to.be.revertedWith(
        'AlreadyForced'
      );

      await mineToOffset(CLAIM_START, round);
      await expect(settlement.connect(outsider).forceClaim(round, '0x01')).to.be.revertedWith('NotStaked');
      await settlement.connect(nodes[0]).forceClaim(round, '0x01');
      await expect(settlement.connect(nodes[0]).forceClaim(round, '0x02')).to.be.revertedWith('AlreadyForced');

      // The next round, the same node can force again.
      const next = await mineToOffset(10, round + 1);
      await settlement.connect(nodes[0]).forceCommit(next, keccak256('0x03'));
      expect((await settlement.rounds(next)).forcedCommitCount).to.eq(1);
    });

    it('lets anybody anchor an empty list when no prover anchored (liveness fallback)', async function () {
      const outsider = (await ethers.getSigners())[15];
      // No prover anchored: not before block 20, then anybody, once.
      const round = await mineToOffset(ANCHOR_END - 1);
      await expect(settlement.connect(outsider).anchorEmpty(round)).to.be.revertedWith('NotAnchorPhase');
      await settlement.connect(nodes[0]).forceCommit(round, keccak256('0x01'));
      await settlement.connect(outsider).anchorEmpty(round);
      await expect(settlement.connect(outsider).anchorEmpty(round)).to.be.revertedWith('AlreadyAnchored');
      const ri = await settlement.rounds(round);
      expect(ri.anchored).to.be.true;
      expect(ri.commitCount).to.eq(0);
      expect(ri.commitsHash).to.eq(ZERO);
      // The forced commit counts, and forceCommit is still open until block 23.
      expect(ri.forcedCommitCount).to.eq(1);
      await settlement.connect(nodes[1]).forceCommit(round, keccak256('0x02'));
      // The round settles like any other.
      await mineTo(round * ROUND_LENGTH + SEED_OFFSET + 1);
      const owners = [await nodes[0].getAddress(), await nodes[1].getAddress()];
      await settlement.settleRound(encode(await publicValues(round, owners, {})), '0x');
      expect(await settlement.lastSettledRound()).to.eq(round);
      // An empty list needs the zero hash in anchorRound too.
      const next = await mineToOffset(COMMIT_END, round + 1);
      await expect(settlement.anchorRound(next, keccak256('0x'), 0, ZERO)).to.be.revertedWith('RevealsHashMismatch');
    });

    it('anchors commits only before the commit check blocks', async function () {
      const round = await mineToOffset(ANCHOR_END);
      await expect(settlement.anchorRound(round, ZERO, 0, ZERO)).to.be.revertedWith('NotAnchorPhase');
    });

    it('anchors reveals once, in the reveal anchor phase, after anchorRound, with ANCHOR_ROLE', async function () {
      const h = keccak256('0x07');
      let round = await mineToOffset(REVEAL_ANCHOR_START);
      await expect(settlement.anchorReveals(round, h, 2, ZERO)).to.be.revertedWith('NotAnchored');

      round = await anchoredRound();
      await mineToOffset(REVEAL_ANCHOR_START - 1, round);
      await expect(settlement.anchorReveals(round, h, 2, ZERO)).to.be.revertedWith('NotRevealAnchorPhase');
      await expect(settlement.connect(nodes[0]).anchorReveals(round, h, 2, ZERO)).to.be.revertedWith('NotAdmin');
      await expect(settlement.anchorReveals(round, h, 2, ZERO))
        .to.emit(settlement, 'RevealsAnchored')
        .withArgs(round, h, 2, ZERO);
      await expect(settlement.anchorReveals(round, h, 2, ZERO)).to.be.revertedWith('AlreadyAnchored');
      const ri = await settlement.rounds(round);
      expect(ri.revealsAnchored).to.be.true;
      expect(ri.revealsHash).to.eq(h);
      expect(ri.revealCount).to.eq(2);

      const next = await mineToOffset(REVEAL_ANCHOR_END, round + 1);
      await expect(settlement.anchorReveals(next, h, 2, ZERO)).to.be.revertedWith('NotRevealAnchorPhase');
    });

    it('seed is unavailable until after the seed block', async function () {
      const round = await anchoredRound();
      await mineTo(round * ROUND_LENGTH + SEED_OFFSET - 1);
      await expect(settlement.seedBlockHash(round)).to.be.revertedWith('SeedNotAvailable');
      await mineTo(round * ROUND_LENGTH + SEED_OFFSET + 1);
      expect(await settlement.seedBlockHash(round)).to.not.eq(ZERO);
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
        feeRecipient: owners[0],
        postage: { newStateHash: NEW_POSTAGE_STATE, potAmount: 1_000_000, validChunkCount: 1 << 20 },
      });

      // Someone else copies the prover's transaction (front-running): the fee still goes to the
      // fee recipient in the proof, owners[0].
      const copier = nodes[2];
      const before = await token.balanceOf(winner);
      const proverBefore = await token.balanceOf(owners[0]);
      const copierBefore = await token.balanceOf(await copier.getAddress());
      const tx = await settlement.connect(copier).settleRound(encode(pv), '0x');
      const rc = await tx.wait();

      const won = (await token.balanceOf(winner)).sub(before);
      const fee = (await token.balanceOf(owners[0])).sub(proverBefore);
      expect(won.add(fee)).to.eq(1_000_000);
      expect(fee).to.eq(10_000);
      if (winner !== (await copier.getAddress())) {
        expect(await token.balanceOf(await copier.getAddress())).to.eq(copierBefore);
      }
      expect(await settlement.accruedPot()).to.eq(0);
      // PostageStampZK pays the winner and the fee recipient directly; no tokens pass through Settlement.
      const withdrawn = rc.logs
        .filter((l: { address: string }) => l.address === postage.address)
        .map((l: { topics: string[]; data: string }) => postage.interface.parseLog(l))
        .filter((e: { name: string }) => e.name === 'PotWithdrawn')
        .map((e: { args: { recipient: string; totalAmount: { toNumber(): number } } }) => [
          e.args.recipient,
          e.args.totalAmount.toNumber(),
        ]);
      expect(withdrawn).to.deep.eq([
        [owners[0], 10_000],
        [winner, 990_000],
      ]);
      const transfers = rc.logs
        .filter((l: { address: string }) => l.address === token.address)
        .map((l: { topics: string[]; data: string }) => token.interface.parseLog(l));
      expect(transfers.map((t: { args: { to: string } }) => t.args.to)).to.not.include(settlement.address);
      expect(await token.balanceOf(settlement.address)).to.eq(0);
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
      await settlement.anchorRound(r2, ZERO, 0, ZERO);
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
        [1, (pv) => (pv.inputs.anchorBlockHash = keccak256('0x01'))],
        [2, (pv) => (pv.inputs.seedBlockHash = keccak256('0x01'))],
        [3, (pv) => (pv.inputs.commitsHash = keccak256('0x01'))],
        [3, (pv) => (pv.inputs.commitCount = 9)],
        [4, (pv) => (pv.inputs.forcedCommitsHash = keccak256('0x01'))],
        [5, (pv) => (pv.inputs.forcedRevealsHash = keccak256('0x01'))],
        [6, (pv) => (pv.inputs.lastWinnerDepth = 3)],
        [7, (pv) => (pv.inputs.penaltyRandomFactor = 50)],
        [7, (pv) => (pv.inputs.stakeAgeRounds = 0)],
        [8, (pv) => (pv.inputs.stakeDigest = keccak256('0x01'))],
        [8, (pv) => (pv.inputs.participants = owners.slice(1))],
        [9, (pv) => (pv.inputs.stakePrice = 1)],
        [10, (pv) => (pv.inputs.forcedClaimsHash = keccak256('0x01'))],
        [11, (pv) => (pv.inputs.postage.prevStateHash = keccak256('0x01'))],
        [12, (pv) => (pv.inputs.sampleMaxValue = 1)],
        [13, (pv) => (pv.inputs.revealsHash = keccak256('0x01'))],
        [13, (pv) => (pv.inputs.revealCount = 1)],
      ];
      for (const [code, mutate] of cases) {
        const pv = JSON.parse(JSON.stringify(good));
        mutate(pv);
        await expect(settlement.settleRound(encode(pv), '0x')).to.be.revertedWith(`InputMismatch\\(${code}\\)`);
      }
    });

    it('checks the replayed part of the postage event log', async function () {
      const round = await anchoredRound();
      await mineTo(round * ROUND_LENGTH + SEED_OFFSET + 1);
      // beforeEach logged a price change and a batch: two log entries.
      expect(await postage.eventCount()).to.eq(2);
      const good = await publicValues(round, [], {});

      const cases: ((pv: any) => void)[] = [
        (pv) => (pv.inputs.postage.prevEventIndex = 1),
        (pv) => (pv.inputs.postage.prevEventHash = keccak256('0x01')),
        (pv) => (pv.inputs.postage.eventIndex = 3),
        (pv) => (pv.inputs.postage.eventHash = keccak256('0x01')),
        // The cut must be the round's seed block: not later, not earlier.
        (pv) => (pv.inputs.postage.cutBlock = pv.inputs.postage.cutBlock + 1),
        (pv) => (pv.inputs.postage.cutBlock = pv.inputs.postage.cutBlock - ROUND_LENGTH),
        // Stops at entry 1 although entry 2 is before the cut: an entry would be left out.
        (pv) => {
          pv.inputs.postage.eventIndex = 1;
          pv.inputs.postage.eventHash = ZERO;
        },
      ];
      for (const mutate of cases) {
        const pv = JSON.parse(JSON.stringify(good));
        mutate(pv);
        await expect(settlement.settleRound(encode(pv), '0x')).to.be.revertedWith('InputMismatch\\(11\\)');
      }

      expect(good.inputs.postage.cutBlock).to.eq(round * ROUND_LENGTH + SEED_OFFSET);
      await settlement.settleRound(encode(good), '0x');
      expect(await settlement.postageEventIndex()).to.eq(2);
      expect(await settlement.postageStateHash()).to.eq(NEW_POSTAGE_STATE);
      expect(await settlement.validChunkCount()).to.eq(1 << 20);
    });

    it('keeps the proven pot of rounds without payout for the next winner', async function () {
      const owners = await Promise.all(nodes.map((n) => n.getAddress()));
      const r1 = await anchoredRound();
      await mineTo(r1 * ROUND_LENGTH + SEED_OFFSET + 1);
      await settlement.settleRound(
        encode(
          await publicValues(r1, [], {
            postage: { newStateHash: NEW_POSTAGE_STATE, potAmount: 700, validChunkCount: 0 },
          })
        ),
        '0x'
      );
      expect(await settlement.accruedPot()).to.eq(700);

      const r2 = await mineToOffset(COMMIT_END, r1 + 1);
      await settlement.anchorRound(r2, ZERO, 0, ZERO);
      await mineTo(r2 * ROUND_LENGTH + SEED_OFFSET + 1);
      const before = await token.balanceOf(owners[2]);
      await settlement.settleRound(
        encode(
          await publicValues(r2, owners, {
            hasTruth: true,
            truthHash: keccak256('0xbb'),
            winner: owners[2],
            redundancy: 1,
            postage: { newStateHash: keccak256('0x02'), potAmount: 300, validChunkCount: 0 },
          })
        ),
        '0x'
      );
      // 700 + 300, minus the 1% prover fee (to the deployer, who settled).
      expect((await token.balanceOf(owners[2])).sub(before)).to.eq(990);
      expect(await settlement.accruedPot()).to.eq(0);
    });

    it('keeps forced claims as a hash chain, only in the claim window', async function () {
      const round = await anchoredRound();
      const witness = '0x' + 'ab'.repeat(100);
      await expect(settlement.forceClaim(round, witness)).to.be.revertedWith('NotClaimPhase');
      await mineTo(round * ROUND_LENGTH + CLAIM_START - 1);
      await settlement.connect(nodes[1]).forceClaim(round, witness);
      expect((await settlement.rounds(round)).forcedClaimsHash).to.eq(
        keccak256(solidityPack(['bytes32', 'bytes32'], [ZERO, keccak256(witness)]))
      );
      await expect(settlement.forceClaim(round, '0x' + '00'.repeat(16385))).to.be.revertedWith('WitnessTooLarge');
    });

    it('settles an unclaimed round only after the claim window', async function () {
      const owners = await Promise.all(nodes.map((n) => n.getAddress()));
      const round = await anchoredRound();
      await mineTo(round * ROUND_LENGTH + SEED_OFFSET + 1);
      const unclaimed = {
        unclaimed: true,
        truthHash: keccak256('0xbb'),
        winner: owners[0],
        redundancy: 3,
      };
      let pv = await publicValues(round, owners, unclaimed);
      await expect(settlement.settleRound(encode(pv), '0x')).to.be.revertedWith('ClaimWindowOpen');

      await mineTo((round + 1) * ROUND_LENGTH);
      pv = await publicValues(round, owners, unclaimed);
      const before = await token.balanceOf(owners[0]);
      const tx = await settlement.settleRound(encode(pv), '0x');
      const rc = await tx.wait();
      expect(rc.logs.map((l: { topics: string[] }) => l.topics[0])).to.include(
        settlement.interface.getEventTopic('RoundUnclaimed')
      );
      expect(await token.balanceOf(owners[0])).to.eq(before);
      expect(await settlement.lastClaimRound()).to.eq(0);
      expect(await settlement.lastSettledRound()).to.eq(round);
    });

    it('rejects a non-empty proof with the mock verifier', async function () {
      const round = await anchoredRound();
      await mineTo(round * ROUND_LENGTH + SEED_OFFSET + 1);
      const pv = await publicValues(round, [], {});
      await expect(settlement.settleRound(encode(pv), '0x01')).to.be.reverted;
    });

    it('adjusts the price for each game round, also when a settlement lands in the next round', async function () {
      const owners = await Promise.all(nodes.map((n) => n.getAddress()));
      const winner = owners[1];
      const truth = async (round: number) =>
        publicValues(round, owners, {
          hasTruth: true,
          truthHash: keccak256('0x01'),
          winner,
          winnerOverlay: await staking.overlayOfAddress(winner),
          winnerStakeDensity: 1,
          redundancy: 4,
        });
      const r1 = await anchoredRound();
      const r2 = await mineToOffset(COMMIT_END, r1 + 1);
      await settlement.anchorRound(r2, ZERO, 0, ZERO);
      // r1 settles late, in r2's blocks (as with the block-58 backstop and a slow proof).
      await mineTo(r2 * ROUND_LENGTH + SEED_OFFSET + 1);
      await expect(settlement.settleRound(encode(await truth(r1)), '0x')).to.not.emit(
        settlement,
        'PriceAdjustmentSkipped'
      );
      // Before the fix, r2 found its oracle round "already adjusted" and its price change was lost.
      await expect(settlement.settleRound(encode(await truth(r2)), '0x')).to.not.emit(
        settlement,
        'PriceAdjustmentSkipped'
      );
      expect(await oracle.lastAdjustedRound()).to.eq(r2);
    });

    it('a gas limit too low for the stamp price update reverts, and does not lose the update', async function () {
      // The oracle calls PostageStampZK.setPrice and ignores a failure. Without a check, a gas estimate
      // picked a limit at which that inner call ran out of gas: the transaction succeeded, the stamp price
      // did not change (found with the per-round cut, whose first write costs more).
      const est = await oracle.estimateGas.setPrice(24001);
      await expect(oracle.setPrice(24001, { gasLimit: est.sub(15_000) })).to.be.revertedWith('OutOfGas');
      expect(await postage.lastPrice()).to.eq(24000);
      await oracle.setPrice(24001);
      expect(await postage.lastPrice()).to.eq(24001);
    });

    it('settles anchored rounds in order, without skipping one that can still settle', async function () {
      const r1 = await anchoredRound();
      const r2 = await mineToOffset(COMMIT_END, r1 + 1);
      await settlement.anchorRound(r2, ZERO, 0, ZERO);
      // r3 is not anchored: it is skipped without a settlement.
      const r4 = await mineToOffset(COMMIT_END, r2 + 2);
      await settlement.anchorRound(r4, ZERO, 0, ZERO);
      await mineTo(r4 * ROUND_LENGTH + SEED_OFFSET + 1);
      // Skipping r1 (and its winner) is not possible while r1 can settle.
      await expect(settlement.settleRound(encode(await publicValues(r2, [], {})), '0x')).to.be.revertedWith(
        'RoundPending'
      );
      await settlement.settleRound(encode(await publicValues(r1, [], {})), '0x');
      await expect(settlement.settleRound(encode(await publicValues(r4, [], {})), '0x')).to.be.revertedWith(
        'RoundPending'
      );
      await settlement.settleRound(encode(await publicValues(r2, [], {})), '0x');
      await settlement.settleRound(encode(await publicValues(r4, [], {})), '0x');
      await expect(settlement.settleRound(encode(await publicValues(r1, [], {})), '0x')).to.be.revertedWith(
        'AlreadySettled'
      );
    });

    it('cannot settle before the seed block', async function () {
      const round = await anchoredRound();
      await mineTo(round * ROUND_LENGTH + SEED_OFFSET + 1);
      const pv = await publicValues(round, [], {});
      await settlement.settleRound(encode(pv), '0x');
      // Check the seed guard on the next round, before its seed block.
      const next = await mineToOffset(COMMIT_END, round + 1);
      await settlement.anchorRound(next, ZERO, 0, ZERO);
      pv.inputs.round = next;
      pv.inputs.anchorBlockHash = (await settlement.rounds(next)).anchorBlockHash;
      await expect(settlement.settleRound(encode(pv), '0x')).to.be.revertedWith('SeedNotAvailable');
    });
  });

  describe('verifier change', function () {
    it('takes effect only after the delay, and anybody can apply it', async function () {
      const other = nodes[0];
      const newKey = keccak256('0x02');
      expect(await settlement.verifierDelay()).to.eq(7 * 86400);
      await expect(settlement.connect(other).proposeVerifier(other.getAddress(), newKey)).to.be.revertedWith(
        'NotAdmin'
      );
      await expect(settlement.applyVerifier()).to.be.revertedWith('NoPendingVerifier');
      await settlement.proposeVerifier(await other.getAddress(), newKey);
      await expect(settlement.connect(other).applyVerifier()).to.be.revertedWith('VerifierDelayNotOver');
      expect(await settlement.programVKey()).to.eq(keccak256('0x01'));

      // The admin can cancel during the delay.
      await settlement.cancelVerifier();
      await expect(settlement.applyVerifier()).to.be.revertedWith('NoPendingVerifier');

      await settlement.proposeVerifier(await other.getAddress(), newKey);
      await network.provider.send('evm_increaseTime', [7 * 86400]);
      await network.provider.send('evm_mine', []);
      await settlement.connect(other).applyVerifier();
      expect(await settlement.programVKey()).to.eq(newKey);
      expect(await settlement.verifier()).to.eq(await other.getAddress());
    });
  });

  describe('round ring', function () {
    const RING = 256;

    async function gasOf(tx: Promise<{ wait: () => Promise<{ gasUsed: BigNumber }> }>) {
      return (await (await tx).wait()).gasUsed.toNumber();
    }

    it('reuses an entry after RING_SIZE rounds without the old round leaking into the new one', async function () {
      expect(await settlement.RING_SIZE()).to.eq(RING);
      const a = await nodes[0].getAddress();
      const b = await nodes[1].getAddress();
      const r1 = await mineToOffset(10);
      await settlement.connect(nodes[0]).forceCommit(r1, keccak256('0x01'));
      await mineToOffset(COMMIT_END, r1);
      await settlement.anchorRound(r1, keccak256('0x02'), 3, ZERO);
      await mineToOffset(REVEAL_ANCHOR_START, r1);
      await settlement.anchorReveals(r1, keccak256('0x03'), 2, ZERO);
      expect((await settlement.rounds(r1)).forcedCommitCount).to.eq(1);

      const r2 = await mineToOffset(10, r1 + RING);
      expect(r2).to.eq(r1 + RING);
      await settlement.connect(nodes[1]).forceCommit(r2, keccak256('0x04'));
      const ri = await settlement.rounds(r2);
      // A fresh chain, not continued from r1's.
      expect(ri.forcedCommitsHash).to.eq(
        keccak256(solidityPack(['bytes32', 'address', 'bytes32'], [ZERO, b, keccak256('0x04')]))
      );
      expect(ri.forcedCommitCount).to.eq(1);
      expect(ri.anchored).to.be.false;
      expect(ri.commitsHash).to.eq(ZERO);
      expect(ri.revealsAnchored).to.be.false;
      expect(ri.revealsHash).to.eq(ZERO);
      // r1 is gone.
      const old = await settlement.rounds(r1);
      expect(old.anchored).to.be.false;
      expect(old.forcedCommitCount).to.eq(0);
      expect(a).to.not.eq(b);
    });

    it('a reused entry writes no new storage slots', async function () {
      const r1 = await mineToOffset(COMMIT_END);
      const first = await gasOf(settlement.anchorRound(r1, keccak256('0x01'), 3, ZERO));
      await mineToOffset(REVEAL_ANCHOR_START, r1);
      const firstReveals = await gasOf(settlement.anchorReveals(r1, keccak256('0x02'), 2, ZERO));

      const r2 = await mineToOffset(COMMIT_END, r1 + RING);
      const again = await gasOf(settlement.anchorRound(r2, keccak256('0x03'), 3, ZERO));
      await mineToOffset(REVEAL_ANCHOR_START, r2);
      const againReveals = await gasOf(settlement.anchorReveals(r2, keccak256('0x04'), 2, ZERO));
      console.log(
        `      anchorRound ${first} -> ${again}, anchorReveals ${firstReveals} -> ${againReveals} gas (new entry -> reused entry)`
      );
      // Each avoided new-slot write saves 15k here (20k vs 5k); on Sepolia about 105k.
      expect(first - again).to.be.greaterThan(25_000);
      expect(firstReveals - againReveals).to.be.greaterThan(12_000);
    });

    it('warmRing makes the first use of an entry as cheap as a reuse', async function () {
      const r = await mineToOffset(COMMIT_END - 2);
      await expect(settlement.connect(nodes[0]).warmRing(0, RING)).to.be.revertedWith('NotAdmin');
      await settlement.warmRing(r % RING, 1);
      await mineToOffset(COMMIT_END, r);
      const warm = await gasOf(settlement.anchorRound(r, keccak256('0x01'), 3, ZERO));
      const cold = await gasOf(
        settlement.anchorRound(
          await (async () => {
            const n = await mineToOffset(COMMIT_END, r + 1);
            return n;
          })(),
          keccak256('0x01'),
          3,
          ZERO
        )
      );
      expect(cold - warm).to.be.greaterThan(25_000);
      // A warmed entry reads as an empty round.
      const ri = await settlement.rounds(r + 2);
      expect(ri.anchored).to.be.false;
    });

    it('a round whose entry was reused cannot settle', async function () {
      const r1 = await anchoredRound();
      await mineToOffset(COMMIT_END, r1 + RING);
      await settlement.anchorRound(r1 + RING, ZERO, 0, ZERO);
      await mineTo((r1 + RING) * ROUND_LENGTH + SEED_OFFSET + 1);
      const owners = await Promise.all(nodes.map((n) => n.getAddress()));
      const pv = await publicValues(r1 + RING, owners, {});
      pv.inputs.round = r1;
      await expect(settlement.settleRound(encode(pv), '0x')).to.be.revertedWith('NotAnchored');
    });

    it('a pending round blocks later rounds for PENDING_ROUNDS rounds after its end', async function () {
      // Before, a pending round blocked until its seed was gone (8191 blocks on Ethereum). A round whose
      // anchored lists were lost then stopped all settlement for about 27 hours.
      const pending = (await settlement.PENDING_ROUNDS()).toNumber();
      const r1 = await anchoredRound(); // never settled
      const r2 = await mineToOffset(COMMIT_END, r1 + 2);
      await settlement.anchorRound(r2, ZERO, 0, ZERO);
      const limit = (r1 + 1 + pending) * ROUND_LENGTH;
      // The limit comes before the seed of r1 is gone, also without EIP-2935 (256 blocks).
      expect(limit).to.be.lessThan(r1 * ROUND_LENGTH + SEED_OFFSET + 256);

      // A transaction lands in the block after mineTo. In the last block before the limit, r2 must wait.
      await mineTo(limit - 2);
      await settlement.seedBlockHash(r1);
      const pv = await publicValues(r2, [], {});
      await expect(settlement.settleRound(encode(pv), '0x')).to.be.revertedWith('RoundPending');
      // At the limit r2 settles, and r1 can no longer settle.
      await mineTo(limit - 1);
      await settlement.settleRound(encode(pv), '0x');
      expect(await settlement.lastSettledRound()).to.eq(r2);
      pv.inputs.round = r1;
      await expect(settlement.settleRound(encode(pv), '0x')).to.be.revertedWith('RoundOutOfOrder');
    });

    it('a pending round settles within PENDING_ROUNDS, and then later rounds follow', async function () {
      const pending = (await settlement.PENDING_ROUNDS()).toNumber();
      const r1 = await anchoredRound();
      const r2 = await mineToOffset(COMMIT_END, r1 + 1);
      await settlement.anchorRound(r2, ZERO, 0, ZERO);
      // One round after r1 ended (on Hardhat the anchor block hash of r1 runs out before the limit).
      await mineTo((r1 + 2) * ROUND_LENGTH);
      expect(r1 + 2).to.be.lessThan(r1 + 1 + pending);
      const pv2 = await publicValues(r2, [], {});
      await expect(settlement.settleRound(encode(pv2), '0x')).to.be.revertedWith('RoundPending');
      await settlement.settleRound(encode(await publicValues(r1, [], {})), '0x');
      await settlement.settleRound(encode(await publicValues(r2, [], {})), '0x');
      expect(await settlement.lastSettledRound()).to.eq(r2);
    });

    it('settles a round whose cut is more than 8192 postage log entries old', async function () {
      // With a ring of the log entries themselves, 8192 entries before a settlement made the round
      // unsettleable (and blocked later rounds). PostageStampZK now keeps the cut of each round.
      this.timeout(600_000);
      const me = await deployer.getAddress();
      await postage.grantRole(await postage.PRICE_ORACLE_ROLE(), me);

      const r1 = await anchoredRound();
      await mineTo(r1 * ROUND_LENGTH + SEED_OFFSET + 1);
      const pv1 = await publicValues(r1, [], {});

      // 8195 log entries before r1 settles. Many in each block, so they take few blocks.
      await network.provider.send('evm_setAutomine', [false]);
      let nonce = await deployer.getTransactionCount();
      for (let i = 0; i < 8195; i++) {
        await postage.setPrice(24000 + (i % 2), { gasLimit: 120_000, nonce: nonce++ });
      }
      while ((await deployer.getTransactionCount()) < nonce) await network.provider.send('evm_mine', []);
      await network.provider.send('evm_setAutomine', [true]);
      const count = (await postage.eventCount()).toNumber();
      expect(count).to.be.greaterThan(8192 + pv1.inputs.postage.eventIndex);

      // r1's cut did not change, and r1 settles.
      expect((await postage.cutOf(r1)).index).to.eq(pv1.inputs.postage.eventIndex);
      await settlement.settleRound(encode(pv1), '0x');

      const r2 = await mineToOffset(COMMIT_END, r1 + 1);
      await settlement.anchorRound(r2, ZERO, 0, ZERO);
      await mineTo(r2 * ROUND_LENGTH + SEED_OFFSET + 1);
      const pv2 = await publicValues(r2, [], {});
      // r1's settlement logged a price change after the entries.
      expect(pv2.inputs.postage.eventIndex).to.eq((await postage.eventCount()).toNumber());
      await settlement.settleRound(encode(pv2), '0x');
      expect(await settlement.postageEventIndex()).to.eq(pv2.inputs.postage.eventIndex);
      expect(await settlement.postageEventHash()).to.eq(await postage.eventHash());
    });

    it('rounds with no postage log entry between their seed blocks share a cut', async function () {
      const me = await deployer.getAddress();
      await postage.grantRole(await postage.PRICE_ORACLE_ROLE(), me);
      const r1 = await anchoredRound();
      const r2 = await mineToOffset(COMMIT_END, r1 + 1);
      await settlement.anchorRound(r2, ZERO, 0, ZERO);
      await mineTo(r2 * ROUND_LENGTH + SEED_OFFSET + 1);
      const before = { index: await postage.eventCount(), hash: await postage.eventHash() };
      // The first entry after r2's seed block stores the cut of r1 and r2.
      await postage.setPrice(24001);
      expect(await postage.lastCutRound()).to.eq(r2);
      for (const r of [r1, r2]) {
        const c = await postage.cutOf(r);
        expect(c.index).to.eq(before.index);
        expect(c.hash).to.eq(before.hash);
      }
      await settlement.settleRound(encode(await publicValues(r1, [], {})), '0x');
      await settlement.settleRound(encode(await publicValues(r2, [], {})), '0x');
      expect(await settlement.postageEventIndex()).to.eq(before.index);
    });

    it('an empty reveal list has the zero hash, and only an empty list', async function () {
      const r = await anchoredRound();
      await mineToOffset(REVEAL_ANCHOR_START, r);
      await expect(settlement.anchorReveals(r, ZERO, 1, ZERO)).to.be.revertedWith('RevealsHashMismatch');
      await expect(settlement.anchorReveals(r, keccak256('0x01'), 0, ZERO)).to.be.revertedWith('RevealsHashMismatch');
      await settlement.anchorReveals(r, ZERO, 0, ZERO);
      const ri = await settlement.rounds(r);
      expect(ri.revealsAnchored).to.be.true;
      expect(ri.revealsHash).to.eq(ZERO);
    });
  });
});
