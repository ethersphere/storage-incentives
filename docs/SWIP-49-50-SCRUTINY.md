# SWIP-049 / SWIP-050 implementation scrutiny

Review of [ethersphere/SWIPs#98](https://github.com/ethersphere/SWIPs/pull/98) (SWIP-049,
fixed postage-stamp usability for redistribution rounds) and
[ethersphere/SWIPs#100](https://github.com/ethersphere/SWIPs/pull/100) (SWIP-050, Sequential
Transformation Scheme 1), written while implementing both against this repository at
`feat/swip-51-option-b` (Phase 4 claim path + SWIP-51 Option B bounded commits).

Findings are graded:

- **BLOCKER** — the spec as written cannot be implemented, or implementing it literally
  breaks an existing security property.
- **GAP** — the spec is silent and the implementer has to invent something that materially
  changes behaviour.
- **NOTE** — correct but worth confirming, or an economic/UX consequence that deserves an
  explicit decision.

Each finding says what this branch actually does, so the deviation list is reviewable.

---

## 0. Starting-point mismatch (read this first)

SWIP-049 Appendix B is written as a diff "relative to the Phase 5 starting diff", and
assumes the Redistribution contract already has a separate stamp sample with
`stampInclusionFunction`, `stampProofLast`, `stampProof1`, `stampProof2`, and a
`keccak256(abi.encodePacked(postageId, index, roundAnchor))` transform.

**No such code exists in `storage-incentives`.** `master` and `feat/swip-51-option-b` are at
Phase 4: three `ChunkInclusionProof` entry proofs, each carrying one `PostageProof`, verified
by `stampFunction`, plus SWIP-51 Option B's bounded commit set and `_finalizeParticipation`.

So SWIP-049 Appendix B cannot be applied as a diff. Two of its three claim-side items are
also superseded by SWIP-050, which rewrites the claim path wholesale.

**Question for the PRs:** is there a Phase 5 branch that SWIP-049 Appendix B was written
against? If so it should be named in the SWIP, because the diff is unreviewable without it.
If not, Appendix B should be rebased onto the public Phase 4 + SWIP-51 code.

_This branch:_ implements SWIP-049's PostageStamp side in full (that is the substantive part
and it is starting-point independent), then wires the historical scope into the **existing**
Phase 4 claim path, then layers SWIP-050 on top.

---

## 1. SWIP-049

### 1.1 BLOCKER — `previousPrice` alone cannot prove the price at sampling start

`_priceStateAtSamplingStart` takes the `previousPrice` branch whenever
`lastUpdatedBlock >= samplingStartBlock`, and rolls `totalOutPayment` back at `previousPrice`.
That is only correct if the price period _before_ `lastUpdatedBlock` actually covered
`samplingStartBlock` — i.e. if the second-most-recent price update was at or before
`samplingStartBlock`.

The SWIP argues this holds because "after activation, `setPrice` is called only by a
redistribution claim", and a claim updates the price only after verifying proofs. Two ways
that argument fails:

1. **`PriceOracle.setPrice(uint32)` is a live admin path** (`src/PriceOracle.sol:76`). It has
   `DEFAULT_ADMIN_ROLE` only — no round limit, no rate limit — and it calls
   `PostageStamp.setPrice`. One admin call during an open round silently corrupts
   `outPaymentAtStart` for every batch in that round's claim, in the direction that lets
   _under_-funded batches through (if the admin lowered the price) or rejects valid ones
   (if raised). The SWIP's own Security Considerations do not mention the admin path.
2. `redistributionMinimumNormalisedBalance` is an unrestricted `view` that Bee is told to
   use. Called for any block older than one price period it returns a plausible but wrong
   number with no error.

The reconstruction is unverifiable from the state the SWIP stores: nothing records when
`previousPrice` became active, so the contract cannot tell a valid rollback from an invalid one.

**Fix (one extra `uint64`):** store `previousPriceUpdatedBlock` alongside `previousPrice` and
require `previousPriceUpdatedBlock <= samplingStartBlock` on the rollback branch, reverting
`PriceHistoryUnavailable` otherwise. This turns a silent wrong answer into a revert and makes
the invariant checkable on-chain instead of argued in prose.

_This branch:_ implements `previousPriceUpdatedBlock` and the check. Also recommends
restricting `PriceOracle.setPrice` — see 1.7.

### 1.2 BLOCKER — the `topUp` rule change strands batches permanently

SWIP-049 Appendix A item 2 changes `topUp` from

```solidity
if (remainingBalance(_batchId) + _topupAmountPerChunk < minimumInitialBalancePerChunk())
```

to

```solidity
if (remainingBalance(_batchId) < minimumInitialBalancePerChunk())
```

The stated intent — "a top-up cannot rescue a nearly expired batch into an already open
round" — is met. The unstated consequence is that **once a batch's remaining balance falls
below the minimum it can never be topped up again, at any size, and is guaranteed to expire.**

`minimumValidityBlocks` is currently `17280` (~24h), not 912. So the cliff is not "six rounds
of balance" — it is **24 hours of balance at the current price**. Any batch that drops under
24h of runway is dead. Because the price itself rises when redundancy is low, the threshold
moves up under a batch that is standing still: a batch with 30h of runway can cross the line
without its owner doing anything, and the owner then cannot save it.

That is a user-visible product change (today, a batch can be rescued at any point before
expiry) which the SWIP presents as an incidental hardening.

**Narrower alternative that preserves the intent:** allow a top-up whenever
`remainingBalance >= ROUND_USABILITY_BLOCKS * lastPrice` — i.e. block only the rescue of a
batch that is _already outside_ the redistribution scope — instead of gating on the full
24-hour `minimumInitialBalancePerChunk()`. That still makes rescue-into-an-open-round
impossible, without a 24h death cliff.

**Question for the PRs:** is the 24h top-up cliff intended, or is `MIN_OPERATION_VALIDITY_BLOCKS`
(912) meant to be the gate and `minimumValidityBlocks` meant to come down to it?

_This branch:_ implements the SWIP as written (gate on `minimumInitialBalancePerChunk()`)
because that is what is specified, and adds an explicit test naming the cliff, so the
behaviour is visible in review rather than discovered in production.

### 1.3 NOTE — 912 gates the setter; 17280 gates every batch operation

Worth stating plainly because it changes how 1.2 reads. The two constants do different jobs:

- `MIN_OPERATION_VALIDITY_BLOCKS` (912) appears in exactly one place, the guard in
  `setMinimumValidityBlocks`. It bounds what an admin may _configure_.
- `minimumValidityBlocks` (17280 by default) is what `createBatch`, `copyBatch`, `topUp` and
  `increaseDepth` are all held to, via `minimumInitialBalancePerChunk() = minimumValidityBlocks * lastPrice`.

The SWIP writes all three balance rules as "at least `912 * lastPrice` per chunk". In the code
every one of them is enforced at `17280 * lastPrice`, roughly 19x higher. The 912 never enters
those comparisons.

This is not a contradiction — the SWIP says "a deployment may require a larger minimum, but it
must not permit less than 912 blocks", and 17280 satisfies that, so the sufficiency argument in
the Rationale holds. The issue is that a reader reasons about six rounds of runway while the
operative constraint is a day of runway, and the severity of the top-up cliff in 1.2 scales with
whichever number is live.

Worth stating in the SWIP which of the two numbers deployments are expected to run.

### 1.4 BLOCKER — the import minimum can silently drop live batches during migration

Appendix A item 2 adds two things to `copyBatch`: permanent id consumption, and the creation
minimum:

```solidity
if (_initialBalancePerChunk < minimumInitialBalancePerChunk()) revert InsufficientBalance();
```

Before this SWIP `copyBatch` had no balance minimum at all — it imported whatever balance it was
given. Now an imported batch must clear `minimumValidityBlocks * lastPrice`, which is ~24 hours of
runway (see 1.3).

`copyBatchBulk` wraps each `copyBatch` in a bare `catch { }` and emits `CopyBatchFailed(i, batchId)`.
So any batch in the source contract that is alive but under a day of runway now reverts, is
swallowed, and is **dropped from the migration**. Those are precisely the batches a migration is
most likely to be carrying, since an old contract accumulates near-expiry batches. The operator
sees a successful transaction with some `CopyBatchFailed` events and nothing to distinguish a
policy rejection from malformed input.

**Questions for the PR:** is dropping under-funded batches on import the intended migration
semantics? If so it should be stated, because it silently changes what a migration preserves. If
not, either exempt `copyBatch` from the minimum or gate it at `ROUND_USABILITY_BLOCKS` rather than
the full 24-hour minimum.

### 1.4b NOTE — permanent batch-id consumption, two smaller consequences

The reason for `batchIdUsed` is sound: recreating an expired id would make old signatures valid
against a new incarnation. Two things the SWIP does not address.

- **Expired ids can no longer be re-imported.** Today `copyBatch` only rejects an id whose batch is
  currently live, so an expired id is free. After this SWIP it is consumed forever. That is
  probably the intent, but it means a re-run of an import against the same contract behaves
  differently from the first run. Worth stating.
- **Unbounded state growth.** One permanent, never-reclaimable slot per batch ever created.
  Acceptable, but it should be an explicit decision rather than a side effect.

Note that a _retry of failed entries_ is unaffected: a reverting inner `copyBatch` rolls back
`batchIdUsed[batchId] = true` along with everything else.

_This branch:_ implements both as specified, and makes `copyBatch` revert a distinct
`BatchIdAlreadyUsed` rather than `BatchExists`. That only helps a direct call or an off-chain
simulation — `copyBatchBulk`'s bare `catch` captures no reason either way.

### 1.5 GAP — `redistributionBatchAt` does not reject future sampling blocks

`redistributionMinimumNormalisedBalance` guards `samplingStartBlock > block.number` via
`_priceStateAtSamplingStart`. `redistributionBatchAt` has no such guard, so a future block
number silently resolves to the current depth (because `lastUpdatedBlockNumber <
samplingStartBlock` holds trivially). Harmless inside `claim`, wrong for the Bee-facing view.

_This branch:_ guards both.

### 1.6 NOTE — the depth-history rotation is correct; one equality is load-bearing

`_firstSamplingStartAfter` returns the first sampling start _strictly after_ `oldDepthBlock`,
and `_recordDepthBeforeIncrease` skips recording when `block.number <
firstSamplingStartThatCouldUseOldDepth`. Walking the SWIP's own worked example (depth 20 from
block 120; dilutions at 220, 260, 360, 400, 510; sampling starts 190, 342, 494) reproduces the
stated `older/previous/current` triples at every step, and the two lookups
`depthAtSamplingStart(190) = 20` and `depthAtSamplingStart(342) = 22` both resolve. The
algorithm is right.

The load-bearing detail is that a dilution _in_ the sampling-start block must still record the
old depth, which is why the comparison is `<` and not `<=`. This is easy to break in a later
refactor and deserves a regression test naming it. _This branch:_ has one.

A second detail the SWIP does not state: `_depthAtSamplingStart` uses `previousDepth != 0` as
its "slot occupied" sentinel. That is safe only because a valid batch always has
`depth > bucketDepth >= minimumBucketDepth >= 1`. If `minimumBucketDepth` could ever be 0 the
sentinel collides with a real depth. Worth an explicit invariant comment.

### 1.7 NOTE — the 755-skipped-round tolerance checks out, and gets safer under SWIP-050

Verified against the deployed constants (`changeRate[1] = 1049206` for a claimed round,
`changeRate[0] = 1049417` per skipped round, `priceBase = 1048576`):

- window `(r-1)*152+38` … `r*152+151` = 266 blocks inclusive ✓
- earliest preceding-round price update under the _current_ schedule is at `samplingStart+38`
  (claim phase starts at `B'+76`), leaving 418 of 456 block-units and a 228-block residual
  window ✓
- solving `418 / 228 = 1.8333` against the compounded rate gives 755.1 skipped rounds ✓

Two things to add to the SWIP:

- Under **SWIP-050's** schedule the claim phase starts at `B'+133`, i.e. `samplingStart+95`,
  not `+38`. The worst case improves, so 456 stays conservative — but the SWIP's stated
  derivation is against the _old_ phase table and will read as wrong once 050 lands.
- The analysis assumes the oracle is the only writer. It is not (see 1.1). Restricting
  `PriceOracle.setPrice` to non-open-round blocks, or removing it post-activation, is the
  change that makes the whole section true rather than approximately true.

### 1.8 NOTE — the SWIP-049 index check is strictly stronger than today's

`getPostageIndex(fullStampIndex) < postageStampIndexCount(depthAtSamplingStart, bucketDepth)`
replaces today's check against the _live_ depth. A stamp minted on an index created by a
dilution mid-round is now rejected even though it is a perfectly valid stamp for upload
purposes. That is the point of the SWIP, but it means honest nodes that sampled slightly late
will produce unclaimable proofs. Bee's sampling boundary must match the contract's exactly or
claims fail for reasons the operator cannot see. Worth an explicit "Bee and contract must agree
to the block" statement plus a debug view.

---

## 2. SWIP-050

### 2.1 BLOCKER — `sampleMaxValueForDepth(depth)` inverts the anti-overreporting mechanism

`stampDensityCoefficientQ64(lastValue, depth)` compares the largest proven transformed stamp
value `x` against `sampleMaxValueForDepth(depth)`. That function is **never defined** in the
SWIP, and the fact that it takes `depth` at all is the problem.

Today, `estimateSize` compares the 16th transformed chunk value against a **fixed**
`sampleMaxValue` (`src/Redistribution.sol:143`). That fixed limit is precisely what stops
depth overreporting: a node's reserve is capacity-bounded and roughly depth-independent, so
its 16th smallest transformed value is roughly depth-independent too, while
`stakeDensity = stake * 2^(depth - height)` grows with the claimed depth. The fixed ceiling is
the only thing that makes a bigger claimed depth cost something.

If the limit scales with depth, that brake is removed:

- base weight gains `2^k` from overreporting by `k` bits;
- `L` gains `2^k`, so `L/x` — and therefore the density coefficient — is unchanged;
- so overreporting is a **free `2^k`**.

The SWIP's own "Coefficient safety argument" only analyses _under_-reporting. It never checks
the overreporting direction, which is the direction the fixed limit exists to police.

**Fix:** the stamp sample limit must be a depth-independent constant, exactly like
`sampleMaxValue`. `stampDensityCoefficientQ64` should not take `depth`.

_This branch:_ implements `stampSampleMaxValue` as a single admin-settable constant mirroring
`sampleMaxValue`, and drops the `depth` parameter. **This needs confirmation before the SWIP
is finalised** — if a depth-dependent limit was deliberate, the overreporting analysis is
missing and needs to be supplied.

### 2.2 BLOCKER — the utilization coefficient is unbounded and rewards buying deep batches

```solidity
uint256 private constant MAX_COEFFICIENT_Q64 = (1 << 32) * Q64;
...
utilizationCoefficient = max(1, cbrt(1 / (2 * avgIndexRatio)))
```

`avgIndexRatio = (withinBucketIndex + 1) / slotsPerBucket` where
`slotsPerBucket = 2^(batchDepth - bucketDepth)`. With `bucketDepth = 16` and a depth-32 batch,
`slotsPerBucket = 65536`; three witnesses at index 0 give `avgIndexRatio = 1/65536`, a benefit
ratio of 32768, and a coefficient of **32×**. The cap only bites at `2^32`.

The SWIP's illustrative table stops at `2×` and the prose says "worse utilization is not
penalized below 1x", which reads as if the useful range were `1×…2×`. It is not. As specified,
the cheapest way to multiply your redistribution weight by 32 is: buy a very deep batch, stamp
only the lowest index of each bucket, and never fill it. That rewards _wasting_ batch capacity
— the opposite of the stated motivation ("Batch utilization: lower within-bucket stamp indexes
receive a continuous benefit because ordinary uploads tend to fill lower indexes before higher
ones"). The heuristic "uploads fill low indexes first" is true of honest uploaders and trivially
gameable by anyone optimising for it.

Both coefficients multiply, so the combined ceiling as written is `2^32 × 2^32`.

**Fix:** cap each coefficient at `2 * Q64` (the range the SWIP's tables actually describe), and
state the cap in the spec. The safety argument in "Coefficient safety argument" assumes the
product is `2^(2k/3)`, which is only true if each factor is bounded by the density actually
proven — an explicit cap is the cheapest way to guarantee it.

_This branch:_ caps both coefficients at `2×` (`MAX_COEFFICIENT_Q64 = 2 * Q64`) and tests the
boundary.

### 2.3 BLOCKER — `bucketDepth < claimedDepth` rejects every real batch

```solidity
if (snapshot.bucketDepth < claimedDepth) revert BucketDepthBelowClaimedDepth(proof.postageId);
```

`bucketDepth` is fixed at batch creation and is `16` for essentially every batch on mainnet
(`minimumBucketDepth`). `claimedDepth` is the node's storage depth, which is already above 16
on the live network and rises as the network grows. **This check rejects every mainnet batch
at any realistic depth**, so no STS-1 proof could ever pass.

The neighbourhood binding the check appears to be reaching for is already provided twice over:
`getPostageBucket(index) == addressToBucket(chunkAddress, bucketDepth)` binds the stamp to the
chunk, and `inProximity(chunkAddress, firstAnchor, claimedDepth)` binds the chunk to the
neighbourhood.

_This branch:_ drops the check. If it was guarding something real, the SWIP needs to say what.

### 2.4 BLOCKER — `pendingCompletion` is unbounded and bricks the contract

`finalizeIncompleteCommitments` iterates the entire `pendingCompletion` array in a single
`claim` transaction. Entries are added on every stage-one commit and removed only by a
successful proof or by a successful claim.

STS-1 has _five_ sequential stages a participant must clear. Any round where nothing claims —
no valid chunk reveal, no valid stamp reveal, no passing proof, or simply nobody calling
`claim` — carries its entire commit set forward. After enough such rounds the first successful
claim runs out of gas, which means **no claim can ever succeed again**, which means the array
never drains. It is a self-reinforcing brick, and it is reachable without an attacker: a long
quiet stretch on a small network does it.

It is also reachable _with_ an attacker, cheaply: commit from many overlays, never proceed.

**Fix:** the bound already exists one layer down. SWIP-51 Option B caps a round at
`MAX_COMMITS = 32` and `_finalizeParticipation` already freezes non-finishers of the previous
round, triggered by the next round's first commit — so an unfinished participant is always
resolved within one round, from an array that is bounded by construction. A separate
cross-round carry-over list is not needed to preserve the invariant SWIP-050 wants.

_This branch:_ extends Option B's `_finalizeParticipation` to treat "revealed but never
proof-validated" the same as "never revealed", and drops `pendingCompletion` entirely. Every
freeze loop stays bounded by `MAX_COMMITS`.

### 2.5 GAP — proportional payout requires the pot to move, and the SWIP never says so

`applyClaimPayoutsAndFreezeDisagreements` accrues into `pendingRedistributionPayouts` and
`withdrawRedistributionPayout` calls `transferRedistributionToken(receiver, amount)` — a
function that does not exist and has no definition anywhere in the SWIP.

Today `PostageStamp.withdraw(beneficiary)` transfers the whole pot directly to one winner and
Redistribution never touches BZZ. Proportional payout means Redistribution must **custody the
pot**: `withdraw(address(this))`, hold an ERC20 balance, and pay out on demand. That is a
material change to the trust surface of a contract that currently holds no funds, and it needs:

- the BZZ token address in Redistribution (new constructor argument → deployment change);
- a rounding-remainder policy (the SWIP's `if (pot > paid) pendingRedistributionPayouts[lastTruthyOwner] += pot - paid;`
  hands the dust to whichever truthy entry happens to be last in the reveal array — arbitrary,
  and a reason to reorder your reveal);
- an answer for what happens to accrued-but-unwithdrawn balances if the contract is paused,
  replaced, or migrated. `withdrawRedistributionPayout` is `whenNotPaused`, so pausing freezes
  earned payouts indefinitely. There is no admin rescue.

**Question for the PRs:** is Redistribution-as-custodian accepted? It changes the deployment
topology and the audit scope.

_This branch:_ implements custody with an explicit constructor token argument, distributes the
remainder to the **highest-weight** truthy entry rather than the last one (deterministic, not
order-dependent), and leaves withdrawal callable while paused so a pause cannot strand earned
funds.

### 2.6 NOTE — `chunkSampleHash` becomes an unverified component of the Schelling point

SWIP-050 removes chunk-sample witnesses ("STS-1 does not open random chunk-sample witnesses")
but keeps `chunkSampleHash` in the selected truth tuple. Nothing in the contract ever checks
it against anything.

Consequence: a participant that can pass the stamp proofs — which requires real batches and
real chunks, but says nothing about the chunk _sample_ — can put an arbitrary value in
`chunkSampleHash`. If its weight wins the truth draw, every honest node in the neighbourhood
disagrees with the selected point and is frozen under the disagreement rule, while the attacker
takes the whole pot. Today that is not possible: the winner must open three chunk witnesses
against `winner.hash`.

The SWIP's Rationale says `chunkSampleHash` "remains in the Schelling point because it
coordinates the chunk-side convention followed by honest nodes". Coordination among honest
nodes is a benefit; being freezable on an unverifiable value is a cost, and the cost is not
discussed in Security Considerations.

Options worth a sentence in the SWIP: keep one chunk witness; or drop `chunkSampleHash` from
the truth tuple and let `stampSampleHash` (which _is_ proven) carry the Schelling point alone.

_This branch:_ implements as specified and adds a test that documents the freeze exposure, so
the trade-off is on the record rather than latent.

### 2.7 NOTE — the proof seed is grindable by the first stamp revealer

`openProofSeedFromStampSampleHashReveal` mixes `block.prevrandao` at the block of the **first**
valid stamp-sample reveal. The first revealer chooses that block: it can inspect the resulting
`currentProofSeed`, see which of its 16 sample positions would be opened (and, via
`transformedChunkAddressForStampedChunk`, which chunk segment it must produce), and simply not
send the transaction if the draw is inconvenient — retrying in a later block of the 19-block
window. That is up to 19 free re-rolls of a 2-of-15 selection for whoever moves first, and the
best position to have is "first" which is cheap to secure.

`stampSampleHash` is already committed, so this does not let a node invent a sample. It does
let a node with a partially-supported sample steer away from its weak positions, which is
exactly what "This prevents a participant from safely filling a sample with a few repeated
provable values while avoiding unsupported positions" is meant to stop.

Mitigation worth considering: accumulate `prevrandao` across _all_ stamp reveals (as
`updateRandomness()` already does for the round seed) and derive the proof seed lazily at first
use in the proof phase, so no single participant fixes it. The last revealer still has an
advantage — the same trade-off the existing design already accepts — but it is no longer free
to the first mover.

_This branch:_ implements the SWIP as written and flags it. Changing the randomness derivation
is a spec decision, not an implementation one.

### 2.8 NOTE — local ordering is not sample ordering

`verifyLocalStampOrder` proves `left < value < right` for each opened position. With three
opened positions that constrains at most 8 of 16 slots, and says nothing about the rest. A
sample can be globally unsorted and still pass, as long as the opened neighbourhoods are
locally consistent — and the Merkle root makes those consistent by construction.

This mirrors what `checkOrder` already does on the chunk side, so it is not a regression. But
SWIP-050's Witness Verification section says "The selected position satisfies the ordered-sample
proof rules", which overstates what is proven. Worth softening to "locally ordered against its
immediate neighbours".

### 2.9 GAP — `MerkleProof.verify` for `chunkTransformRoot` has no position or length binding

`verifyChunkBinding` uses OpenZeppelin's `MerkleProof.verify`, which is a **sorted-pair**
implementation: it commits to a _set_, not a _list_, with no leaf index and no length. Combined
with `chunkTransformRoot` being participant-specific, outside the Schelling point, and
completeness-unverified, the root proves only "this transformed address is in some multiset I
committed to before I knew the stamp anchor".

That is enough for the property SWIP-050 actually claims (the node had the chunk before it knew
which stamps would be useful), so this is not a break. But two things should be stated:

- leaves must be pre-hashed or the tree is second-preimage-attackable against inner nodes —
  here leaves are `keccak256` transformed addresses, which is fine, but Bee's tree
  construction must be specified, not left to each client;
- the SWIP says the root is over "the claimed **complete** list" of the reserve, and nothing
  verifies completeness. A node can include an arbitrary subset. Since it cannot predict
  which subset is useful, the incentive still points at "include everything" — but the word
  "complete" should not appear in a normative sentence when nothing enforces it.

_This branch:_ implements as specified and documents the tree construction Bee must match.

### 2.10 GAP — a long list of undefined identifiers

Appendix A references, without defining: `requireStampSampleHashCommitPhase`,
`requireStampSampleHashRevealPhase`, `requireProofSubmissionPhase`, `roundStartBlock`,
`POSTAGE_SCOPE_LEAD`, `sampleMaxValueForDepth`, `transferRedistributionToken`,
`postageStampIndexCount`/`getPostageIndex`/`getPostageBucket`/`addressToBucket`/`inProximity`
(these exist), `Math` and `MerkleProof` (OpenZeppelin imports), plus the errors
`NoClaimableTruth`, `NoPayoutWeight`, `NoPayout`, `ProofAlreadySubmitted`,
`StampWitnessPositionMismatch`, `StampInclusionProofFailed`, `StampLocalOrderCheckFailed`,
`StampReserveCheckFailed`, `BatchInsufficientBalanceAtSamplingStart`,
`BucketDepthBelowClaimedDepth`, `ChunkTransformMembershipFailed`, `ChunkAddressMismatch`,
`NoChunkSampleHashReveal`, `NoStampSampleHashReveal`, `MissingAnchor`,
`PreviousCommitmentStillPending`.

`POSTAGE_SCOPE_LEAD = 114` is recoverable from `roundStartBlock(r) - 114 = (r-1)*152 + 38`,
which matches SWIP-049 ✓. The rest are inferable but should be listed.

### 2.11 NOTE — phase table verified, but it moves existing boundaries

`38 + 19 + 38 + 19 + 19 + 19 = 152` ✓, and `B+38` as the first reveal block keeps SWIP-049's
`samplingStartBlock(r) = (r-1)*152 + 38` exact ✓.

But the current contract derives phases arithmetically from `ROUND_LENGTH`:
`currentPhaseCommit()` is `% 152 < 38`, `currentPhaseReveal()` is `38 <= % 152 < 76`,
`currentPhaseClaim()` is `% 152 >= 76`. SWIP-050 shortens reveal to 19 blocks and inserts three
new phases into what is currently the claim phase. That changes:

- `commit`'s `PhaseLastBlock` guard (`block.number % ROUND_LENGTH == (ROUND_LENGTH / 4) - 1`);
- `currentRoundAnchor()`, which switches on `currentPhaseClaim()` to decide between
  `currentSeed()` and `nextSeed()` — with three new phases, "claim phase" no longer means
  "after reveals are done", and `isParticipatingInUpcomingRound` reads the wrong anchor for
  most of the round;
- `PriceOracle`'s independent `ROUND_LENGTH = 152` and `currentRound()`.

None of this is hard, but SWIP-050 should say that the phase predicates become table-driven
rather than `ROUND_LENGTH/4`-driven, because third-party tooling reads those views.

### 2.12 NOTE — `selectedStampPositions` is correct

```
a = H(seed,0) % 15            // 0..14
b = H(seed,1) % 14            // 0..13
if (b >= a) b += 1            // 0..14, b != a
if (b < a) swap               // sorted
```

Uniform over unordered pairs from `0..14`, no replacement, sorted ✓. Position 15 always opened
✓. Modulo bias over a 256-bit draw is negligible ✓.

### 2.13 NOTE — contract size

`Redistribution.sol` is 1353 lines before any of this. Adding STS-1's six phases, two commit/
reveal pairs, Q64.64 cube-root arithmetic, stamp witness verification, chunk binding and
proportional payout will very likely exceed the EIP-170 24 KB limit at `runs: 1000`.

_This branch:_ moves the Q64.64 coefficient arithmetic and the stamp witness verification into
libraries. Flagging because it constrains how the SWIP's appendix can be laid out, and because
a size-driven split changes the deployment scripts.

### 2.14 NOTE — interaction with SWIP-51 Option B is unaddressed

SWIP-050 was written against a Redistribution without Option B. Option B already has:

- `MAX_COMMITS = 32` bounded admission with stake-weighted eviction;
- `_finalizeParticipation` doing truth selection + tentative winner + non-reveal freezes,
  triggered either by `claim` or by the next round's first `commit`;
- `participationFinalized[round]`, `lastRedundancyCount`, `lastClaimedDepth`,
  `MIN_NONREVEAL_FREEZE_DEPTH`.

SWIP-050's `pendingCompletion` (2.4) and its truth/payout path overlap with all of this. The
two need an explicit reconciliation in the SWIP, not just in the implementation — in particular
whether `lastClaimedDepth`'s floor on freeze duration still applies when the "winner" is now a
set rather than one entry.

_This branch:_ keeps Option B as the participation-tracking layer and folds STS-1 proof
validation into it, per 2.4. `lastClaimedDepth` is retained and set from the selected truth
depth.

### 2.15 NOTE — `PriceOracle.setPrice` truncates above ~4.2 million

Not a SWIP issue, but it surfaced while testing 1.1 and it bears on the same admin path:

```solidity
uint64 _currentPriceUpScaled = _price << 10;   // _price is uint32
```

The shift happens in `uint32` and only then widens to `uint64`, so any `_price >= 2^22`
(4,194,304) silently loses its high bits. The admin path cannot set a large price even when it
wants to, and the failure is silent rather than a revert. Worth fixing as `uint64(_price) << 10`
independently of either SWIP.

### 2.16 NOTE — `chunkTransformRoot` leaf ordering has to be specified

Discovered while implementing: because STS-1 fixes `chunkTransformRoot` in stage one and only
derives the stamp indexes after the stamp anchor exists, a naive implementation that builds the
tree in discovery order produces a different root before and after that re-derivation, and every
membership proof fails. The fix is to hold leaves in canonical (ascending) order, which the
sorted-pair tree makes natural.

This is invisible in the SWIP because its appendix never shows the client side. It should be
stated normatively, alongside the rest of the tree construction (2.9), or every client will find
it the hard way.

### 2.17 BLOCKER — the SOC binding conflates two different chunk addresses

`transformedChunkAddressForStampedChunk` in Appendix A.8 ends with:

```solidity
bytes32 ordinaryChunkAddress = chunkProof.socProof.length > 0
    ? chunkProof.socProof[0].chunkAddr
    : chunkProof.proveSegment;
...
if (ordinaryChunkAddress != stampedChunkAddress) revert ChunkAddressMismatch();
```

For a single owner chunk these are two different things. `socProof[0].chunkAddr` is the
**wrapped** chunk address, the thing the BMT reconstruction produces. `proveSegment` is the
**SOC address**, `keccak256(identifier, signer)`, and that is what Bee stamps and what the
existing Phase 4 `stampFunction` verifies the batch-owner signature against. Requiring the
stamped address to equal the wrapped address rejects **every honest SOC witness**.

The current contract keeps the two apart deliberately: `stampFunction` uses
`entryProof.proveSegment` for bucket alignment, signature recovery and proximity, while
`inclusionFunction` compares the BMT reconstruction against `socProof[0].chunkAddr`. SWIP-050
collapses that into one variable and loses the distinction.

**Fix:** compare the stamped address against `chunkProof.proveSegment` — which is the SOC address
for a SOC and the plain chunk address otherwise — and keep the BMT reconstruction checked against
`ordinaryChunkAddress`.

_This branch:_ implements the fix, and covers it with a round in which all sixteen sample entries
are SOCs. That test fails against the appendix as written.

### 2.18 NOTE — the stamp anchor is derived after the round seed advances

`reveal` calls `updateRandomness()` and then derives the stamp anchor from the updated `seed`. In
the current contract the BMT transform key (`currentRevealRoundAnchor`) is fixed _before_
`updateRandomness()` and is therefore not grindable by a revealer. The stamp anchor is, in the
same first-mover sense as 2.7: whoever reveals first picks their block and re-rolls every
transformed stamp value in the round.

The gain is small — the density witness is the sixteenth smallest of a sample the node builds
_after_ seeing the anchor, so re-rolling mostly shuffles which of its own stamps are smallest —
but it is a property the chunk-side anchor deliberately does not have, and the SWIP does not say
whether that difference is intended. Deriving the stamp anchor from `currentRevealRoundAnchor`
rather than from the post-update `seed` would remove it at no cost.

---

## 3. Summary of deviations implemented on this branch

| #   | Deviation                                                                          | Reason                                               |
| --- | ---------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 1.1 | added `previousPriceUpdatedBlock` + rollback validity check                        | reconstruction otherwise unverifiable                |
| 1.4 | `copyBatch` reverts distinct `BatchIdAlreadyUsed`                                  | identifiable from a direct call or simulation        |
| 1.5 | `redistributionBatchAt` rejects future sampling blocks                             | parity with the balance view                         |
| 2.1 | stamp sample limit is depth-**independent**                                        | depth-scaled limit makes overreporting free          |
| 2.2 | both coefficients capped at `2×`                                                   | unbounded as written; rewards wasting batch capacity |
| 2.3 | dropped `bucketDepth < claimedDepth`                                               | rejects every real batch                             |
| 2.4 | dropped `pendingCompletion`; extended Option B finalize                            | unbounded loop bricks `claim`                        |
| 2.5 | explicit BZZ custody; remainder to highest-weight entry; withdrawal survives pause | underspecified                                       |

Items **1.1, 1.2, 2.1, 2.2, 2.3, 2.4, 2.17** are the ones worth raising in the PRs before the
SWIPs are finalised. **2.5** is a deployment-topology question. **2.16** needs one normative sentence.
The rest are editorial.

Implementation notes for Bee and for reviewers: [STS-1.md](./STS-1.md).
