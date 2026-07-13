# Redistribution — Spam and Griefing Threat Model

This document describes how sybil spam and griefing attacks work against `Redistribution.sol`, what they can achieve, and order-of-magnitude estimates for how many nodes are needed to block `claim()`.

For minimum-depth floor policy options, see [MINIMUM_DEPTH_OPTIONS.md](./MINIMUM_DEPTH_OPTIONS.md).

## Summary

The main griefing vector is a **sybil farm**: many staked addresses, each with one commit per round, inflating `currentCommits` so `claim()` does linear work in `getCurrentTruth()` and `winnerSelection()`.

Minimum depth policy (old or proposed) **does not cap sybil count** — it only filters how shallow each reveal may be. This attack existed with the old winner-based floor and still exists without any floor.

Removing the floor makes the **cheapest reveal path** easier (`depth == height`, proximity always passes) but does not change the claim-loop scaling or the number of sybils needed to blow gas budgets by orders of magnitude.

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

### Commit vs reveal asymmetry

- `commit()` does **not** check proximity — any staked node can enter `currentCommits`.
- `reveal()` checks proximity via `inProximity()`.

If `_depth == height`, then `depthResponsibility = 0` and proximity **always passes**. That is the cheapest valid reveal path (lowest `stakeDensity`, easiest proximity). Without a minimum depth floor, this path is always available.

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

A farm of **N** sybil nodes increases claim work linearly in **N**. Each additional commit also makes later commits in the same round slightly more expensive (uniqueness scan).

Arrays reset each round (`delete currentCommits` at the start of a new commit phase). Griefing is **per-round**, not cumulative forever.

---

## Attack scenarios

### 1. Claim-phase gas griefing (most serious)

**Attack:** Many sybil nodes commit; optionally reveal (honest or dishonest).

**Effect:** `claim()` calls `winnerSelection()`, which iterates every commit. If gas exceeds the transaction or block limit, `claim()` **reverts entirely** — including `currentClaimRound`, which is set at the end of `winnerSelection()`.

**Who pays:** Whoever calls `claim()` (typically the winner).

**What breaks:** Round may not finalize; pot not distributed until participation drops or mitigations are added.

### 2. Commit-only spam (commit, skip reveal)

**Attack:** Many commits, no reveals.

**Effect:** Each non-revealed commit triggers `freezeDeposit()` at claim. Still bloats the loop.

**Cost to attacker:** Stake freeze on every sybil plus gas. Self-harming unless the goal is purely to inflate **N** for scenario 1.

With default `penaltyRandomFactor = 100`, disagreeing reveals are also always frozen — the expensive `freezeDeposit()` path is the dominant per-sybil cost at claim.

### 3. Dishonest reveal spam

**Attack:** Reveal values that will not match selected truth.

**Effect:** Adds to `currentReveals` and claim-loop work; does **not** win truth (stake-density weighted selection). At `depth == height`, `stakeDensity = stake` — loop filler, not a truth hijack.

### 4. Price oracle manipulation

`redundancyCount` counts truth-agreeing revealers for `adjustPrice()`. Disagreeing sybils do **not** increase redundancy. Spam does not manipulate price unless sybils honestly agree with truth.

---

## What does not happen

- One wallet spamming many commits — blocked by `AlreadyCommitted()`
- Unlimited free participation — stake and two-round delay required
- Sybils automatically winning — wrong hash loses truth selection
- Direct pot theft via spam — `claim()` still requires valid chunk proofs from the winner
- Permanent cross-round state bloat — arrays reset each round

---

## Relation to minimum depth

The removed `currentMinimumDepth()` check:

```solidity
if (_depth < currentMinimumDepth()) revert OutOfDepth();
```

did **not** limit sybil count or claim-loop size. It blocked **low-depth reveals** (especially `depth ≈ height`). **Commit-only spam was already possible** with the old floor.

| Aspect                         | With old floor              | Without floor (current)     |
|--------------------------------|-----------------------------|-----------------------------|
| Sybil / claim gas grief        | Present                     | Present                     |
| Easiest reveal path            | `depth >= floor`            | `depth == height`           |
| Penalties on caught spammers   | `truthRevealedDepth`-scaled | Same                        |

See [MINIMUM_DEPTH_OPTIONS.md](./MINIMUM_DEPTH_OPTIONS.md) for floor policy alternatives. Those options address depth gating, not sybil **N**.

---

## Gas model — how many nodes to block `claim()`?

### Measured baseline (Hardhat, current contract)

Local test run (`test/Redistribution.test.ts`, bee CAC claim path):

| Participants | Commits | Reveals | `claim()` gas |
|--------------|---------|---------|---------------|
| 1 honest     | 1       | 1       | **~447,000**  |
| 1 honest + 5 sybil commit-only | 6 | 1 | **~570,000** |

**Marginal cost** per extra commit-only sybil (includes `freezeDeposit()` in `winnerSelection()`): **~25,000 gas**.

Proof verification (BMT inclusion, stamp, SOC) dominates the baseline (~400k+ gas) but scales weakly with **N**. Loop + freeze work scales **linearly** with commit count.

### Approximate formula

```
G_claim(N) ≈ G_base + (N − 1) × G_sybil
```

Where (measured / estimated):

- `G_base` ≈ **450k gas** — one honest commit + reveal + full proof path
- `G_sybil` ≈ **25k gas** — each additional commit-only sybil at claim (freeze + loop)

Use **~25k gas per sybil** for commit-only spam. Dishonest reveals add similar or slightly higher cost when `penaltyRandomFactor = 100`.

### Threshold estimates

Solve `G_base + (N − 1) × G_sybil > G_limit`:

| Limit | Typical context | Approx. sybils to exceed |
|-------|-----------------|---------------------------|
| **~3M gas** | Conservative wallet / RPC cap | **~100–110** |
| **~10M gas** | Lower block-gas chains / headroom | **~390–400** |
| **30M gas** | Ethereum L1 block limit | **~1,200** |

Examples:

- **N = 100** → ~450k + 99×25k ≈ **2.9M gas** (may fail under tight wallet limits)
- **N = 500** → ~450k + 499×25k ≈ **~12.9M gas** (exceeds many practical caps)
- **N = 1,200** → ~**~30.4M gas** (exceeds 30M block limit on L1)

These are **order-of-magnitude** figures. Mainnet gas can differ (cold/warm storage, calldata, proof shape). Re-measure after contract or compiler changes.

### Commit-phase cost to the attacker

Each sybil commit scans the full commit array: total attacker gas to fill **N** slots is **O(N²)** across the round (first commit cheap, last commit scans **N−1** entries). That is a partial economic deterrent but does not protect the winner’s single `claim()` tx.

---

## Economic cost to spam

Per sybil at `height = 0` (minimum path):

| Item | Cost |
|------|------|
| Minimum stake | `MIN_STAKE` = **1e17** base units (0.1 BZZ at 16 decimals) |
| Time lock | **2 × ROUND_LENGTH** blocks (~304 blocks, ~25 min at 5s/block) before first commit |
| Commit + reveal gas | Paid every round (chain-dependent) |
| Commit-only at claim | **Stake frozen** via `freezeDeposit()` |

**Example:** ~100 sybils for wallet-limit griefing ≈ **10 BZZ** minimum stake (height 0) plus gas, plus frozen stake if commit-only.

Depth floor policy changes **how** sybils reveal, not the **N** needed for gas griefing when commit proximity is absent.

---

## Recommended combined approach (planned, not implemented)

The leading direction for a future implementation pairs **commit-phase proximity** with a **depth floor** (prefer Option B or E from [MINIMUM_DEPTH_OPTIONS.md](./MINIMUM_DEPTH_OPTIONS.md)). This targets both spam layers: global commit bloat and shallow/cheap reveals.

### Problem mapping

| Layer | Current gap | Mitigation |
|-------|-------------|------------|
| Commit bloat | Any staked node can `commit()` | Proximity check at commit |
| Shallow reveals | `depth == height` always passes proximity | Depth floor at commit + reveal |
| Winner floor gaming | Old winner-based floor | Option B: min depth among truth-agreeing revealers |
| Round stuck on grief | Penalties inside `claim()` | Optional later: split `finalizeRound()` / `claim()` |

### Proposed rules

**1. Extend `commit()` with depth**

Today `commit(bytes32 _obfuscatedHash, uint64 _roundNumber)` has no depth argument, so the contract cannot verify proximity at commit time. Depth is bound in `wrapCommit(overlay, depth, hash, nonce)` but only checked at reveal.

Proposed signature:

```solidity
commit(bytes32 _obfuscatedHash, uint64 _roundNumber, uint8 _depth)
```

**2. Proximity at commit**

During commit phase, require:

```
depthResponsibility = _depth - height
inProximity(overlay, currentRoundAnchor(), depthResponsibility)
```

Only nodes in the round’s neighbourhood at the declared depth may enter `currentCommits`. This is the main anti-bloat lever: **N** is bounded by eligible overlays near the anchor, not every staker on the network.

**3. Depth floor at commit and reveal**

Apply the same floor at both phases (fail fast at commit):

```
_depth >= currentFloor()
```

- **Reveal:** existing checks remain — hash must match commit (same depth), proximity to reveal anchor, `depth >= floor`.
- **Floor source:** Option **B** (minimum depth among truth-agreeing revealers from last claimed round), optionally stacked with **+1 cap** or **collapse on low participation** (Option E).

Avoid winner-only floor (removed design): proximity already limits who can commit; winner-based floor still risks honest lockout.

**4. Depth binding**

Because `wrapCommit` includes `_depth`, a node cannot commit at one depth and reveal at another without breaking the hash match.

### What this fixes

| Problem | Commit proximity | Depth floor (Option B/E) |
|---------|------------------|--------------------------|
| Global sybil commit spam | **Strong** | Weak |
| `depth == height` cheap path | Partial | **Strong** |
| Claim gas grief from huge **N** | **Strong** (N ≈ neighbourhood size) | Weak alone |
| Winner gaming the floor | — | **Fixed** with Option B |

### Remaining gaps (optional follow-ups)

1. **Neighbourhood size at low depth** — proximity limits who can commit but does not hard-cap count; a **max commits per round** may still be useful as backup.
2. **Split finalize / claim** — decouple `winnerSelection()` + penalties from winner proof verification so grief cannot block round finalization.
3. **Client changes** — Bee and other clients must pass `_depth` on commit and respect the floor when choosing depth.
4. **Bootstrap floor** — define behaviour when no prior claimed round exists (floor = 0 vs fixed minimum).

### Suggested implementation package

1. `commit(..., _depth)` + proximity on `currentRoundAnchor()`
2. Floor from Option B, optionally Option E (+1 cap, collapse on low N)
3. Same floor check at commit and reveal
4. (Optional) per-round commit cap and/or split finalize/claim

**Status:** Documented for discussion. Not implemented in `Redistribution.sol` yet.

---

## Other mitigations

If additional hardening is needed beyond the combined approach above:

- Per-round cap on commits or reveals
- Batch / paginate `winnerSelection()` across transactions or rounds
- Higher minimum stake or stake-density threshold to participate
- Off-chain monitoring and coordination to pause / respond (operational)

---

## Related code and docs

- [`Redistribution.sol`](../src/Redistribution.sol) — `commit()`, `reveal()`, `claim()`, `winnerSelection()`
- [`Staking.sol`](../src/Staking.sol) — `MIN_STAKE`, `freezeDeposit()`
- [MINIMUM_DEPTH_OPTIONS.md](./MINIMUM_DEPTH_OPTIONS.md) — floor policy discussion
- [REDISTRIBUTION.md](./REDISTRIBUTION.md) — game overview

## Status

**Open for discussion.** Option A is on `fix/minimal_depth_resolve`. The **planned** next step is commit proximity + Option B/E floor — documented but not implemented.
