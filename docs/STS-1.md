# STS-1 and fixed postage scope — what changed, and what Bee has to do

Implementation notes for [SWIP-049](https://github.com/ethersphere/SWIPs/pull/98) (fixed
postage-stamp usability for redistribution rounds) and
[SWIP-050](https://github.com/ethersphere/SWIPs/pull/100) (Sequential Transformation Scheme 1),
as landed on this branch. Deviations from the SWIP text, and the reasoning behind them, are in
[SWIP-49-50-SCRUTINY.md](./SWIP-49-50-SCRUTINY.md).

**Status: proposed, under review. Not deployed.**

---

## 1. The round is now six phases

A round is still 152 blocks. For a round starting at block `B`:

|            Blocks | Length | Phase                    | Predicate                   |
| ----------------: | -----: | ------------------------ | --------------------------- |
|    `B+0` … `B+37` |     38 | chunk sample hash commit | `currentPhaseCommit()`      |
|   `B+38` … `B+56` |     19 | chunk sample hash reveal | `currentPhaseReveal()`      |
|   `B+57` … `B+94` |     38 | stamp sample hash commit | `currentPhaseStampCommit()` |
|  `B+95` … `B+113` |     19 | stamp sample hash reveal | `currentPhaseStampReveal()` |
| `B+114` … `B+132` |     19 | proof submission         | `currentPhaseProof()`       |
| `B+133` … `B+151` |     19 | claim                    | `currentPhaseClaim()`       |

The reveal phase shortens from 38 blocks to 19, and what used to be a 76-block claim phase is
now four phases. Anything that derived phase boundaries from `ROUND_LENGTH / 4` needs updating.

`currentRoundAnchor()` switches to the _next_ round's anchor from block `B+57` onward, not from
`B+76`: once the chunk sample hash reveal phase closes, this round's anchor is spent.

---

## 2. Three randomness roles, in order

Each role appears only after the commitment that must not know it.

| Role                                           | Created by                                             | Used for                                                               |
| ---------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------- |
| round anchor (`currentRevealRoundAnchor`)      | the previous round                                     | neighbourhood selection, transformed chunk addresses                   |
| stamp anchor (`currentRevealRoundStampAnchor`) | the first valid chunk sample hash reveal of this round | ordering transformed stamp values                                      |
| proof seed (`currentProofSeed`)                | the first valid stamp sample hash reveal of this round | which sample positions to open, which chunk segment each witness opens |

A selection seed is created alongside the proof seed and drives the weighted truth draw.

```
stampAnchor   = keccak256(abi.encodePacked(seed, roundNumber, "STS1_STAMP_ANCHOR"))
proofSeed     = keccak256(abi.encodePacked(stampAnchor, block.prevrandao, roundNumber, "STS1_PROOF_SEED"))
selectionSeed = keccak256(abi.encodePacked(stampAnchor, block.prevrandao, roundNumber, "STS1_SELECTION_SEED"))
```

Both anchors and the proof seed are public reads. `currentRevealRoundStampAnchorSet` and
`currentProofSeedSet` say whether they exist yet for the active round.

---

## 3. What a node submits

### Stage one — `commit` and `reveal`

```solidity
commit(bytes32 obfuscatedHash, uint64 roundNumber, uint8 depth)
reveal(uint8 depth, bytes32 chunkSampleHash, bytes32 chunkTransformRoot, bytes32 revealNonce)
```

The hidden pre-image gains the round number and the chunk transform root:

```solidity
wrapCommit(uint64 commitRound, bytes32 overlay, uint8 depth,
           bytes32 chunkSampleHash, bytes32 chunkTransformRoot, bytes32 revealNonce)
  = keccak256(abi.encodePacked(commitRound, overlay, depth, chunkSampleHash, chunkTransformRoot, revealNonce))
```

The round binding stops a commitment prepared for one round being opened in another.

`chunkTransformRoot` is a Merkle root over the **first-anchor transformed addresses of the
chunks in the node's reserve**. It is participant-specific and is _not_ part of the Schelling
point, which is why every paid node has to prove for itself.

Tree construction, which Bee must match exactly (`MerkleProof.verify`, OpenZeppelin):

- leaves are the 32-byte transformed chunk addresses;
- a parent is `keccak256(abi.encodePacked(sortedPair(left, right)))`, i.e. the two children are
  ordered by numeric value before hashing;
- an odd node at any level is promoted unchanged;
- **leaves are held in ascending numeric order**. The implementation fixes the root in stage one
  and only re-derives stamp indexes later, so the root has to be stable under that re-derivation.
  See `test/util/sts.ts` for a reference implementation.

Nothing verifies that the root covers the _complete_ reserve. The incentive to include
everything comes from not knowing, at stage one, which chunks will be useful.

### Stage two — `commitStampSampleHash` and `revealStampSampleHash`

```solidity
commitStampSampleHash(bytes32 obfuscatedHash, uint64 roundNumber)
revealStampSampleHash(uint64 roundNumber, bytes32 stampSampleHash, bytes32 revealNonce)

wrapStampCommit(uint64 commitRound, bytes32 overlay, bytes32 stampSampleHash, bytes32 revealNonce)
  = keccak256(abi.encodePacked(commitRound, overlay, stampSampleHash, revealNonce))
```

Accepted only from a node that already has a valid stage one reveal in the same round. The
depth, chunk sample hash and chunk transform root are read from that reveal, not recommitted.

The stamp sample is fixed at **16 entries**. Each entry is

```
transformedStampValue = keccak256(abi.encodePacked(stampAnchor, batchId, fullStampIndex))
```

sorted ascending, laid out as sixteen 32-byte segments in one 512-byte chunk.
`stampSampleHash` is that chunk's BMT address, i.e. `keccak256(reverseUint64(512) || bmtRoot)`.

### Proof submission — `submitStsProof`

```solidity
selectedStampPositions(uint64 roundNumber) returns (uint32[3])
submitStsProof(uint64 roundNumber, StampProof[3] proofs)
```

Two positions are drawn from `0..14` without replacement and returned ascending; position 15 is
always opened as the density witness. Proofs must be supplied in that order.

Each `StampProof` carries:

| Field                                                                                               | Meaning                                                                                                |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `proofSegments`, `sampleIndex`                                                                      | inclusion of this entry in `stampSampleHash`                                                           |
| `leftValue`/`leftProofSegments`, `rightValue`/`rightProofSegments`, `hasLeftValue`, `hasRightValue` | the immediate neighbours, for the local ordering check                                                 |
| `postageId`, `index`, `timeStamp`, `signature`                                                      | the stamp itself; `index` is the full `uint64` `(bucket << 32) \| withinBucketIndex`                   |
| `chunkAddress`                                                                                      | the chunk the batch owner signed for                                                                   |
| `chunkProof`                                                                                        | one opened segment of that chunk, proved under both the plain BMT and the first-anchor transformed BMT |
| `chunkTransformProofSegments`                                                                       | membership of the transformed address in `chunkTransformRoot`                                          |

The opened segment index is not the node's choice:

```
segmentIndex = uint256(keccak256(abi.encodePacked(proofSeed, chunkAddress, bytes32("STS1_CHUNK_SEGMENT")))) % 128
```

`chunkProof.proofSegments2[0]` and `proofSegments3[0]` must be equal — at level zero both trees
merge raw data, so the first sister segment is the same in both.

For a SOC, `chunkProof.socProof` carries the attestation, `chunkProof.proveSegment` is the SOC
address, and the leaf offered to `chunkTransformRoot` is
`keccak256(abi.encode(socAddress, transformedAddress))`.

---

## 4. Weighting and payout

```
baseStakeDensity = stake * 2^(depth - height)
effectiveStakeDensity = baseStakeDensity * stampDensityCoefficient * utilizationCoefficient
```

Both coefficients are Q64.64 cube roots, **each capped at 2×**:

```
stampDensityCoefficient = min(2, cbrt(stampSampleMaxValue / largestProvenStampValue))
utilizationCoefficient  = min(2, max(1, cbrt(1 / (2 * averageIndexRatio))))
averageIndexRatio       = mean over the three witnesses of (withinBucketIndex + 1) / slotsPerBucket
```

`stampSampleMaxValue` is a single admin-settable constant and takes **no depth argument** — see
scrutiny 2.1 for why a depth-scaled ceiling would make depth overreporting free.

Truth selection is a stake-weighted running draw over proof-validated entries only. The drawn
entry's `(chunkSampleHash, stampSampleHash, depth)` becomes the Schelling point.

`claim()` takes no arguments — the witnesses were already verified in the proof phase. It:

1. withdraws the pot from `PostageStamp` **into the Redistribution contract**;
2. splits it across every proof-validated entry matching the Schelling point, in proportion to
   `effectiveStakeDensity`, with the rounding remainder going to the highest-weight entry;
3. freezes proof-validated entries that reported something else;
4. adjusts the oracle price.

Beneficiaries draw down with:

```solidity
withdrawRedistributionPayout(address receiver)
```

This is callable while the contract is paused, so a pause cannot strand earned funds.

Freezing of unfinished participants is unchanged in shape from SWIP-51 Option B, but a stage one
commit now counts as unfinished until it is **proof-validated**: a node that revealed and never
proved is frozen exactly like a no-show.

---

## 5. Fixed postage scope (SWIP-049)

Every stamp in a round is judged against the state as of that round's sampling-start block:

```
samplingStartBlock(r) = (r - 1) * 152 + 38
```

which is the first reveal block of the preceding round. `Redistribution.samplingStartBlock` is a
public pure function; Bee must use the same value.

`PostageStamp` exposes two reads:

```solidity
redistributionMinimumNormalisedBalance(uint256 samplingStartBlock) returns (uint256)
redistributionBatchAt(bytes32 batchId, uint256 samplingStartBlock)
  returns (address owner, uint8 depthAtSamplingStart, uint8 bucketDepth, uint256 normalisedBalance)
```

A stamp is usable by round `r` only if:

1. the batch existed before `samplingStartBlock(r)` — `redistributionBatchAt` reverts otherwise;
2. it is still live at proof time;
3. its normalised balance is at least `redistributionMinimumNormalisedBalance(samplingStartBlock(r))`,
   which is `456` blocks at the price in force when sampling began;
4. the within-bucket index fits `depthAtSamplingStart`, not the live depth.

Consequences for node operators:

- a batch bought after sampling started is usable for uploads immediately, but not by the open round;
- a dilution mid-round creates real new indexes that the open round will still reject;
- a batch cannot be topped up once its remaining balance falls below `minimumValidityBlocks * price`
  — see scrutiny 1.2, this is a hard cliff and currently 24 hours, not six rounds;
- a batch id is consumed permanently, so an expired id can never be recreated.

`batchDepthHistory(batchId)` exposes the retained depth history so a client can check its own
reconstruction against the contract rather than inferring it from events.

---

## 6. Removed

- `claim(ChunkInclusionProof, ChunkInclusionProof, ChunkInclusionProof)` — replaced by
  `submitStsProof` plus a no-argument `claim()`.
- `isWinner(bytes32)` — replaced by `matchesSelectedTruth(bytes32)`; there is no single winner.
- `winner` and the `WinnerSelected` event — payouts are reported per beneficiary with
  `PayoutAccrued`, and the round's truth with `StsTruthSelected`.
- `setSampleMaxValue` — replaced by `setStampSampleMaxValue`. STS-1 does not verify chunk sample
  density at all.
- `Redistribution` now takes a fourth constructor argument, the BZZ token, and links the deployed
  `StsWitness` library.
