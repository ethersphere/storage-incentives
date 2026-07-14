# Bounded Admission: Proximity vs Stake-Weighted

This document compares two designs for **bounded online commit admission** under an otherwise identical mitigation package. The goal is to isolate the admission-ranking decision from staged finalization, eligibility rules, and gas-bounding work that both options share.

For the full threat model, see [SPAM_GRIEFING.md](./SPAM_GRIEFING.md). For depth-floor policy, see [MINIMUM_DEPTH_OPTIONS.md](./MINIMUM_DEPTH_OPTIONS.md).

## Scope

Both options assume the same fixed package:

```
bounded online admission (K slots)     ← only difference between options
        +
objective participation finalization
        +
proof validation before subjective penalties, oracle update, and payout
        +
shared eligibility rules
```

Neither option alone solves fabricated-truth liveness. That still requires objective reveal validation or an audited timeout/fallback (see [SPAM_GRIEFING.md](./SPAM_GRIEFING.md#eligibility-rules-supporting-layer), rule 6).

---

## Shared proposed baseline (held constant)

These components are assumed in both designs. The mitigation package as a whole, including bounded admission and staged finalization, is not implemented in the current contracts.

### Staged finalization

| Step | Purpose |
|------|---------|
| `finalizeParticipation(round)` | Freeze selected non-revealers; store tentative truth/winner; close participation |
| `verifyWinner(round, proofs)` | Validate storage proofs; mark truth validated |
| `settleRound(round)` | Apply disagreement penalties and oracle update; withdraw pot and mark settled only on success |

Fixes that apply equally to both admission options:

- Penalty rollback on proof failure (Gap 1)
- Zero-reveal rounds with no penalty path (Gap 2)
- Payout failure no longer treated as successful settlement (Gap 5)
- Bounded finalization loops at K participants

### Eligibility at commit

From [SPAM_GRIEFING.md](./SPAM_GRIEFING.md#eligibility-rules-supporting-layer):

```solidity
commit(bytes32 _obfuscatedHash, uint64 _roundNumber, uint8 _depth)

require(height <= MAX_STAKE_HEIGHT)
require(_depth <= MAX_REPORTED_DEPTH)
require(_depth > height)
depthResponsibility = _depth - height
require(inProximity(overlay, currentRoundAnchor(), depthResponsibility))
require(_depth >= currentFloor())
```

Additional shared rules:

- `declaredDepth` stored in `Commit`; reveal must match
- Two-round staking wait before commit (`MustStake2Rounds`)
- `MIN_STAKE * 2^height` revalidated on every `manageStake`, including `_addAmount == 0`
- Stake/overlay/height frozen for selected participants during the obligation window
- Fixed-capacity or generation-tagged round state; no attacker-sized bulk `delete`

### Hard cap K

- `MAX_COMMITS = K`; K remains unset until Gnosis fork benchmarks cover every staged call
- Illustrative current-contract claim-side estimate (from [SPAM_GRIEFING.md](./SPAM_GRIEFING.md#gas-model-how-many-nodes-to-block-claim)): ~25k gas marginal per additional commit at the full-freeze path
- Applying that unverified estimate gives K = 128 at roughly 3.6M gas and K = 512 at roughly 13.2M gas, including the ~450k baseline. These are not staged-design benchmarks or safe K recommendations.

### Online admission shape (shared)

- At most K selected commits throughout the commit phase
- When full, a new eligible commit evicts the current worst only if the newcomer ranks better
- Per-commit work is O(K) or O(log K), never O(unbounded N)
- Emit admission/eviction events; expose whether an overlay is selected for reveal
- Snapshot owner, overlay, height, effective stake, declared depth at commit

**The only design fork:** what metric ranks selected commits and who gets evicted when full.

---

## Option A: Proximity-ranked admission

### Ranking rule

Among commits that pass eligibility, keep the K with the **smallest XOR distance** to the round anchor:

```text
distance(overlay, anchor) = uint256(overlay XOR anchor)
```

When saturated, evict the selected commit with the **largest** distance.

Proximity is both an eligibility filter (`inProximity` at declared responsibility) and the ranking metric among eligible commits.

### Typical implementation

- Fixed array of K `Commit` records plus occupancy count
- On commit when `count == K`: scan K entries, find max distance, replace if newcomer is closer
- Store `distance` or recompute from snapshotted anchor at commit time
- O(K) per saturated commit; simple, auditable

### Intended properties

- Favors nodes geographically (in XOR sense) responsible for the anchor neighborhood
- Aligns admission with the protocol’s proximity semantics
- Honest operators with good overlay placement relative to anchor are naturally competitive

### Known limitations

| Issue | Detail |
|-------|--------|
| Stake-blind eviction | K min-stake sybils closer to anchor beat one high-stake honest node that is merely “good enough” but outside top-K by distance |
| Pre-matured wallet bank still works | Each `manageStake` resets the two-round wait, preventing same-round on-chain overlay iteration but not advance preparation. See [Overlay preparation model](#overlay-preparation-model) |
| Wallet-bank selection | Attacker pre-matures many wallets with off-chain nonce search, then commits from the subset with best fixed overlays for this round’s anchor |
| Late-commit eviction | A sybil with a closer pre-matured wallet can evict an honest commit later in the phase without changing any overlay on-chain |
| Declared-depth binding | Raw XOR ranking is independent of depth, but `declaredDepth` must be stored so commit eligibility cannot be obtained with one depth and reveal attempted with another |
| Advance preparation | An overlay must mature before commit. Once the round anchor is known, an attacker can choose the best eligible overlays from a pre-matured bank but cannot retune those overlays |
| Anchor predictability | If a future anchor is predictable before the two-round maturity window starts, an attacker can grind overlays directly for that anchor |

---

## Option B: Stake-weighted admission (doc default)

### Ranking rule

Among eligible commits, rank by audited stake-weighted priority:

```text
weight = objectivelyLockedEffectiveStake(owner)   // snapshotted at commit
entropy = H(domain, round, fixedRoundSeed, overlay)
priority = auditedWeightedPriority(entropy, weight) // larger is better
```

When saturated, evict the selected commit with the **lowest** priority. Keep the best K.

Proximity and declared depth are **eligibility only**, not eviction weight.

### Typical implementation

- Fixed-capacity min-heap or equivalent structure
- O(log K) insert/evict per saturated commit
- Requires specified integer algorithm, overflow bounds, and capital-splitting analysis

### Intended properties

- Expected admission probability scales with locked weight under a correctly specified weighted-sampling algorithm
- Reduces reliance on XOR position alone
- Entropy from `(domain, round, seed, overlay)` limits tx-order and user-grindable field advantage
- Mature identities can evaluate ticket strength before committing, but cannot grind obfuscated hash or reveal nonce

### Known limitations

| Issue | Detail |
|-------|--------|
| No inclusion guarantee | A coalition can occupy all K slots; greater total weight raises its probability but does not make the outcome deterministic |
| Capital splitting | Splitting weight creates more independently grindable overlay tickets. Its exact effect depends on the priority algorithm and must be quantified |
| Seed timing | If the priority seed is predictable before an overlay begins its two-round maturity period, an attacker can grind an overlay directly for that round instead of relying only on a pre-matured bank |
| More design surface | Exact `auditedWeightedPriority` must be specified and proven |
| Slightly higher implementation cost | Heap + weight snapshots vs linear distance scan |
| Same overlay constraints | Two-round wait and fixed overlay apply equally; weight does not remove wallet-bank attacks, only changes who wins eviction |

---

## Overlay preparation model

Both options operate on **fixed overlays** set at `manageStake` time. This is a shared constraint from `Staking.sol` and `Redistribution.sol`.

| Action | Effect |
|--------|--------|
| `manageStake(nonce, amount, height)` | Sets overlay from `keccak256(sender, reverse(networkId), nonce)`; updates `lastUpdatedBlockNumber` |
| `commit()` | Requires `lastUpdatedBlockNumber < block.number - 2 * ROUND_LENGTH` |
| On-chain nonce iteration | Repeated calls are possible, but only the final overlay can mature; each candidate intended for commit must remain unchanged for two full rounds (~304 blocks) |

**Off-chain nonce search** before `manageStake` is cheap. If future round inputs are not known two rounds ahead, the attacker must mature a bank of fixed overlays and choose the best ones later. If an anchor or priority seed is predictable before the maturity window starts, the attacker can grind overlays directly for that known value.

Difference at commit time:

| | Proximity (A) | Stake-weighted (B) |
|---|---------------|-------------------|
| Sybil prepares | Mature many fixed overlays, then choose those closest to the live anchor | Mature many fixed overlays, then choose favorable tickets after the fixed seed is known |
| At commit | Send from wallets with smallest `overlay XOR anchor` | Send from wallets with highest `priority` given snapshotted stake |
| Capital efficiency | K min-stake wallets can fill slots if their overlays rank closely enough | Higher weight improves ticket distribution, but a low-weight candidate can still win with favorable entropy |

The two-round wait is a meaningful brake on **reactive** grinding. It does **not** require “forever” to attack, but it does force **advance preparation** rather than per-round overlay tuning.

---

## Side-by-side comparison

| Criterion | A: Proximity-ranked | B: Stake-weighted |
|-----------|---------------------|-------------------|
| **Primary eviction metric** | `overlay XOR anchor` (ascending) | `priority(entropy, stake)` (descending) |
| **Proximity role** | Filter + rank | Filter only |
| **Stake role** | Minimum-stake eligibility + penalties / truth lottery | Minimum-stake eligibility + admission rank + penalties / truth lottery |
| **Sybil slot-fill strategy** | Bank of close overlays | Bank of independently scored weighted tickets |
| **Censorship resistance** | Weak against a sufficiently large bank of close eligible overlays | Depends on honest/attacker weight and ticket grinding; not established until the algorithm is specified |
| **Honest single-operator odds** | Selected iff its overlay is among the K closest eligible candidates | Probabilistic; depends on its weight and all eligible candidates' tickets |
| **Implementation complexity** | Lower: O(K) scan, distance uint256 | Higher: heap, weighted algorithm spec |
| **Per saturated commit gas** | ~O(K) distance compares | ~O(log K) heap ops + weight reads |
| **Grinding surface** | Off-chain nonce → overlay position | Off-chain nonce → entropy ticket; stake splitting |
| **Late-phase eviction** | Closer pre-matured wallet evicts | Higher-priority pre-matured wallet evicts |
| **Staged finalization** | Same | Same |
| **Penalty persistence** | Same | Same |
| **Fabricated truth liveness** | Unchanged; needs rule 6 | Unchanged; needs rule 6 |

---

## Attack coverage (same baseline)

How each option behaves against the four attacks in [SPAM_GRIEFING.md](./SPAM_GRIEFING.md#attack-scenarios) when staged finalization and eligibility rules are in place.

| Attack | Shared baseline fix | A: Proximity extra | B: Stake-weighted extra |
|--------|---------------------|--------------------|-------------------------|
| **1. Zero-reveal lock** | `finalizeParticipation` freezes K non-revealers; pot carries forward | Same | Same |
| **2. Claim gas grief** | Loops bounded at K | Same | Same |
| **3. Truth poisoning / penalty rollback** | Non-reveal freezes persist before proofs; disagreement after validation | Same | Same |
| **4. Commit-only spam** | K cap + persisted non-reveal freezes | Same | Same |
| **Slot filling / exclusion** | Not FCFS; online eviction | Favors closest overlays; a min-stake bank can dominate | Favors the highest realized weighted priorities; higher stake improves odds but is not required for a lucky eviction |
| **Wallet-bank economics** | 2-round prep, off-chain nonce search | Cost at least bank size × minimum stake; pick best K distances | Cost at least bank size × minimum stake; selection also depends on total weight and realized tickets |
| **Repeat attack after freeze** | Freeze is time-lock, not slash (Gap 3) | Same | Same |

---

## Worked intuition

### Scenario 1: One honest operator vs 200 min-stake sybils

- Honest: high effective stake, overlay moderately close to anchor
- Sybils: 200 pre-matured wallets, overlays scattered; 150 pass eligibility

**A (proximity):** If 128 sybils are closer than honest, honest is excluded regardless of stake.

**B (stake-weighted):** Higher honest stake improves the distribution of its priority, but does not guarantee selection. It may evict a low-weight sybil regardless of relative proximity.

### Scenario 2: Coalition with 128 selected min-stake wallets

- All 128 pass eligibility and sit in top-K by distance

**A:** Coalition holds all slots for the round.

**B:** The coalition holds all slots only if its realized priorities occupy the top K. A higher-stake honest commit is more likely, but not guaranteed, to displace the weakest coalition member.

### Scenario 3: Unpredictable round inputs become known after sybil stake maturation

- Assume the live admission anchor and weighted-priority seed were not predictable when the sybil overlays began maturing

**A:** The attacker cannot retune overlays, but can select the closest overlays from its matured bank after the anchor is known.

**B:** The attacker cannot retune overlays, but can select favorable tickets from its matured bank after the fixed priority seed is known. The anchor controls eligibility; the priority seed controls ticket rank. If one value is used for both, a change affects both.

---

## Implementation notes

### Distance metric (Option A only)

Use a single consistent definition at commit time:

```text
distance = uint256(overlay XOR currentRoundAnchor())
```

Eligibility already enforces `distance < 2^(256 - depthResponsibility)`. Among eligible commits, smaller distance is strictly better for retention.

Distinct overlays cannot have equal XOR distance to the same anchor because XOR with a fixed anchor is one-to-one. Duplicate-overlay rejection therefore removes the distance tie case.

### Priority metric (Option B only)

Must be fully specified before implementation:

- Exact `objectivelyLockedEffectiveStake` snapshot (include height? oracle price at commit block?)
- Integer `auditedWeightedPriority` with overflow proofs
- Behavior under capital splitting across sybil wallets
- Tie-break rule

See [SPAM_GRIEFING.md](./SPAM_GRIEFING.md#bounded-online-selection) for entropy field constraints.

### Shared commit flow

```text
1. Validate phase, round, stake maturity, obligation-window freeze
2. Validate eligibility (depth, floor, proximity, height)
3. If overlay already selected → reject
4. If count < K → insert
5. If count == K → compute rank; if newcomer beats worst → evict worst and insert newcomer; otherwise reject
6. Emit `Selected`/`Evicted`. A rejected transaction may either revert or return normally and emit `Rejected`; a revert cannot preserve an event.
```

---

## Gas and K selection

Both options should use the same K after benchmarks set it. Differences are in **commit-phase** cost, not finalization cost; finalization loops over at most K selected records.

| | A: Proximity | B: Stake-weighted |
|---|--------------|-------------------|
| Unsaturated commit | O(1) bounded membership lookup plus insertion, or O(K) scan in a simpler design | O(1) bounded membership lookup plus O(log K) heap insertion |
| Saturated commit | O(K) distance comparisons + one eviction write | O(log K) heap replacement; weight snapshot cost is additional |
| Claim / finalize | O(K) | O(K) |

Which option is cheaper depends on storage layout, membership tracking, snapshot reads, and K. Measure both on a Gnosis fork; the current estimates do not establish a crossover point.

---

## Recommendation matrix

| Priority | Prefer |
|----------|--------|
| Simplest auditable contract | **A: Proximity** |
| Make admission probability depend on stake | **B: Stake-weighted** |
| Align admission with XOR neighborhood responsibility | **A: Proximity** |
| Align admission with economic weight of the Schelling game | **B: Stake-weighted** |
| Minimize new algorithm surface before audit | **A: Proximity** |
| Reduce dependence on overlay proximity alone | **B: Stake-weighted** |

**Neither option removes the wallet-bank pattern.** Both require advance sybil preparation (off-chain nonce search + two-round maturation). Option A ranks deterministically by geometry. Option B ranks by a probabilistic function of entropy and stake whose security properties cannot be claimed until the exact algorithm is specified.

A hybrid is possible but increases complexity: e.g. primary rank by priority, tie-break by distance, or eligibility buckets per proximity band. Any hybrid needs its own row in this comparison before implementation.

---

## Open design questions

1. **K value** from staged-finalization benchmarks on Gnosis (both options)
2. **Tie-break rule** for equal priority (B); distinct eligible overlays cannot tie on raw XOR distance (A)
3. **Whether proximity distance** should be normalized by `depthResponsibility` or raw XOR suffices given eligibility already enforces responsibility
4. **Caller incentive** for `finalizeParticipation` on zero-reveal rounds (shared)
5. **Objective reveal validity** for fabricated-truth liveness (shared, rule 6)
6. **Hybrid admission** — worth the complexity or pick one ranking rule

---

## Related docs

- [SPAM_GRIEFING.md](./SPAM_GRIEFING.md) — threat model, staged finalization, default stake-weighted admission
- [MINIMUM_DEPTH_OPTIONS.md](./MINIMUM_DEPTH_OPTIONS.md) — depth floor and eligibility pairing
- [REDISTRIBUTION.md](./REDISTRIBUTION.md) — game phases and proximity semantics
- [STAKING.md](./STAKING.md) — overlay derivation, two-round wait, `manageStake`

## Status

Design comparison only. Not implemented. Intended to support a decision between Option A and Option B before coding bounded admission.
