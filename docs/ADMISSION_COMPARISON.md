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

## Shared baseline (held constant)

These components are identical in both designs.

### Staged finalization

| Step | Purpose |
|------|---------|
| `finalizeParticipation(round)` | Freeze selected non-revealers; store tentative truth/winner; close participation |
| `verifyWinner(round, proofs)` | Validate storage proofs; mark truth validated |
| `settleRound(round)` | Apply disagreement penalties, oracle update, withdraw pot |

Fixes that apply equally to both admission options:

- Penalty rollback on proof failure (Gap 1)
- Zero-reveal rounds with no penalty path (Gap 2)
- `WithdrawFailed` treated as success (Gap 5)
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

- `MAX_COMMITS = K` chosen from Gnosis fork benchmarks
- Illustrative claim-side scaling (from [SPAM_GRIEFING.md](./SPAM_GRIEFING.md#gas-model-how-many-nodes-to-block-claim)): ~25k gas marginal per selected commit in `winnerSelection()` at full freeze path
- K ≈ 128 → ~3–4M gas for loop + freezes + ~450k proof baseline; K ≈ 512 approaches Gnosis tx cap cliff

### Online admission shape (shared)

- At most K selected commits throughout the commit phase
- When full, a new eligible commit evicts one existing selected commit
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

Proximity is both an eligibility filter (`inProximity` at declared responsibility) and the eviction tie-breaker among eligible commits.

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
| No reactive overlay grinding | Each `manageStake` resets the two-round wait. Attackers cannot iterate nonces on-chain per round. See [Overlay preparation model](#overlay-preparation-model) |
| Wallet-bank selection | Attacker pre-matures many wallets with off-chain nonce search, then commits from the subset with best fixed overlays for this round’s anchor |
| Late-commit eviction | A sybil with a closer pre-matured wallet can evict an honest commit later in the phase without changing any overlay on-chain |
| Cross-depth comparison | Requires `declaredDepth` at commit so distance comparisons use a consistent anchor and eligibility context |
| Anchor forecast error | Overlay is fixed ~2+ rounds before commit; attacker cannot perfectly target the live anchor, but a large bank improves hit rate |

---

## Option B: Stake-weighted admission (doc default)

### Ranking rule

Among eligible commits, rank by audited stake-weighted priority:

```text
weight = objectivelyLockedEffectiveStake(owner)   // snapshotted at commit
entropy = H(domain, round, fixedRoundSeed, overlay)
priority = auditedWeightedPriority(entropy, weight)
```

When saturated, evict the selected commit with the **lowest** priority. Keep the best K.

Proximity and declared depth are **eligibility only**, not eviction weight.

### Typical implementation

- Fixed-capacity min-heap or equivalent structure
- O(log K) insert/evict per saturated commit
- Requires specified integer algorithm, overflow bounds, and capital-splitting analysis

### Intended properties

- Exclusion cost scales with locked stake, not only XOR luck
- Reduces pure geometry censorship by min-stake farms
- Entropy from `(domain, round, seed, overlay)` limits tx-order and user-grindable field advantage
- Mature identities can evaluate ticket strength before committing, but cannot grind obfuscated hash or reveal nonce

### Known limitations

| Issue | Detail |
|-------|--------|
| No inclusion guarantee | High-weight coalition can still occupy all K slots |
| Capital splitting | Many min-stake wallets may still approximate weight concentration unless algorithm is audited for split resistance |
| More design surface | Exact `auditedWeightedPriority` must be specified and proven |
| Slightly higher implementation cost | Heap + weight snapshots vs linear distance scan |
| Same overlay constraints | Two-round wait and fixed overlay apply equally; weight does not remove wallet-bank attacks, only changes who wins eviction |

---

## Overlay preparation model

Both options operate on **fixed overlays** set at `manageStake` time. This is a shared constraint from `Staking.sol` and `Redistribution.sol`.

| Action | Effect |
|--------|--------|
| `manageStake(nonce, amount, height)` | Sets overlay from `keccak256(sender, networkId, nonce)`; updates `lastUpdatedBlockNumber` |
| `commit()` | Requires `lastUpdatedBlockNumber < block.number - 2 * ROUND_LENGTH` |
| On-chain nonce iteration | Impractical: each attempt costs two full rounds (~304 blocks) before commit |

**Off-chain nonce search** before the one-time `manageStake` is cheap. **Wallet banks** (many addresses, parallel two-round maturation) are the realistic sybil shape for both options.

Difference at commit time:

| | Proximity (A) | Stake-weighted (B) |
|---|---------------|-------------------|
| Sybil prepares | Many wallets; off-chain pick nonces for expected anchor proximity | Many wallets; off-chain pick nonces for entropy ticket + stake layout |
| At commit | Send from wallets with smallest `overlay XOR anchor` | Send from wallets with highest `priority` given snapshotted stake |
| Capital efficiency | K min-stake wallets can fill slots if close enough | Need comparable or higher **weight** to evict, not just proximity |

The two-round wait is a meaningful brake on **reactive** grinding. It does **not** require “forever” to attack, but it does force **advance preparation** rather than per-round overlay tuning.

---

## Side-by-side comparison

| Criterion | A: Proximity-ranked | B: Stake-weighted |
|-----------|---------------------|-------------------|
| **Primary eviction metric** | `overlay XOR anchor` (ascending) | `priority(entropy, stake)` (descending) |
| **Proximity role** | Filter + rank | Filter only |
| **Stake role** | Penalties / truth lottery only | Filter + rank + penalties / truth lottery |
| **Sybil slot-fill strategy** | Bank of close overlays | Bank of high-weight or favorable tickets |
| **Censorship resistance** | Weak vs capital-light close overlays | Stronger vs min-stake farms; weak vs high-stake coalition |
| **Honest single-operator odds** | Good if overlay is among K closest | Good if effective stake is among top K priorities |
| **Implementation complexity** | Lower: O(K) scan, distance uint256 | Higher: heap, weighted algorithm spec |
| **Per saturated commit gas** | ~O(K) distance compares | ~O(log K) heap ops + weight reads |
| **Protocol semantics fit** | Strong XOR/neighborhood story | Strong economic-game story |
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
| **Slot filling / exclusion** | Not FCFS; online eviction | Favors closest overlays; min-stake bank can dominate | Favors highest weight/ticket; needs stake to evict |
| **Wallet-bank economics** | 2-round prep, off-chain nonce search | Cost ≈ bank size × min stake; pick best K distances | Cost ≈ bank size × min stake; need weight advantage to hold slots |
| **Repeat attack after freeze** | Freeze is time-lock, not slash (Gap 3) | Same | Same |

---

## Worked intuition

### Scenario 1: One honest operator vs 200 min-stake sybils

- Honest: high effective stake, overlay moderately close to anchor
- Sybils: 200 pre-matured wallets, overlays scattered; 150 pass eligibility

**A (proximity):** If 128 sybils are closer than honest, honest is excluded regardless of stake.

**B (stake-weighted):** Honest high stake yields high priority; may evict low-weight sybils even if they are slightly closer.

### Scenario 2: Coalition with 128 min-stake wallets, overlays pre-ground for expected anchor

- All 128 pass eligibility and sit in top-K by distance

**A:** Coalition holds all slots for the round.

**B:** Only holds all slots if their snapshotted weights and entropy tickets beat every other eligible commit. A single higher-stake honest commit can displace the weakest coalition member.

### Scenario 3: Anchor shifts after sybil stake maturation

- Sybils staked 2 rounds ago targeting a forecast anchor; actual `currentRoundAnchor()` differs

**A:** Bank hit rate drops; honest nodes with stable real overlays may gain relative advantage.

**B:** Same anchor uncertainty applies to ticket evaluation; weight ranking unchanged by anchor shift except through eligibility filter.

---

## Implementation notes

### Distance metric (Option A only)

Use a single consistent definition at commit time:

```text
distance = uint256(overlay XOR currentRoundAnchor())
```

Eligibility already enforces `distance < 2^(256 - depthResponsibility)`. Among eligible commits, smaller distance is strictly better for retention.

Tie-break when distances are equal (required for determinism): e.g. lower overlay bytes, or earlier commit snapshot index in fixed array — specify one rule.

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
3. If overlay already selected → revert
4. If count < K → insert
5. If count == K → compute rank; if newcomer beats worst → evict worst, insert newcomer; else revert
6. Emit Selected or Rejected
```

---

## Gas and K selection

Both options target the same K from benchmarks. Differences are in **commit-phase** cost, not claim-phase (claim always loops K selected records).

| | A: Proximity | B: Stake-weighted |
|---|--------------|-------------------|
| Unsaturated commit | O(unique check) + O(K) overlay scan for duplicates | O(unique check) + structure lookup |
| Saturated commit | O(K) distance compares + one eviction write | O(log K) heap + weight snapshot reads |
| Claim / finalize | O(K) | O(K) |

Proximity may be marginally cheaper at commit time; stake-weighted may be cheaper when K is large (512+) if heap beats linear scan. Measure both on a Gnosis fork.

---

## Recommendation matrix

| Priority | Prefer |
|----------|--------|
| Simplest auditable contract | **A: Proximity** |
| Strongest censorship resistance per unit stake | **B: Stake-weighted** |
| Align admission with XOR neighborhood responsibility | **A: Proximity** |
| Align admission with economic weight of the Schelling game | **B: Stake-weighted** |
| Minimize new algorithm surface before audit | **A: Proximity** |
| Defend against min-stake wallet banks | **B: Stake-weighted** |

**Neither option removes the wallet-bank pattern.** Both require advance sybil preparation (off-chain nonce search + two-round maturation). The choice is whether slot competition is won by **geometry** or **stake**.

A hybrid is possible but increases complexity: e.g. primary rank by priority, tie-break by distance, or eligibility buckets per proximity band. Any hybrid needs its own row in this comparison before implementation.

---

## Open design questions

1. **K value** from staged-finalization benchmarks on Gnosis (both options)
2. **Tie-break rules** for equal distance (A) or equal priority (B)
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
