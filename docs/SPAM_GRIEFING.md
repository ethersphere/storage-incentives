# Redistribution: Spam and Griefing Threat Model

This document describes how sybil spam and griefing attacks work against `Redistribution.sol`, what they can achieve, order-of-magnitude estimates for how many nodes are needed to block `claim()`, and the proposed mitigation package.

For depth-floor policy details, see [MINIMUM_DEPTH_OPTIONS.md](./MINIMUM_DEPTH_OPTIONS.md).

## Summary

The main griefing vector is a sybil farm: many staked addresses, each with one commit per round, inflating `currentCommits` so `claim()` does linear work in `getCurrentTruth()` and `winnerSelection()`.

There is no hard cap on `currentCommits.length`. Claim work scales as O(N) over commits; commit-phase attacker work scales as O(N²) across the round. Arrays reset each round, so griefing is per-round, not cumulative forever.

Depth floors and proximity are economic filters, not deterministic liveness guarantees. The recommended near-term fix is `MAX_COMMITS` plus split finalization (`finalizeRound` / `claimReward` / `finalizeEmptyRound`), together with commit eligibility rules and weighted admission at commit cutoff.

No real Bee nodes or stored chunks are required for the attack. `commit()` and `reveal()` only check stake, phase, `wrapCommit()` consistency, and proximity. Reserve commitment hashes are not validated against storage until `claim()` proof verification.

---

## What an attacker can do

The practical attack is a sybil farm: many staked addresses, each participating once per round.

### Hard limits per identity

- One commit per overlay per round. `commit()` scans `currentCommits` and reverts with `AlreadyCommitted()` if that overlay already exists.
- One reveal per commit. `AlreadyRevealed()` prevents double reveal.

Scale is bounded by number of sybil stakers, not unlimited transactions from one wallet.

### Entry requirements (each sybil)

1. Minimum stake: `MIN_STAKE * 2^height` on first deposit in `Staking.sol` (`MIN_STAKE = 1e17` at height 0).
2. Two-round wait: `MustStake2Rounds` before the first commit.
3. Gas: one commit tx and optionally one reveal tx per round.
4. Stake updates reset the wait: any `manageStake()` call updates `lastUpdatedBlockNumber`, restarting the two-round eligibility clock.

### Commit vs reveal asymmetry

- `commit()` does not check proximity. Any staked node can enter `currentCommits`.
- `reveal()` checks proximity via `inProximity()`.

If `_depth == height`, then `depthResponsibility = 0` and proximity always passes (`inProximity(..., 0)` is true for every overlay). That is the cheapest valid reveal path (lowest `stakeDensity`, easiest proximity).

An existing staker can also call `manageStake(nonce, 0, newHeight)` without adding tokens. Minimum stake is enforced only on first deposit, so a mature minimum-funded stake can later set `height` to match a declared floor and keep `depth == height`.

### Who can call `claim()`

`claim()` has no `msg.sender` check. Any party that supplies valid proofs can submit the transaction and pay gas; the pot is withdrawn to `winner.owner`, not the caller. Relayers or griefers can therefore attempt claims on behalf of the network.

---

## Where array growth hurts

Several paths loop over `currentCommits.length`:

| Phase  | Function            | Cost per operation      |
|--------|---------------------|-------------------------|
| Commit | overlay uniqueness  | O(n) per new commit     |
| Reveal | `findCommit()`      | O(n) per reveal         |
| Claim  | `getCurrentTruth()` | O(n) over all commits   |
| Claim  | `winnerSelection()` | O(n) again              |
| View   | `isWinner()`        | O(n) again              |

A farm of N sybil nodes increases claim work linearly in N. Per-iteration cost is not uniform: commit-only sybils are cheap in `getCurrentTruth()` but expensive in `winnerSelection()` because of `freezeDeposit()` external calls.

Arrays reset each round (`delete currentCommits` at the start of a new commit phase). Griefing is per-round, not cumulative forever.

---

## Attack scenarios

### 1. Zero-reveal round lock (cheapest path)

Attack: many sybil commits, no reveals.

Effect: `claim()` reverts `NoReveals()` before `getCurrentTruth()` or the penalty loop, because `currentRevealRound` is only set on the first successful reveal. No `freezeDeposit()` runs; no oracle adjustment; no loop bloat at claim time.

What breaks: the round cannot be claimed. The pot continues to accrue in PostageStamp. After the claim phase ends or the next round begins, that round is permanently unclaimable. Its arrays are deleted on rollover and cannot shrink mid-round.

Cost to attacker: commit gas only (O(N²) across the round). No stake freeze. No reveals and no real storage required.

### 2. Claim-phase gas griefing

Attack: N sybil commits plus at least one reveal (honest or dishonest).

Effect: `claim()` runs `winnerSelection()` over all N commits. If gas exceeds the transaction or block limit, the entire transaction reverts atomically. `currentClaimRound` is not updated; all `freezeDeposit()` calls in that tx are rolled back.

Who pays: whoever calls `claim()` and supplies proofs.

What breaks: the round does not finalize while N stays high. Every retry in the same claim phase repeats the same O(N) work. If no successful claim occurs before rollover, the round becomes unclaimable; the accumulated pot remains for a later successful withdrawal.

Penalties apply only when a `claim()` transaction fully succeeds. A grief that blocks every claim is penalty-free for the attacker. Sybil reveals can use fabricated hashes; the attacker does not need to win or pass proof checks.

### 3. Truth poisoning / proof deadlock

Attack: sybil reveals with a fabricated `(hash, depth)` and enough aggregate `stakeDensity` to be selected as truth.

Effect: truth selection is a stake-density-weighted lottery over individual reveals, not a majority vote or correctness check. Any revealed tuple can become truth with probability proportional to its `stakeDensity`. Commit order also influences the draw because randomness is keyed on commit array index `i`.

If a fabricated hash is selected:

- Only reveals matching that exact `(hash, depth)` enter winner selection.
- Honest nodes cannot supply valid chunk proofs for the selected hash.
- `claim()` reverts during proof verification; penalties and `currentClaimRound` roll back with the tx.

A single malicious reveal in a round becomes truth deterministically. This is a liveness attack independent of exceeding gas limits.

### 4. Commit-only spam with at least one reveal

Attack: many commits, one honest or sybil reveal, all other sybils skip reveal.

Effect: bloats the `winnerSelection()` loop. Each non-revealed commit can trigger `freezeDeposit()` only if the full `claim()` succeeds. Freeze duration scales as `2 ** truthRevealedDepth`, not the offender's own depth.

With default `penaltyRandomFactor = 100`, disagreeing reveals are also always frozen when claim succeeds.

### 5. Price oracle side effects

`redundancyCount` counts revealers matching the selected exact `(hash, depth)` tuple. Sybils that reveal a different hash do not increase redundancy.

If claims are skipped for multiple rounds, the next successful `adjustPrice()` can apply compounded increases for each skipped round. Griefing that blocks claims can indirectly spike storage price when a claim eventually succeeds.

---

## What does not happen

- One wallet spamming many commits: blocked by `AlreadyCommitted()`
- Unlimited free participation: stake and two-round delay required
- Automatic pot theft via spam alone: `claim()` still requires valid chunk proofs matching the selected winner's hash
- Permanent cross-round array bloat: arrays reset each round
- Automatic stake destruction on freeze: `freezeDeposit()` time-locks participation; stake is not slashed (slash path is commented out)
- Recovery of a griefed round after phase rollover: the old round cannot be claimed later; only the aggregate pot carries forward

---

## Gas model: how many nodes to block `claim()`?

### Illustrative baseline (unverified)

The following figures are engineering estimates, not regression-tested benchmarks. No `gasUsed` assertions for sybil scaling exist in `test/Redistribution.test.ts` today. Re-measure on a Gnosis-compatible fork before relying on thresholds.

| Participants | Commits | Reveals | `claim()` gas (illustrative) |
|--------------|---------|---------|------------------------------|
| 1 honest     | 1       | 1       | ~450,000                     |
| 1 honest + 5 sybil commit-only | 6 | 1 | ~570,000 |

Marginal cost per extra commit-only sybil in `winnerSelection()` (loop + `freezeDeposit()`): ~25,000 gas (order-of-magnitude).

Proof verification (BMT inclusion, stamp, SOC) dominates the baseline (~400k+ gas) but scales weakly with N. Loop + freeze work scales linearly with commit count.

### Approximate formula

```
G_claim(N) ≈ G_base + (N − 1) × G_sybil
```

Where (illustrative):

- `G_base` ≈ 450k gas: one honest commit + reveal + full proof path
- `G_sybil` ≈ 25k gas: each additional commit-only sybil when claim runs (freeze + loop)

Dishonest reveals add similar or slightly higher marginal cost. The zero-reveal variant (scenario 1) incurs no claim gas at all.

### Threshold estimates

Solve `G_base + (N − 1) × G_sybil > G_limit`:

| Limit | Typical context | Approx. sybils to exceed |
|-------|-----------------|---------------------------|
| ~3M gas | Conservative wallet / RPC cap | ~100-110 |
| ~10M gas | Generous tx cap | ~390-400 |
| ~17M gas | Gnosis Chain block limit (production) | ~660-680 |

Production `mainnet` in this repo deploys to Gnosis Chain (chainId 100), not Ethereum L1. Do not use Ethereum's ~30M block limit for capacity planning here.

Examples (illustrative formula):

- N = 100: ~450k + 99×25k ≈ 2.9M gas (may fail under tight wallet limits)
- N = 500: ~450k + 499×25k ≈ 12.9M gas
- N = 660: ~450k + 659×25k ≈ ~17M gas (Gnosis block-limit cliff)

Re-measure after contract, compiler, or proof-shape changes. Cold/warm storage and calldata size can shift coefficients.

### Commit-phase cost to the attacker

Each sybil commit scans the full commit array: total attacker gas to fill N slots is O(N²) across the round. That is a partial economic deterrent but does not protect the winner's single `claim()` tx.

---

## Economic cost to spam

Per sybil at `height = 0` (minimum path):

| Item | Cost |
|------|------|
| Minimum stake | `MIN_STAKE` = 1e17 base units = 10 BZZ (token uses 16 decimals) |
| Time lock | 2 × ROUND_LENGTH blocks (~304 blocks, ~25 min at 5s/block) before first commit |
| Commit + reveal gas | Paid every round (chain-dependent) |
| Freeze on successful claim | Time-lock via `freezeDeposit()`; stake not destroyed |

Example: ~100 sybils for wallet-limit griefing ≈ 1,000 BZZ minimum locked stake at height 0, plus gas. If every claim is successfully blocked, no freeze is applied.

Example: ~660 sybils for Gnosis block-limit griefing ≈ 6,600 BZZ minimum locked stake at height 0, plus O(N²) commit gas and operational burden.

Eligibility rules change how sybils must stake and reveal. Bounded work is what caps N and protects claim liveness.

---

## Proposed mitigation package

The full package has three layers: eligibility rules (raise sybil cost), bounded participation (`MAX_COMMITS` with weighted admission), and split finalization (penalties persist independently of proofs).

### Recommended near-term solution

```
Eligibility (proximity at commit, depth > height, floor, stored depth)
        +
MAX_COMMITS + weighted admission at end of commit phase
        +
finalizeRound() / finalizeEmptyRound() / claimReward() split
```

This caps claim-loop gas and (with split finalize) makes one-round sybil attacks expensive via freezes without requiring honest nodes to win a gas war.

---

## Penalty gaps in the current contract

Penalties are the main reason a capped sybil farm cannot attack every round cheaply. Today there are three gaps that break that story.

### Gap 1: penalties live inside the same tx as proofs

`claim()` calls `winnerSelection()` first, then verifies proofs:

```solidity
function claim(...) external {
    winnerSelection();   // freezeDeposit() for non-reveal / wrong-truth
    // ... proof verification (reverts on failure)
    // ... withdraw pot
}
```

Any proof revert rolls back the entire transaction, including all `freezeDeposit()` calls and `currentClaimRound`. So a sybil winner with a fake hash can undo penalties for everyone by failing proofs.

This is an incentives bug: dishonest play should trigger penalization, not a full rollback of punishments already computed.

### Gap 2: zero reveals means no penalty path

`winnerSelection()` reverts `NoReveals()` when `currentRevealRound != currentRound`. That happens when nobody revealed in the round (`currentRevealRound` is only set on the first successful reveal).

The penalty loop never runs. Commit-only sybils pay commit gas only and stay unfrozen.

### Gap 3: freeze is a time-lock, not a slash

`freezeDeposit()` prevents participation for a period. Stake is not destroyed. After the freeze ends the same capital can attack again (with new wallets still needing the two-round staking wait).

### Who gets penalized today (only if full `claim()` succeeds)

| Participant | Condition | Penalty |
|-------------|-----------|---------|
| Commit, no reveal | `!revealed` in loop | Always frozen (`penaltyMultiplierNonRevealed`) |
| Reveal, wrong truth | hash/depth != truth | Frozen with probability `penaltyRandomFactor` |
| Reveal, matches truth | exact tuple match | No disagreement penalty |
| Selected winner | bad proofs | No penalty; whole tx reverts |

---

## Split finalization: design and rationale

Split the current atomic `claim()` into separate steps with persisted round state.

### Functions

```solidity
// At least one reveal in the round
finalizeRound(uint64 round)
  → getCurrentTruth()
  → winnerSelection loop (freezes)
  → OracleContract.adjustPrice()
  → set currentClaimRound, store winner + truth
  → mark round finalized

// Zero reveals in the round
finalizeEmptyRound(uint64 round)
  → require currentRevealRound != round
  → freeze all committers (non-reveal penalty)
  → set currentClaimRound
  → mark round finalized (no truth, no winner, no pot)

// After finalizeRound only
claimReward(uint64 round, proofs...)
  → require round finalized, winner set
  → verify proofs + withdraw pot to winner.owner
  → proof failure reverts only this tx; freezes already persisted
```

### Why this fixes the proof-revert bug

| Step | On proof failure |
|------|------------------|
| Today (`claim()` atomic) | All penalties rolled back |
| Split (`finalizeRound` then `claimReward`) | Penalties already on-chain; only pot payout blocked |

Anyone can call `finalizeRound()` or `finalizeEmptyRound()` (permissionless). The winner (or a relayer) calls `claimReward()` separately.

### Gas with MAX_COMMITS

Set `MAX_COMMITS` from Gnosis fork benchmarks so `finalizeRound()` fits in one tx at N = MAX (illustrative: ~100 commits ≈ 2.9M gas for finalize + ~450k for proofs in `claimReward()`).

No OOG from sybil count if admission enforces the cap.

---

## MAX_COMMITS and weighted admission

### Why a hard cap

A cap bounds `currentCommits.length`, so `finalizeRound()` loop + `freezeDeposit()` calls stay under the block/wallet gas limit.

### Why not first-come-first-served

If the first `MAX_COMMITS` txs win, sybils can race to fill slots and exclude honest nodes for that round. Admission must not be pure FCFS.

### Recommended admission: weighted lottery at commit cutoff

Collect all eligible commits during the commit phase into a pending pool. At a fixed block (last block of commit phase), select `MAX_COMMITS` using the same weighting philosophy as truth/winner selection.

**Admission score** (computed at commit, with stored `declaredDepth`):

```
admissionScore = nodeEffectiveStake(owner) × 2^(declaredDepth - height)
```

This matches `stakeDensity` at reveal. A minimum-stake sybil at shallow depth scores low; one honest node at real depth scores much higher.

**Selection:** stake-density-weighted reservoir lottery seeded by round anchor (not tx ordering). Small stake still has a nonzero chance to be admitted, consistent with the random win mechanic in claim. A farm of 100 cheap sybils does not automatically crowd out one serious honest commit.

**Alternative:** top-N by score (simpler, but small honest stake may miss a full round). Weighted lottery is preferred for fairness alignment with the existing game.

### Optional: commit bond

For extra protection on the zero-reveal path before someone calls `finalizeEmptyRound()`:

```
commit() locks bond (e.g. 1-5 BZZ)
  → refunded on valid reveal
  → forfeited if no reveal by end of reveal phase
```

Economic penalty without scanning the array. Complements `finalizeEmptyRound()`, does not replace it.

---

## Eligibility rules (supporting layer)

These raise sybil cost but do not cap N alone. They pair with `MAX_COMMITS`.

**1. Extend `commit()` with stored depth**

```solidity
commit(bytes32 _obfuscatedHash, uint64 _roundNumber, uint8 _depth)
```

Store `declaredDepth` in `Commit`. At `reveal()`, require `_depth == declaredDepth` before proximity and floor checks.

**2. Eligibility at commit**

```
depthResponsibility = _depth - height   // must be > 0
inProximity(overlay, currentRoundAnchor(), depthResponsibility)
_depth >= currentFloor()
```

**3. Depth floor:** governed or bootstrap `currentFloor()`. See [MINIMUM_DEPTH_OPTIONS.md](./MINIMUM_DEPTH_OPTIONS.md).

**4. Staking:** revalidate `MIN_STAKE * 2^height` on every `manageStake` height change.

---

## How the recommended package handles each attack

Assume `MAX_COMMITS = 100` (from benchmarks), weighted admission, split finalize, and eligibility rules in place.

### Scenario 1: Zero-reveal (100 sybil commits, no reveals)

| Today | With package |
|-------|----------------|
| `NoReveals()`, no penalty, round stuck | Anyone calls `finalizeEmptyRound()`: all 100 committers frozen, round closed |
| Attacker cost: commit gas only | Attacker cost: commit gas + 100× freeze duration + ~1,000 BZZ locked during freeze |
| Same wallets retry next round | Frozen wallets cannot play until freeze ends |

Pot still accrues; that round has no winner. Repeat attack needs new stakes or waiting out freezes.

### Scenario 2: Gas grief (100 commits + reveals)

| Today | With package |
|-------|----------------|
| O(N) may OOG at high N | N capped at 100; `finalizeRound()` gas bounded |
| Penalties lost on OOG | Finalize succeeds; penalties persist |

### Scenario 3: 99 commit-only sybils + 1 honest reveal, honest wins

| Today | With package |
|-------|----------------|
| 99 frozen only if full `claim()` succeeds | `finalizeRound()`: 99 non-reveal frozen immediately |
| | `claimReward()`: honest proofs, pot paid |

One attack round penalizes 99 sybils. Attacker needs new identities or waits for freeze expiry.

### Scenario 4: 99 commit-only + 1 sybil fake reveal, sybil wins truth

| Today | With package |
|-------|----------------|
| 99 frozen in loop, then proof fails → all rolled back | `finalizeRound()`: 99 non-reveal frozen, persisted |
| No penalty after failed proofs | `claimReward()` fails on proofs; freezes remain |
| Round not closed | Round closed; pot not paid until honest path in a later round |

Sybil does not get the pot. Commit-only sybils still frozen.

### Scenario 5: 100 sybil reveals (same fake hash), sybil wins

| Today | With package |
|-------|----------------|
| No disagreement penalty (all match wrong truth) | Same: no disagreement penalty |
| Proof fails → full revert | `finalizeRound()` completes (no non-reveal if all revealed) |
| | `claimReward()` fails; round closed, no pot |

Weakest case: all sybils revealed the same lie. No non-reveal freezes. Optional mitigations: reveal sample proof (reject fake reveals at reveal time), commit bond, or higher floor/depth requirements. Truth redesign is a separate decision.

### Scenario 6: 100 sybils fill slots via FCFS (without weighted admission)

| With FCFS only | With weighted admission |
|----------------|-------------------------|
| Honest node may be excluded for the round | Honest high-score commit likely in top 100 lottery draw |
| One round of exclusion | Sybil farm must outbid on stake×depth, not just tx speed |

### Scenario 7: Sybils "play right" (real storage, valid reveals)

If sybils actually store chunks and reveal honestly, they are real network participants, not a cheap grief farm. Cost is real infrastructure and stake per identity. The game works as designed.

### Scenario 8: Sustained multi-round attack

| Cost per round | Effect |
|----------------|--------|
| ~100 stakes × 10 BZZ ≈ 1,000 BZZ locked | Capital tied up |
| 2-round wait per new identity | Rate limit on fresh sybils |
| Freeze after bad play | Cannot immediately reuse same wallets |
| Gas for 100 commits (O(N²) across phase) | Operational cost |

Each successful attack round that triggers freezes makes the next round more expensive (new wallets, new wait, more gas). Not impossible, but materially more costly than today where zero-reveal and proof-failure paths are penalty-free.

---

## Scenario summary table

| Attack | MAX_COMMITS | Split finalize | finalizeEmptyRound | Weighted admission |
|--------|-------------|----------------|--------------------|--------------------|
| Zero-reveal lock | Round bounded | n/a | Freezes all committers | n/a |
| Gas grief | Gas bounded | Penalties persist | n/a | n/a |
| Commit-only + honest win | n/a | 99 frozen, persisted | n/a | Honest likely admitted |
| Fake winner, bad proofs | n/a | Non-reveal frozen, persisted | n/a | n/a |
| All sybil reveals, same lie | n/a | Round closes, no pot | n/a | n/a |
| Slot filling | Caps N | n/a | n/a | Honest not trivially excluded |
| Sustained farm | Per-round capital + freeze | Repeat costly | Zero-reveal punished | n/a |

---

## Round flow (recommended)

1. Governance sets `currentFloor()` or bootstrap constant applies.
2. Commit phase: nodes call `commit(hash, round, depth)`; commits stored in pending pool with `admissionScore`.
3. Last block of commit phase: `selectCommits(MAX_COMMITS)` via weighted lottery; only selected commits enter `currentCommits`.
4. Reveal phase: `declaredDepth` match, proximity, `depth > height`, `depth >= floor`.
5. Claim phase:
   - If reveals exist: `finalizeRound()` then `claimReward(proofs)`.
   - If no reveals: `finalizeEmptyRound()`.
6. Do not delete round arrays at rollover until finalization completes.

---

## Open design questions

- Exact `MAX_COMMITS` from Gnosis gas benchmarks (target: finalize + freezes fit in ~10-15M with margin)
- `finalizeEmptyRound` timing: any time in claim phase vs deadline block
- Commit bond amount and forfeiture rules
- Reveal sample proof for fake-hash sybils (adds gas for all revealers)
- Winner fails to call `claimReward()` before expiry: freeze winner?
- `WithdrawFailed` when `PostageStamp.withdraw()` fails after finalization

---

## Implementation order

1. Reproducible gas benchmarks on Gnosis fork (N ∈ {1, 6, 25, 50, 100, …})
2. Split `finalizeRound()`, `finalizeEmptyRound()`, `claimReward()` from `claim()`
3. `MAX_COMMITS` + `selectCommits()` weighted admission at commit cutoff
4. `Commit.declaredDepth` + `commit(..., _depth)` + eligibility helper
5. Staking: revalidate collateral on height change
6. `currentFloor()` view + governed/bootstrap floor
7. Optional commit bond
8. Bee/client release + redeploy (breaking ABI; contract not upgradeable)

---

## Related code and docs

- [`Redistribution.sol`](../src/Redistribution.sol): `commit()`, `reveal()`, `claim()`, `winnerSelection()`
- [`Staking.sol`](../src/Staking.sol): `MIN_STAKE`, `freezeDeposit()`, `manageStake()`
- [MINIMUM_DEPTH_OPTIONS.md](./MINIMUM_DEPTH_OPTIONS.md): depth floor policy
- [REDISTRIBUTION.md](./REDISTRIBUTION.md): game overview

## Status

Planned. Not yet implemented in `Redistribution.sol`.
