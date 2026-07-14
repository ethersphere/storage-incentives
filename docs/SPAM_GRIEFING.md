# Redistribution — Spam and Griefing Threat Model

This document describes how sybil spam and griefing attacks work against `Redistribution.sol`, what they can achieve, order-of-magnitude estimates for how many nodes are needed to block `claim()`, and the proposed mitigation package.

For depth-floor policy details, see [MINIMUM_DEPTH_OPTIONS.md](./MINIMUM_DEPTH_OPTIONS.md).

## Summary

The main griefing vector is a **sybil farm**: many staked addresses, each with one commit per round, inflating `currentCommits` so `claim()` does linear work in `getCurrentTruth()` and `winnerSelection()`.

There is **no hard cap** on `currentCommits.length`. Claim work scales as O(N) over commits; commit-phase attacker work scales as O(N²) across the round. Arrays reset each round, so griefing is per-round, not cumulative forever.

Depth floors and proximity are **economic filters**, not deterministic liveness guarantees. The proposed fix combines **eligibility tightening** with **bounded admission or batched finalization**.

---

## What an attacker can do

The practical attack is a **sybil farm**: many staked addresses, each participating once per round.

### Hard limits per identity

- **One commit per overlay per round** — `commit()` scans `currentCommits` and reverts with `AlreadyCommitted()` if that overlay already exists.
- **One reveal per commit** — `AlreadyRevealed()` prevents double reveal.

Scale is bounded by **number of sybil stakers**, not unlimited transactions from one wallet.

### Entry requirements (each sybil)

1. **Minimum stake** — `MIN_STAKE * 2^height` on first deposit in `Staking.sol` (`MIN_STAKE = 1e17` at height 0).
2. **Two-round wait** — `MustStake2Rounds` before the first commit.
3. **Gas** — one commit tx and optionally one reveal tx per round.
4. **Stake updates reset the wait** — any `manageStake()` call updates `lastUpdatedBlockNumber`, restarting the two-round eligibility clock.

### Commit vs reveal asymmetry

- `commit()` does **not** check proximity — any staked node can enter `currentCommits`.
- `reveal()` checks proximity via `inProximity()`.

If `_depth == height`, then `depthResponsibility = 0` and proximity **always passes** (`inProximity(..., 0)` is true for every overlay). That is the cheapest valid reveal path (lowest `stakeDensity`, easiest proximity).

An existing staker can also call `manageStake(nonce, 0, newHeight)` without adding tokens. Minimum stake is enforced only on first deposit, so a mature minimum-funded stake can later set `height` to match a declared floor and keep `depth == height`.

### Who can call `claim()`

`claim()` has **no `msg.sender` check**. Any party that supplies valid proofs can submit the transaction and pay gas; the pot is withdrawn to `winner.owner`, not the caller. Relayers or griefers can therefore attempt claims on behalf of the network.

---

## Where array growth hurts

Several paths loop over **`currentCommits.length`**:

| Phase  | Function            | Cost per operation      |
|--------|---------------------|-------------------------|
| Commit | overlay uniqueness  | O(n) per new commit     |
| Reveal | `findCommit()`      | O(n) per reveal         |
| Claim  | `getCurrentTruth()` | O(n) over all commits   |
| Claim  | `winnerSelection()` | O(n) again              |
| View   | `isWinner()`        | O(n) again              |

A farm of **N** sybil nodes increases claim work linearly in **N**. Per-iteration cost is not uniform: commit-only sybils are cheap in `getCurrentTruth()` but expensive in `winnerSelection()` because of `freezeDeposit()` external calls.

Arrays reset each round (`delete currentCommits` at the start of a new commit phase). Griefing is **per-round**, not cumulative forever.

---

## Attack scenarios

### 1. Zero-reveal round lock (cheapest path)

**Attack:** Many sybil commits, **no reveals**.

**Effect:** `claim()` reverts `NoReveals()` before `getCurrentTruth()` or the penalty loop, because `currentRevealRound` is only set on the first successful reveal. No `freezeDeposit()` runs; no oracle adjustment; no loop bloat at claim time.

**What breaks:** The round cannot be claimed. The pot **continues to accrue** in PostageStamp. After the claim phase ends or the next round begins, that round is **permanently unclaimable** — its arrays are deleted on rollover and cannot shrink mid-round.

**Cost to attacker:** Commit gas only (O(N²) across the round). No stake freeze.

### 2. Claim-phase gas griefing

**Attack:** N sybil commits plus **≥1 reveal** (honest or dishonest).

**Effect:** `claim()` runs `winnerSelection()` over all N commits. If gas exceeds the transaction or block limit, the entire transaction **reverts atomically**. `currentClaimRound` is not updated; all `freezeDeposit()` calls in that tx are rolled back.

**Who pays:** Whoever calls `claim()` and supplies proofs.

**What breaks:** The round does not finalize while N stays high. Every retry in the same claim phase repeats the same O(N) work. If no successful claim occurs before rollover, the round becomes unclaimable; the accumulated pot remains for a later successful withdrawal.

**Important:** Penalties apply only when a `claim()` transaction **fully succeeds**. A grief that blocks every claim is **penalty-free** for the attacker.

### 3. Truth poisoning / proof deadlock

**Attack:** Sybil reveals with a fabricated `(hash, depth)` and enough aggregate `stakeDensity` to be selected as truth.

**Effect:** Truth selection is a **stake-density-weighted lottery over individual reveals**, not a majority vote or correctness check. Any revealed tuple can become truth with probability proportional to its `stakeDensity`. Commit order also influences the draw because randomness is keyed on commit array index `i`.

If a fabricated hash is selected:

- Only reveals matching that exact `(hash, depth)` enter winner selection.
- Honest nodes cannot supply valid chunk proofs for the selected hash.
- `claim()` reverts during proof verification; penalties and `currentClaimRound` roll back with the tx.

A single malicious reveal in a round becomes truth **deterministically**. This is a liveness attack independent of exceeding gas limits.

### 4. Commit-only spam with ≥1 reveal (gas-model variant)

**Attack:** Many commits, one honest or sybil reveal, all other sybils skip reveal.

**Effect:** Bloats the `winnerSelection()` loop. Each non-revealed commit can trigger `freezeDeposit()` **only if the full `claim()` succeeds**. Freeze duration scales as `2 ** truthRevealedDepth`, not the offender's own depth.

With default `penaltyRandomFactor = 100`, disagreeing reveals are also always frozen when claim succeeds.

### 5. Price oracle side effects

`redundancyCount` counts revealers matching the selected exact `(hash, depth)` tuple. Sybils that reveal a different hash do not increase redundancy.

If claims are skipped for multiple rounds, the next successful `adjustPrice()` can apply compounded increases for each skipped round. Griefing that blocks claims can indirectly spike storage price when a claim eventually succeeds.

---

## What does not happen

- One wallet spamming many commits — blocked by `AlreadyCommitted()`
- Unlimited free participation — stake and two-round delay required
- Automatic pot theft via spam alone — `claim()` still requires valid chunk proofs matching the selected winner's hash
- Permanent cross-round array bloat — arrays reset each round
- Automatic stake destruction on freeze — `freezeDeposit()` time-locks participation; stake is not slashed (slash path is commented out)
- Recovery of a griefed round after phase rollover — the old round cannot be claimed later; only the aggregate pot carries forward

---

## Gas model — how many nodes to block `claim()`?

### Illustrative baseline (unverified)

The following figures are **engineering estimates**, not regression-tested benchmarks. No `gasUsed` assertions for sybil scaling exist in `test/Redistribution.test.ts` today. Re-measure on a Gnosis-compatible fork before relying on thresholds.

| Participants | Commits | Reveals | `claim()` gas (illustrative) |
|--------------|---------|---------|------------------------------|
| 1 honest     | 1       | 1       | **~450,000**                 |
| 1 honest + 5 sybil commit-only | 6 | 1 | **~570,000** |

**Marginal cost** per extra commit-only sybil in `winnerSelection()` (loop + `freezeDeposit()`): **~25,000 gas** (order-of-magnitude).

Proof verification (BMT inclusion, stamp, SOC) dominates the baseline (~400k+ gas) but scales weakly with **N**. Loop + freeze work scales **linearly** with commit count.

### Approximate formula

```
G_claim(N) ≈ G_base + (N − 1) × G_sybil
```

Where (illustrative):

- `G_base` ≈ **450k gas** — one honest commit + reveal + full proof path
- `G_sybil` ≈ **25k gas** — each additional commit-only sybil when claim runs (freeze + loop)

Dishonest reveals add similar or slightly higher marginal cost. The zero-reveal variant (scenario 1) incurs **no** claim gas at all.

### Threshold estimates

Solve `G_base + (N − 1) × G_sybil > G_limit`:

| Limit | Typical context | Approx. sybils to exceed |
|-------|-----------------|---------------------------|
| **~3M gas** | Conservative wallet / RPC cap | **~100–110** |
| **~10M gas** | Generous tx cap | **~390–400** |
| **~17M gas** | **Gnosis Chain block limit (production)** | **~660–680** |

Production `mainnet` in this repo deploys to **Gnosis Chain (chainId 100)**, not Ethereum L1. Do not use Ethereum's ~30M block limit for capacity planning here.

Examples (illustrative formula):

- **N = 100** → ~450k + 99×25k ≈ **2.9M gas** (may fail under tight wallet limits)
- **N = 500** → ~450k + 499×25k ≈ **12.9M gas**
- **N = 660** → ~450k + 659×25k ≈ **~17M gas** (Gnosis block-limit cliff)

Re-measure after contract, compiler, or proof-shape changes. Cold/warm storage and calldata size can shift coefficients.

### Commit-phase cost to the attacker

Each sybil commit scans the full commit array: total attacker gas to fill **N** slots is **O(N²)** across the round. That is a partial economic deterrent but does not protect the winner's single `claim()` tx.

---

## Economic cost to spam

Per sybil at `height = 0` (minimum path):

| Item | Cost |
|------|------|
| Minimum stake | `MIN_STAKE` = **1e17** base units = **10 BZZ** (token uses 16 decimals) |
| Time lock | **2 × ROUND_LENGTH** blocks (~304 blocks, ~25 min at 5s/block) before first commit |
| Commit + reveal gas | Paid every round (chain-dependent) |
| Freeze on successful claim | Time-lock via `freezeDeposit()`; stake not destroyed |

**Example:** ~100 sybils for wallet-limit griefing ≈ **1,000 BZZ** minimum locked stake at height 0, plus gas. If every claim is successfully blocked, **no freeze is applied**.

**Example:** ~660 sybils for Gnosis block-limit griefing ≈ **6,600 BZZ** minimum locked stake at height 0, plus O(N²) commit gas and operational burden.

Eligibility rules change **how** sybils must stake and reveal; bounded work is what caps **N** and protects claim liveness.

---

## Proposed mitigation package

The mitigation is a **layered package** that combines commit/reveal eligibility tightening with **deterministic bounded work** and a split between round finalization and proof-based payout.

### Design goals

| Goal | Approach |
|------|----------|
| Limit shallow-reveal spam | Require `depth > height` and a governed/bootstrap depth floor |
| Bind commit-time depth | Store `declaredDepth` in `Commit`; reveal must match |
| Filter by neighborhood | Commit proximity using `inProximity(overlay, anchor, depth - height)` |
| Close height collateral gap | Revalidate `MIN_STAKE * 2^height` on every `manageStake` height change |
| Cap claim-loop work | Hard `MAX_COMMITS` or batched finalization |
| Preserve penalties on grief | Split `finalizeRound()` from `claimReward()` |

### Problem mapping

| Layer | Gap today | Mitigation |
|-------|-----------|------------|
| Unbounded commit array | Any staked node can `commit()` | Commit proximity + positive `depth - height` + stored declared depth |
| Vacuous proximity | `depth == height` ⇒ responsibility 0 | Require `depth > height` at commit and reveal |
| Height bypass | `manageStake(..., 0, newHeight)` without collateral check | Revalidate height-scaled minimum stake on every height change |
| Shallow reveals | `depth == height` always available | Governed or bootstrap `currentFloor()` |
| Claim gas grief | O(N) loops + external freezes in one tx | `MAX_COMMITS` from Gnosis gas benchmarks, or batched finalization |
| Penalties lost on grief | Freezes inside failing `claim()` tx | Persist finalization before proof verification |
| Truth poisoning | Stake-weighted lottery over individual reveals | Bounded N reduces blast radius |
| Round stuck on grief | Single atomic `claim()` | `finalizeRound()` + `claimReward()` with durable per-round state |

### Proposed rules

**1. Extend `commit()` with stored depth**

```solidity
commit(bytes32 _obfuscatedHash, uint64 _roundNumber, uint8 _depth)
```

Store `declaredDepth` in `Commit`. At `reveal()`, require `_depth == declaredDepth` **before** proximity and floor checks.

The opaque `_obfuscatedHash` alone does not bind the commit-time `_depth` argument. `wrapCommit()` binds depth to the hash preimage, but the contract cannot inspect that preimage until reveal.

**2. Eligibility at commit (shared with `isParticipatingInUpcomingRound`)**

During commit phase:

```
depthResponsibility = _depth - height   // must be > 0
inProximity(overlay, currentRoundAnchor(), depthResponsibility)
_depth >= currentFloor()
```

Proximity is a **probabilistic economic filter** (~`2^-responsibility` eligibility), not a hard cap on N.

**3. Depth floor**

`currentFloor()` is a governed parameter or bootstrap constant, independent of the selected truth tuple. See [MINIMUM_DEPTH_OPTIONS.md](./MINIMUM_DEPTH_OPTIONS.md) for policy options.

**4. Bounded work (required for liveness)**

Choose one:

- **Hard commit cap** — `MAX_COMMITS` from fork benchmarks on Gnosis; admission rule must resist slot-filling censorship (e.g. deterministic scored selection, not pure first-come-first-served)
- **Batched finalization** — permissionless `finalizeRound(round, start, count)` with persisted cursors; idempotent penalty application across txs

**5. Split finalize and claim**

```
finalizeRound(round)  → truth, winner, penalties, oracle adjust, currentClaimRound
claimReward(round, proofs) → proof verification + pot withdrawal only
```

Finalization must fit within gas limits via the cap or batching above. Do not delete round arrays at rollover until finalization completes or an explicit expiry path runs.

### Round flow

1. Governance sets `currentFloor()` or a bootstrap constant applies.
2. **Commit phase** — `commit(hash, round, depth)`; revert if `depth <= height`, not in proximity, `depth < floor`, or cap reached.
3. **Reveal phase** — `declaredDepth` match, proximity to reveal anchor, `depth > height`, `depth >= floor`.
4. **Finalize** — `finalizeRound()` computes truth, winner, penalties, oracle adjustment (bounded work).
5. **Claim** — `claimReward()` verifies proofs and withdraws pot to `winner.owner`.

### Coverage

| Problem | Eligibility rules | Bounded work | Split finalize/claim |
|---------|-------------------|--------------|----------------------|
| Global sybil commit spam | Partial (economic) | **Strong** | — |
| `depth == height` cheap path | **Strong** | — | — |
| Claim gas grief from huge N | Weak alone | **Strong** | Partial |
| Penalties lost when claim OOGs | — | — | **Strong** |
| Proof deadlock after bad truth | Weak (reduces N only) | Partial | Partial |

### Open design questions

- Bootstrap floor value when no governance parameter exists
- `MAX_COMMITS` vs batched finalization trade-off
- Admission policy under hard cap (censorship resistance)
- Truth aggregation redesign (hash-level consensus before depth binding) — separate protocol decision
- Handling `WithdrawFailed` when `PostageStamp.withdraw()` fails after finalization

### Implementation order

1. Reproducible gas benchmarks on Gnosis fork (N ∈ {1, 6, 25, 50, 100, 200, …})
2. `Commit.declaredDepth` + `commit(..., _depth)` + eligibility helper
3. Staking: revalidate collateral on height change
4. `currentFloor()` view + governed/bootstrap floor
5. `MAX_COMMITS` or batched `finalizeRound()`
6. `claimReward()` split
7. Bee/client release + redeploy (breaking `commit()` ABI; contract is not upgradeable)

---

## Related code and docs

- [`Redistribution.sol`](../src/Redistribution.sol) — `commit()`, `reveal()`, `claim()`, `winnerSelection()`
- [`Staking.sol`](../src/Staking.sol) — `MIN_STAKE`, `freezeDeposit()`, `manageStake()`
- [MINIMUM_DEPTH_OPTIONS.md](./MINIMUM_DEPTH_OPTIONS.md) — depth floor policy
- [REDISTRIBUTION.md](./REDISTRIBUTION.md) — game overview

## Status

**Planned, not implemented.** Documented for discussion and implementation planning.
