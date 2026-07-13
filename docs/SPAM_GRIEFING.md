# Redistribution — Spam and Griefing Threat Model

This document describes how sybil spam and griefing attacks work against `Redistribution.sol`, what they can achieve, and order-of-magnitude estimates for how many nodes are needed to block `claim()`.

For minimum-depth floor policy options, see [MINIMUM_DEPTH_OPTIONS.md](./MINIMUM_DEPTH_OPTIONS.md).

## Summary

The main griefing vector is a **sybil farm**: many staked addresses, each with one commit per round, inflating `currentCommits` so `claim()` does linear work in `getCurrentTruth()` and `winnerSelection()`.

There is **no hard cap** on `currentCommits.length`. Claim work scales as O(N) over commits; commit-phase attacker work scales as O(N²) across the round. Arrays reset each round, so griefing is per-round, not cumulative forever.

Minimum depth policy (old or proposed Option B) **does not cap sybil count** and, under the current exact `(hash, depth)` truth model, does not provide an independent floor signal. Depth floors and proximity are **economic filters**, not deterministic liveness guarantees. A robust fix needs **bounded admission or batched finalization** in addition to eligibility checks.

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

## What the old docs got wrong

- **"Wrong hash loses truth selection"** — false. Dishonest reveals participate in truth lottery.
- **"Commit-only sybils are always frozen at claim"** — only when ≥1 reveal exists **and** a `claim()` tx fully succeeds.
- **"Round recovers when participation drops"** — N cannot shrink during a round's claim phase; rollover makes the round unclaimable.
- **Option B "min among truth-agreeing depths"** — under exact `(hash, depth)` truth, every agreeing revealer has the same depth; the minimum equals `truthDepth` (see [MINIMUM_DEPTH_OPTIONS.md](./MINIMUM_DEPTH_OPTIONS.md)).

---

## Relation to minimum depth

The removed `currentMinimumDepth()` check (historical; not in current `src/Redistribution.sol`):

```solidity
if (_depth < currentMinimumDepth()) revert OutOfDepth();
```

did **not** limit sybil count or claim-loop size. It blocked **low-depth reveals** (especially `depth ≈ height`). **Commit-only spam was already possible** with the old floor.

| Aspect                         | With old floor              | Without floor (current)     |
|--------------------------------|-----------------------------|-----------------------------|
| Sybil / claim gas grief        | Present                     | Present                     |
| Easiest reveal path            | `depth >= floor`            | `depth == height`           |
| Penalties on caught spammers   | `truthRevealedDepth`-scaled | Same                        |
| Caps sybil N                   | No                          | No                          |

See [MINIMUM_DEPTH_OPTIONS.md](./MINIMUM_DEPTH_OPTIONS.md) for floor policy alternatives. Depth floor alone does not solve sybil **N**.

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

Depth floor or proximity policy changes **how** sybils reveal and **where** they must stake, not the fundamental need for a hard work bound.

---

## Recommended mitigation package (planned, not implemented)

The previous draft (commit proximity + Option B/E floor) is **insufficient as specified**. Under current `(hash, depth)` truth semantics, Option B collapses to `truthDepth`; proximity at `depth == height` is vacuous; and splitting `finalizeRound()` from `claim()` alone leaves the same uncapped O(N) loop.

The leading direction is a **layered package** that combines eligibility tightening with **deterministic bounded work**.

### Problem mapping

| Layer | Current gap | Mitigation |
|-------|-------------|------------|
| Unbounded commit array | Any staked node can `commit()` | Commit proximity + positive `depth - height` + stored declared depth |
| Vacuous proximity | `depth == height` ⇒ responsibility 0 | Require `depth > height` (minimum responsibility) at commit and reveal |
| Height bypass | `manageStake(..., 0, newHeight)` without collateral check | Revalidate height-scaled minimum stake on every height change |
| Shallow reveals | `depth == height` always available | Absolute depth floor (governed or bootstrap constant), not Option B |
| Claim gas grief | O(N) loops + external freezes in one tx | Hard `MAX_COMMITS` derived from worst-case gas, or batched finalization |
| Penalties lost on grief | Freezes inside failing `claim()` tx | Persist finalization (penalties, oracle, `currentClaimRound`) before proof verification |
| Truth poisoning | Stake-weighted lottery over individual reveals | Bounded N reduces blast radius; truth-policy redesign is a separate decision |
| Round stuck on grief | Single atomic `claim()` | `finalizeRound()` + `claimReward()` split with durable per-round state |

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
_depth >= currentFloor()               // governed/bootstrap floor, not Option B
```

Proximity is a **probabilistic economic filter** (~`2^-responsibility` eligibility), not a hard cap on N.

**3. Depth floor source**

Do **not** use Option B ("min depth among truth-agreeing revealers") under current truth semantics — it equals `truthDepth`. Prefer one of:

- **Governed floor** — admin/multisig parameter with public `currentFloor()` view
- **Bootstrap constant** — network minimum depth until a better signal exists
- **Future Option B′** — only if truth aggregation is redesigned to select by `hash` first, then derive depth from the agreeing cohort (see [MINIMUM_DEPTH_OPTIONS.md](./MINIMUM_DEPTH_OPTIONS.md))

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

### What this fixes

| Problem | Eligibility package | Bounded work | Split finalize/claim |
|---------|---------------------|--------------|----------------------|
| Global sybil commit spam | Partial (economic) | **Strong** | — |
| `depth == height` cheap path | **Strong** (if `depth > height` required) | — | — |
| Claim gas grief from huge N | Weak alone | **Strong** | Partial |
| Penalties lost when claim OOGs | — | — | **Strong** |
| Proof deadlock after bad truth | Weak (reduces N only) | Partial | Partial |

### Remaining gaps

1. **Truth semantics** — stake-weighted lottery over `(hash, depth)` tuples remains; changing that is a separate protocol decision.
2. **Withdraw soft-fail** — if `PostageStamp.withdraw()` fails, round is marked claimed but pot is not paid (`WithdrawFailed` event); needs operator handling.
3. **Client / ABI migration** — breaking `commit()` signature; coordinate Bee release and redeploy (contract is not upgradeable).
4. **Benchmarks** — add reproducible gas tests before setting `MAX_COMMITS`.

### Suggested implementation order

1. Reproducible gas benchmarks on Gnosis fork (N ∈ {1, 6, 25, 50, 100, 200, …})
2. `Commit.declaredDepth` + `commit(..., _depth)` + eligibility helper
3. Staking: revalidate collateral on height change
4. `currentFloor()` view + governed/bootstrap floor
5. `MAX_COMMITS` or batched `finalizeRound()`
6. `claimReward()` split
7. Bee/client release + redeploy

**Status:** Documented for discussion. Not implemented in `Redistribution.sol` yet.

---

## Other mitigations

If additional hardening is needed:

- Higher minimum stake or stake-density threshold to participate
- Mandatory minimum reveal count before claim is allowed
- Off-chain monitoring and operational response
- Truth aggregation redesign (hash-level consensus before depth binding)

---

## Related code and docs

- [`Redistribution.sol`](../src/Redistribution.sol) — `commit()`, `reveal()`, `claim()`, `winnerSelection()`
- [`Staking.sol`](../src/Staking.sol) — `MIN_STAKE`, `freezeDeposit()`, `manageStake()`
- [MINIMUM_DEPTH_OPTIONS.md](./MINIMUM_DEPTH_OPTIONS.md) — floor policy discussion
- [REDISTRIBUTION.md](./REDISTRIBUTION.md) — game overview

## Status

**Open for discussion.** Option A (no floor) is on `fix/minimal_depth_resolve`. The **planned** next step is the layered mitigation package above — documented but not implemented.
