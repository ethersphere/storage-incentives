import { expect } from './util/chai';
import { ethers, deployments, getNamedAccounts } from 'hardhat';
import { BigNumber, Contract } from 'ethers';
import { arrayify, hexlify } from 'ethers/lib/utils';
import {
  mineNBlocks,
  mintAndApprove,
  getBlockNumber,
  encodeAndHash,
  encodeAndHashStampCommit,
  getWalletOfFdpPlayQueen,
  STS_PHASES,
  mineToPhase,
} from './util/tools';
import {
  buildStampSample,
  buildStampProof,
  makeStampSampleChunk,
  SortedPairMerkleTree,
  StampEntry,
  ZERO32,
  inProximity,
} from './util/sts';

// End to end coverage of the SWIP-050 STS-1 round: the six phase schedule, the ordering of the
// three randomness roles, every link of a stamp witness, and proportional payout.

const ROUND_LENGTH = 152;
// Deep enough that every chunk's bucket has many slots to pick a dense stamp index from.
const BATCH_DEPTH = 27;
const POT_DEPTH = 20;
const BUCKET_DEPTH = 16;
const CLAIMED_DEPTH = 1;
const HEIGHT = 0;

const revealNonce = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';
const stampNonce = '0xc6666c44c6666c44c6666c44c6666c44c6666c44c6666c44c6666c44c6666c44';

let deployer: string;
let stamper: string;
let node_5: string;
let node_6: string;

before(async function () {
  const named = await getNamedAccounts();
  deployer = named.deployer;
  stamper = named.stamper;
  node_5 = named.node_5;
  node_6 = named.node_6;
});

describe('Redistribution STS-1', function () {
  let redistribution: Contract;
  let postage: Contract;
  let token: Contract;
  let batchId: string;
  let sampleMaxValue: BigNumber;
  const batchOwner = getWalletOfFdpPlayQueen();
  const price = 1000;

  // Swarm network id is 0 on hardhat, and StakeRegistry byte-reverses it, so it stays 0.
  function overlayFor(address: string, nonce: string): string {
    return ethers.utils.solidityKeccak256(['address', 'uint64', 'bytes32'], [address, 0, nonce]);
  }

  /** A staking nonce whose overlay shares the reported responsibility prefix with `target`. */
  function findMatchingNonce(address: string, target: string): string {
    const responsibility = CLAIMED_DEPTH - HEIGHT;
    const targetBytes = arrayify(target);
    for (let i = 0; i < 100000; i++) {
      const nonce = ethers.utils.hexZeroPad(BigNumber.from(i).toHexString(), 32);
      if (inProximity(arrayify(overlayFor(address, nonce)), targetBytes, responsibility)) return nonce;
    }
    throw new Error('no matching staking nonce found');
  }

  /** Stake a node and wait out the two round eligibility delay. */
  async function stake(node: string, nonce: string, amount: string) {
    const registry = await ethers.getContract('StakeRegistry', node);
    await mintAndApprove(deployer, node, registry.address, amount);
    await registry.manageStake(nonce, amount, HEIGHT);
  }

  beforeEach(async function () {
    await deployments.fixture();
    redistribution = await ethers.getContract('Redistribution');
    postage = await ethers.getContract('PostageStamp', deployer);
    token = await ethers.getContract('TestToken', deployer);

    await postage.setMinimumValidityBlocks(912);
    const priceOracleRole = await postage.PRICE_ORACLE_ROLE();
    await postage.grantRole(priceOracleRole, deployer);
    await postage.setPrice(price);

    // A batch owned by a wallet we can sign stamps with. Imported rather than bought so the
    // owner does not need to hold tokens.
    batchId = '0x00000000000000000000000000000000000000000000000000000000000c0ffe';
    // Large enough that the batch survives the rounds spent waiting for a shared neighbourhood.
    const perChunk = price * 912 * 200;
    await postage.copyBatch(batchOwner.address, perChunk, BATCH_DEPTH, BUCKET_DEPTH, batchId, false);

    // Fund the pot so a claim has something to distribute.
    const potBatch = '0x00000000000000000000000000000000000000000000000000000000000beef0';
    const potPerChunk = price * 912;
    const potSize = BigNumber.from(potPerChunk).mul(BigNumber.from(2).pow(POT_DEPTH));
    await mintAndApprove(deployer, deployer, postage.address, potSize.toString());
    await postage.copyBatch(deployer, potPerChunk, POT_DEPTH, BUCKET_DEPTH, potBatch, false);
    await token.mint(postage.address, potSize);

    const nonce5 = '0x0000000000000000000000000000000000000000000000000000000000003ba6';
    await stake(node_5, nonce5, '100000000000000000');
    // Both nodes must be able to share a neighbourhood, so node_6's staking nonce is chosen so
    // its overlay agrees with node_5's on the bits that the reported responsibility covers.
    await stake(node_6, findMatchingNonce(node_6, overlayFor(node_5, nonce5)), '100000000000000000');

    // The production ceiling assumes a sample drawn from a full reserve of millions of chunks.
    // These tests build 16 entries by hand, so the ceiling is relaxed; the check itself is
    // covered by 'rejects a sample that is not dense enough' below.
    const admin = await ethers.getContract('Redistribution', deployer);
    await admin.setStampSampleMaxValue(BigNumber.from(2).pow(255));
    sampleMaxValue = await redistribution.stampSampleMaxValue();

    // Two rounds of staking delay, plus enough distance that the sampling start of the round we
    // play is after the batch was created.
    await mineNBlocks(ROUND_LENGTH * 3);
  });

  type Player = {
    node: string;
    contract: Contract;
    overlay: string;
    entries: StampEntry[];
    sampleChunk: ReturnType<typeof makeStampSampleChunk>;
    stampSampleHash: string;
    transformTree: SortedPairMerkleTree;
    chunkTransformRoot: string;
    chunkSampleHash: string;
  };

  /**
   * Walk one round from the start of the commit phase through proof submission, returning the
   * players that completed it. Each player builds its own stamp sample and chunk transform root,
   * which is what makes every paid node prove for itself.
   */
  async function playRound(
    nodes: string[],
    opts: { chunkSampleHashes?: string[]; skipStampCommit?: number[]; skipProof?: number[] } = {}
  ): Promise<{ round: number; players: Player[]; anchor: string; stampAnchor: string; proofSeed: string }> {
    const overlays: string[] = [];
    for (const node of nodes) overlays.push(await overlayOf(node));
    await mineToParticipatingRound(overlays);

    const round = (await redistribution.currentRound()).toNumber();
    const anchor = await redistribution.currentRoundAnchor();

    // Only nodes whose overlay is inside the anchor's neighbourhood may commit.
    const players: Player[] = [];
    for (const [i, node] of nodes.entries()) {
      const contract = await ethers.getContract('Redistribution', node);
      const registry = await ethers.getContract('StakeRegistry', node);
      const overlay = await registry.overlayOfAddress(node);
      players.push({
        node,
        contract,
        overlay,
        entries: [],
        sampleChunk: undefined as never,
        stampSampleHash: '',
        transformTree: undefined as never,
        chunkTransformRoot: '',
        chunkSampleHash: (opts.chunkSampleHashes ?? [])[i] ?? defaultChunkSampleHash(i, opts.chunkSampleHashes),
      });
    }

    // Stage one needs the chunk transform root up front, but the stamp entries depend on the
    // stamp anchor, which does not exist yet. The root is over the transformed chunk addresses,
    // which depend only on the round anchor, so those can be fixed now.
    for (const player of players) {
      const entries = buildStampSample({
        roundAnchor: anchor,
        // Placeholder: only the chunk side of these entries is used before the reveal.
        stampAnchor: ZERO32,
        batchId,
        batchDepth: BATCH_DEPTH,
        bucketDepth: BUCKET_DEPTH,
        claimedDepth: CLAIMED_DEPTH,
        sampleMaxValue: BigNumber.from(2).pow(256).sub(1),
        // Honest nodes in a neighbourhood hold the same chunks, so every player builds the same
        // sample. What differs between them is only what they report as the chunk side value.
        startNonce: 0,
      });
      player.entries = entries;
      player.transformTree = new SortedPairMerkleTree(entries.map((e) => e.transformedChunkAddress));
      player.chunkTransformRoot = player.transformTree.root;
    }

    for (const player of players) {
      const obfuscated = encodeAndHash(
        round,
        player.overlay,
        hexlify(CLAIMED_DEPTH),
        player.chunkSampleHash,
        player.chunkTransformRoot,
        revealNonce
      );
      await player.contract.commit(obfuscated, round, hexlify(CLAIMED_DEPTH));
    }

    await mineToPhase(STS_PHASES.chunkReveal);
    for (const player of players) {
      await player.contract.reveal(
        hexlify(CLAIMED_DEPTH),
        player.chunkSampleHash,
        player.chunkTransformRoot,
        revealNonce
      );
    }

    const stampAnchor = await redistribution.currentRevealRoundStampAnchor();
    expect(await redistribution.currentRevealRoundStampAnchorSet()).to.be.true;

    // Now the stamp anchor exists, the stamp indexes can be chosen and the sample committed. The
    // chunks are the ones already fixed in the chunk transform root; only the index each one is
    // stamped at, and therefore the sample ordering, is decided here.
    await mineToPhase(STS_PHASES.stampCommit);
    for (const [i, player] of players.entries()) {
      player.entries = restampEntries(player.entries, stampAnchor, sampleMaxValue);
      player.transformTree = new SortedPairMerkleTree(player.entries.map((e) => e.transformedChunkAddress));
      player.sampleChunk = makeStampSampleChunk(player.entries.map((e) => e.transformedStampValue));
      player.stampSampleHash = hexlify(player.sampleChunk.address());

      if ((opts.skipStampCommit ?? []).includes(i)) continue;
      await player.contract.commitStampSampleHash(
        encodeAndHashStampCommit(round, player.overlay, player.stampSampleHash, stampNonce),
        round
      );
    }

    await mineToPhase(STS_PHASES.stampReveal);
    for (const [i, player] of players.entries()) {
      if ((opts.skipStampCommit ?? []).includes(i)) continue;
      await player.contract.revealStampSampleHash(round, player.stampSampleHash, stampNonce);
    }

    const proofSeed = await redistribution.currentProofSeed();

    await mineToPhase(STS_PHASES.proof);
    const positions = (await redistribution.selectedStampPositions(round)).map((p: BigNumber) => p);

    for (const [i, player] of players.entries()) {
      if ((opts.skipStampCommit ?? []).includes(i)) continue;
      if ((opts.skipProof ?? []).includes(i)) continue;
      const proofs = [];
      for (const position of positions) {
        proofs.push(
          await buildStampProof({
            entries: player.entries,
            sampleChunk: player.sampleChunk,
            sampleIndex: Number(position),
            roundAnchor: anchor,
            proofSeed,
            batchId,
            batchOwner,
            transformTree: player.transformTree,
          })
        );
      }
      await player.contract.submitStsProof(round, proofs);
    }

    return { round, players, anchor, stampAnchor, proofSeed };
  }

  /**
   * The chunk transform root is fixed before the stamp anchor exists, so the chunks are chosen
   * first and only their stamp indexes are picked once the anchor is known. Re-deriving the
   * indexes keeps the same chunks, the same root, and therefore the same binding.
   */
  function restampEntries(entries: StampEntry[], stampAnchor: string, ceiling: BigNumber): StampEntry[] {
    const slotsPerBucket = 2 ** (BATCH_DEPTH - BUCKET_DEPTH);
    const used = new Set<string>();
    const restamped = entries.map((entry) => {
      for (let index = 0; index < slotsPerBucket; index++) {
        const key = `${entry.bucket}:${index}`;
        if (used.has(key)) continue;
        const fullIndex = BigNumber.from(entry.bucket).mul(BigNumber.from(2).pow(32)).add(index);
        const value = ethers.utils.solidityKeccak256(
          ['bytes32', 'bytes32', 'uint64'],
          [stampAnchor, batchId, fullIndex]
        );
        if (BigNumber.from(value).gte(ceiling)) continue;
        used.add(key);
        return { ...entry, withinBucketIndex: index, fullIndex, transformedStampValue: value };
      }
      throw new Error('no dense stamp index available for this bucket');
    });

    restamped.sort((a, b) =>
      BigNumber.from(a.transformedStampValue).lt(BigNumber.from(b.transformedStampValue)) ? -1 : 1
    );
    return restamped;
  }

  function defaultChunkSampleHash(i: number, provided?: string[]): string {
    // Unless a test wants players to disagree, everyone reports the same chunk side value.
    return provided ? provided[i] : '0x1111111111111111111111111111111111111111111111111111111111111111';
  }

  async function mineToStartOfRound() {
    const current = await getBlockNumber();
    const within = current % ROUND_LENGTH;
    await mineNBlocks(ROUND_LENGTH - within);
  }

  /**
   * Mine whole rounds until every overlay is inside the neighbourhood of the round anchor.
   * A node is only eligible when its overlay is within proximity order depth - height of the
   * anchor, which for these single-bit responsibilities holds in roughly half of all rounds.
   */
  async function mineToParticipatingRound(overlays: string[]) {
    const responsibility = CLAIMED_DEPTH - HEIGHT;
    for (let attempt = 0; attempt < 64; attempt++) {
      await mineToStartOfRound();
      const anchor = arrayify(await redistribution.currentRoundAnchor());
      if (overlays.every((overlay) => inProximity(arrayify(overlay), anchor, responsibility))) return;
      await mineNBlocks(ROUND_LENGTH);
    }
    throw new Error('no round found where every overlay is in the neighbourhood');
  }

  async function overlayOf(node: string): Promise<string> {
    const registry = await ethers.getContract('StakeRegistry', node);
    return registry.overlayOfAddress(node);
  }

  describe('round schedule', function () {
    it('splits the round into six phases that tile it exactly', async function () {
      const offsets = [
        [STS_PHASES.chunkCommit, 'currentPhaseCommit'],
        [STS_PHASES.chunkReveal, 'currentPhaseReveal'],
        [STS_PHASES.stampCommit, 'currentPhaseStampCommit'],
        [STS_PHASES.stampReveal, 'currentPhaseStampReveal'],
        [STS_PHASES.proof, 'currentPhaseProof'],
        [STS_PHASES.claim, 'currentPhaseClaim'],
      ] as const;

      await mineToStartOfRound();
      await mineNBlocks(1);

      for (let block = 0; block < ROUND_LENGTH; block++) {
        const within = (await getBlockNumber()) % ROUND_LENGTH;
        let active = 0;
        for (const [, predicate] of offsets) {
          if (await redistribution[predicate]()) active += 1;
        }
        expect(active, `exactly one phase must be active at offset ${within}`).to.equal(1);
        await mineNBlocks(1);
      }
    });

    it('places the sampling start of a round at the first reveal block of the preceding one', async function () {
      const round = (await redistribution.currentRound()).toNumber();
      expect(await redistribution.samplingStartBlock(round)).to.equal(
        (round - 1) * ROUND_LENGTH + STS_PHASES.chunkReveal
      );
    });

    it('rejects round zero, which has no preceding sampling phase', async function () {
      await expect(redistribution.samplingStartBlock(0)).to.be.revertedWith('InvalidTargetRound');
    });
  });

  describe('randomness ordering', function () {
    it('opens the stamp anchor only once stage one commitments are fixed', async function () {
      await mineToParticipatingRound([await overlayOf(node_5)]);
      const round = (await redistribution.currentRound()).toNumber();
      const contract = await ethers.getContract('Redistribution', node_5);
      const registry = await ethers.getContract('StakeRegistry', node_5);
      const overlay = await registry.overlayOfAddress(node_5);

      expect(await redistribution.currentRevealRoundStampAnchorSet()).to.be.false;

      const root = '0x2222222222222222222222222222222222222222222222222222222222222222';
      const hash = '0x1111111111111111111111111111111111111111111111111111111111111111';
      await contract.commit(
        encodeAndHash(round, overlay, hexlify(CLAIMED_DEPTH), hash, root, revealNonce),
        round,
        hexlify(CLAIMED_DEPTH)
      );

      // Still unset during the commit phase: a participant choosing its chunk transform root
      // cannot know which stamp indexes will be useful.
      expect(await redistribution.currentRevealRoundStampAnchorSet()).to.be.false;

      await mineToPhase(STS_PHASES.chunkReveal);
      await contract.reveal(hexlify(CLAIMED_DEPTH), hash, root, revealNonce);

      expect(await redistribution.currentRevealRoundStampAnchorSet()).to.be.true;
      expect(await redistribution.currentRevealRoundStampAnchor()).to.not.equal(ZERO32);
      // The proof seed is a later role and must not exist yet.
      expect(await redistribution.currentProofSeedSet()).to.be.false;
    });

    it('opens the proof seed only once stamp samples are committed', async function () {
      const { round } = await playRoundUpToStampReveal();
      expect(await redistribution.currentProofSeedSet()).to.be.true;
      expect(await redistribution.currentStampSampleHashRevealRound()).to.equal(round);
    });

    it('selects two distinct positions below the density witness, in ascending order', async function () {
      const { round } = await playRoundUpToStampReveal();
      const positions = await redistribution.selectedStampPositions(round);

      expect(positions[0]).to.be.lt(positions[1]);
      expect(positions[1]).to.be.lt(15);
      expect(positions[2]).to.equal(15);
    });

    async function playRoundUpToStampReveal() {
      await mineToParticipatingRound([await overlayOf(node_5)]);
      const round = (await redistribution.currentRound()).toNumber();
      const contract = await ethers.getContract('Redistribution', node_5);
      const registry = await ethers.getContract('StakeRegistry', node_5);
      const overlay = await registry.overlayOfAddress(node_5);
      const root = '0x2222222222222222222222222222222222222222222222222222222222222222';
      const hash = '0x1111111111111111111111111111111111111111111111111111111111111111';

      await contract.commit(
        encodeAndHash(round, overlay, hexlify(CLAIMED_DEPTH), hash, root, revealNonce),
        round,
        hexlify(CLAIMED_DEPTH)
      );
      await mineToPhase(STS_PHASES.chunkReveal);
      await contract.reveal(hexlify(CLAIMED_DEPTH), hash, root, revealNonce);

      const stampHash = '0x3333333333333333333333333333333333333333333333333333333333333333';
      await mineToPhase(STS_PHASES.stampCommit);
      await contract.commitStampSampleHash(encodeAndHashStampCommit(round, overlay, stampHash, stampNonce), round);
      await mineToPhase(STS_PHASES.stampReveal);
      await contract.revealStampSampleHash(round, stampHash, stampNonce);

      return { round, contract, overlay, stampHash };
    }
  });

  describe('full round', function () {
    it('accepts the witnesses and weights the entry above its base stake density', async function () {
      const { round, players } = await playRound([node_5]);

      const reveal = await redistribution.currentReveals(0);
      expect(reveal.overlay).to.equal(players[0].overlay);
      expect(reveal.proofSubmitted).to.be.true;
      expect(reveal.stampRevealed).to.be.true;
      expect(reveal.stampHash).to.equal(players[0].stampSampleHash);
      expect(reveal.chunkTransformRoot).to.equal(players[0].chunkTransformRoot);

      // Both coefficients are at least 1x and capped at 2x each, so the effective density sits
      // in [base, 4 * base].
      expect(reveal.effectiveStakeDensity).to.be.gte(reveal.stakeDensity);
      expect(reveal.effectiveStakeDensity).to.be.lte(reveal.stakeDensity.mul(4));
      expect(round).to.equal((await redistribution.currentRevealRound()).toNumber());
    });

    it('pays the whole pot to the only proof validated node', async function () {
      const { round, players } = await playRound([node_5]);

      await mineToPhase(STS_PHASES.claim);
      await players[0].contract.claim();

      expect(await redistribution.currentClaimRound()).to.equal(round);
      expect(await redistribution.matchesSelectedTruth(players[0].overlay)).to.be.true;

      const accrued = await redistribution.pendingRedistributionPayouts(node_5);
      expect(accrued).to.be.gt(0);

      // Every withdrawn token is claimable: the contract holds exactly what it accrued.
      expect(await token.balanceOf(redistribution.address)).to.equal(accrued);

      const balanceBefore = await token.balanceOf(node_5);
      await players[0].contract.withdrawRedistributionPayout(node_5);
      expect(await token.balanceOf(node_5)).to.equal(balanceBefore.add(accrued));
      expect(await redistribution.pendingRedistributionPayouts(node_5)).to.equal(0);
      expect(await token.balanceOf(redistribution.address)).to.equal(0);
    });

    it('splits the pot between two nodes that agree, in proportion to weight', async function () {
      const { players } = await playRound([node_5, node_6]);

      await mineToPhase(STS_PHASES.claim);
      await players[0].contract.claim();

      const share5 = await redistribution.pendingRedistributionPayouts(node_5);
      const share6 = await redistribution.pendingRedistributionPayouts(node_6);

      expect(share5).to.be.gt(0);
      expect(share6).to.be.gt(0);

      // Conservation: nothing is created and nothing is lost, including the rounding remainder.
      expect(share5.add(share6)).to.equal(await token.balanceOf(redistribution.address));

      const weight5 = (await redistribution.currentReveals(0)).effectiveStakeDensity;
      const weight6 = (await redistribution.currentReveals(1)).effectiveStakeDensity;
      // Shares follow weights: the heavier entry is never paid less.
      if (weight5.gt(weight6)) expect(share5).to.be.gte(share6);
      if (weight6.gt(weight5)) expect(share6).to.be.gte(share5);
    });

    it('pays nobody and freezes the disagreeing node when the Schelling points differ', async function () {
      const other = '0x9999999999999999999999999999999999999999999999999999999999999999';
      const { players } = await playRound([node_5, node_6], {
        chunkSampleHashes: ['0x1111111111111111111111111111111111111111111111111111111111111111', other],
      });

      const registry = await ethers.getContract('StakeRegistry');
      await mineToPhase(STS_PHASES.claim);
      await players[0].contract.claim();

      const paid5 = await redistribution.pendingRedistributionPayouts(node_5);
      const paid6 = await redistribution.pendingRedistributionPayouts(node_6);

      // Exactly one Schelling point is selected, and only entries reporting it are paid.
      expect(paid5.isZero() !== paid6.isZero(), 'exactly one node is paid').to.be.true;

      const loser = paid5.isZero() ? node_5 : node_6;
      expect(await registry.lastUpdatedBlockNumberOfAddress(loser)).to.be.gt(0);
      expect(await redistribution.matchesSelectedTruth(paid5.isZero() ? players[0].overlay : players[1].overlay)).to.be
        .false;
    });

    it('freezes a node that revealed but never became proof validated', async function () {
      const registry = await ethers.getContract('StakeRegistry');
      const frozenBefore = await registry.lastUpdatedBlockNumberOfAddress(node_6);

      const { players } = await playRound([node_5, node_6], { skipProof: [1] });

      const reveal6 = await redistribution.currentReveals(1);
      expect(reveal6.proofSubmitted).to.be.false;

      await mineToPhase(STS_PHASES.claim);
      await players[0].contract.claim();

      // STS-1 treats an unproven stage one commit like a non-reveal: frozen by the same claim.
      expect(await registry.lastUpdatedBlockNumberOfAddress(node_6)).to.be.gt(frozenBefore);
      expect(await redistribution.pendingRedistributionPayouts(node_6)).to.equal(0);
      expect(await redistribution.pendingRedistributionPayouts(node_5)).to.be.gt(0);
    });

    it('refuses to claim a round with no proof validated entry', async function () {
      const { players } = await playRound([node_5], { skipProof: [0] });
      await mineToPhase(STS_PHASES.claim);
      await expect(players[0].contract.claim()).to.be.revertedWith('NoClaimableTruth');
    });

    it('refuses a second claim in the same round', async function () {
      const { players } = await playRound([node_5]);
      await mineToPhase(STS_PHASES.claim);
      await players[0].contract.claim();
      await expect(players[0].contract.claim()).to.be.revertedWith('AlreadyClaimed');
    });

    it('refuses a payout withdrawal with nothing accrued', async function () {
      const contract = await ethers.getContract('Redistribution', node_6);
      await expect(contract.withdrawRedistributionPayout(node_6)).to.be.revertedWith('NoPayout');
    });
  });

  describe('witness rejection', function () {
    /** Run a round to the proof phase, then submit proofs mutated by `mutate`. */
    async function submitMutatedProof(mutate: (proofs: any[], player: Player) => void) {
      const overlays = [await overlayOf(node_5)];
      await mineToParticipatingRound(overlays);

      const round = (await redistribution.currentRound()).toNumber();
      const anchor = await redistribution.currentRoundAnchor();
      const contract = await ethers.getContract('Redistribution', node_5);
      const chunkSampleHash = '0x1111111111111111111111111111111111111111111111111111111111111111';

      let entries = buildStampSample({
        roundAnchor: anchor,
        stampAnchor: ZERO32,
        batchId,
        batchDepth: BATCH_DEPTH,
        bucketDepth: BUCKET_DEPTH,
        claimedDepth: CLAIMED_DEPTH,
        sampleMaxValue: BigNumber.from(2).pow(256).sub(1),
      });
      let tree = new SortedPairMerkleTree(entries.map((e) => e.transformedChunkAddress));

      await contract.commit(
        encodeAndHash(round, overlays[0], hexlify(CLAIMED_DEPTH), chunkSampleHash, tree.root, revealNonce),
        round,
        hexlify(CLAIMED_DEPTH)
      );
      await mineToPhase(STS_PHASES.chunkReveal);
      await contract.reveal(hexlify(CLAIMED_DEPTH), chunkSampleHash, tree.root, revealNonce);

      const stampAnchor = await redistribution.currentRevealRoundStampAnchor();
      await mineToPhase(STS_PHASES.stampCommit);
      entries = restampEntries(entries, stampAnchor, sampleMaxValue);
      tree = new SortedPairMerkleTree(entries.map((e) => e.transformedChunkAddress));
      const sampleChunk = makeStampSampleChunk(entries.map((e) => e.transformedStampValue));
      const stampSampleHash = hexlify(sampleChunk.address());

      await contract.commitStampSampleHash(
        encodeAndHashStampCommit(round, overlays[0], stampSampleHash, stampNonce),
        round
      );
      await mineToPhase(STS_PHASES.stampReveal);
      await contract.revealStampSampleHash(round, stampSampleHash, stampNonce);

      const proofSeed = await redistribution.currentProofSeed();
      await mineToPhase(STS_PHASES.proof);
      const positions = await redistribution.selectedStampPositions(round);

      const proofs = [];
      for (const position of positions) {
        proofs.push(
          await buildStampProof({
            entries,
            sampleChunk,
            sampleIndex: Number(position),
            roundAnchor: anchor,
            proofSeed,
            batchId,
            batchOwner,
            transformTree: tree,
          })
        );
      }

      mutate(proofs, { entries } as unknown as Player);
      return contract.submitStsProof(round, proofs);
    }

    it('rejects a witness opened at a position the proof seed did not select', async function () {
      await expect(
        submitMutatedProof((proofs) => {
          proofs[0].sampleIndex = proofs[0].sampleIndex === 0 ? 1 : proofs[0].sampleIndex - 1;
        })
      ).to.be.revertedWith('StampWitnessPositionMismatch');
    });

    it('rejects a witness whose sample inclusion proof does not reconstruct the committed hash', async function () {
      await expect(
        submitMutatedProof((proofs) => {
          proofs[0].proofSegments = [...proofs[0].proofSegments];
          proofs[0].proofSegments[0] = ZERO32;
        })
      ).to.be.revertedWith('StampInclusionProofFailed');
    });

    it('rejects a witness that is not ordered against its neighbour', async function () {
      await expect(
        submitMutatedProof((proofs) => {
          const withLeft = proofs.find((p) => p.hasLeftValue);
          withLeft.leftValue = '0x' + 'ff'.repeat(32);
        })
      ).to.be.revertedWith('StampLocalOrderCheckFailed');
    });

    it('rejects a stamp the batch owner did not sign', async function () {
      await expect(
        submitMutatedProof((proofs) => {
          const flipped = Buffer.from(arrayify(proofs[0].signature));
          flipped[0] ^= 0xff;
          proofs[0].signature = hexlify(flipped);
        })
      ).to.be.reverted;
    });

    it('rejects a chunk that is not a leaf of the committed chunk transform root', async function () {
      await expect(
        submitMutatedProof((proofs) => {
          proofs[0].chunkTransformProofSegments = [...proofs[0].chunkTransformProofSegments];
          proofs[0].chunkTransformProofSegments[0] = ZERO32;
        })
      ).to.be.revertedWith('ChunkTransformMembershipFailed');
    });

    it('rejects opened chunk data that does not reconstruct the claimed chunk address', async function () {
      await expect(
        submitMutatedProof((proofs) => {
          proofs[0].chunkProof.proveSegment2 = ZERO32;
        })
      ).to.be.reverted;
    });

    it('rejects a chunk proof whose segments belong to a different chunk', async function () {
      await expect(
        submitMutatedProof((proofs) => {
          proofs[0].chunkProof.proofSegments2 = [...proofs[0].chunkProof.proofSegments2];
          proofs[0].chunkProof.proofSegments2[1] = ZERO32;
        })
      ).to.be.reverted;
    });
  });

  describe('phase gating', function () {
    it('refuses a stamp commit outside its phase', async function () {
      await mineToStartOfRound();
      const round = (await redistribution.currentRound()).toNumber();
      const contract = await ethers.getContract('Redistribution', node_5);
      await expect(contract.commitStampSampleHash(ZERO32, round)).to.be.revertedWith('NotStampCommitPhase');
    });

    it('refuses a stamp commit from a node with no stage one reveal', async function () {
      await mineToStartOfRound();
      const round = (await redistribution.currentRound()).toNumber();
      const contract = await ethers.getContract('Redistribution', node_5);
      await mineToPhase(STS_PHASES.stampCommit);
      await expect(contract.commitStampSampleHash(ZERO32, round)).to.be.revertedWith('NoChunkSampleHashReveal');
    });

    it('refuses proof submission outside its phase', async function () {
      await mineToStartOfRound();
      const round = (await redistribution.currentRound()).toNumber();
      const contract = await ethers.getContract('Redistribution', node_5);
      await expect(contract.submitStsProof(round, [])).to.be.reverted;
    });
  });
});
