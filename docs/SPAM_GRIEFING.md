# Redistribution: Spam and Griefing Threat Model

This document describes how sybil spam and griefing attacks work against `Redistribution.sol`, what they can achieve, order-of-magnitude estimates for how many nodes are needed to block `claim()`, and the proposed mitigation package.

For depth-floor policy details, see [MINIMUM_DEPTH_OPTIONS.md](./MINIMUM_DEPTH_OPTIONS.md).

## Summary

The main griefing vector is a sybil farm: many staked addresses, each with one commit per round, inflating `currentCommits` so `claim()` does linear work in `getCurrentTruth()` and `winnerSelection()`.

There is no hard cap on `currentCommits.length`. Claim work scales as O(N) over commits; commit-phase attacker work scales as O(N²) across the round. Arrays do not grow forever, but deleting attacker-sized dynamic storage arrays can move the gas failure to the first commit/reveal of the next round.

Depth floors and proximity are economic filters, not deterministic liveness guarantees.

Current contract limits:

- `currentCommits` is unbounded, so `claim()` work scales linearly with sybil count.
- **Bug:** penalties, oracle adjustment, and payout all run inside one atomic `claim()`; proof failure rolls back every `freezeDeposit()` and leaves blocking nodes unpenalized.
- Round state is global and arrays are bulk-deleted on rollover, so spam can also grief the next round.

Proposed fix:

1. A **bounded online admission set** whose storage and per-call work are capped at all times.
2. **Participation finalization** that persists only objective non-reveal penalties.
3. Proof validation before disagreement penalties, oracle adjustment, or payout.
4. Current-round-only payout rights, retryable withdrawal, explicit deadlines, and enforced step ordering so the winner must complete the chain to receive the pot.

This bounds gas and keeps false truth from triggering disagreement penalties or payout. It does **not** by itself solve an all-revealing coalition that reports the same fabricated hash; objective reveal validation or a bounded timeout/fallback protocol is still required for that liveness guarantee.

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

Arrays reset each round (`delete currentCommits` at the start of a new commit phase), but Solidity storage cleanup scales with occupied slots. Current-round spam can therefore make rollover itself expensive or uncallable. The fix must cap cleanup too, using fixed-capacity/generation-tagged state, a ring buffer, or bounded cursor cleanup.

---

## Attack scenarios

### 1. Zero-reveal round lock (cheapest path)

Attack: many sybil commits, no reveals.

Effect: `claim()` reverts `NoReveals()` before `getCurrentTruth()` or the penalty loop, because `currentRevealRound` is only set on the first successful reveal. No `freezeDeposit()` runs; no oracle adjustment; no loop bloat at claim time.

What breaks: the round cannot be claimed. The pot continues to accrue in PostageStamp. After the claim phase ends or the next round begins, that round is permanently unclaimable. Its arrays are deleted on rollover and cannot shrink mid-round.

Cost to attacker: commit gas only (O(N²) across the round). No stake freeze. No reveals and no real storage required.

**Bug:** with no reveals, `claim()` reverts `NoReveals()` and the penalty path never runs. Commit-only sybils are never frozen.

### 2. Claim-phase gas griefing

Attack: N sybil commits plus at least one reveal (honest or dishonest).

Effect: `claim()` runs `winnerSelection()` over all N commits. If gas exceeds the transaction or block limit, the entire transaction reverts atomically. `currentClaimRound` is not updated; all `freezeDeposit()` calls in that tx are rolled back.

Who pays: whoever calls `claim()` and supplies proofs.

What breaks: the round does not finalize while N stays high. Every retry in the same claim phase repeats the same O(N) work. If no successful claim occurs before rollover, the round becomes unclaimable; the accumulated pot remains for a later successful withdrawal.

Penalties apply only when a `claim()` transaction fully succeeds. A grief that blocks every claim is penalty-free for the attacker. Sybil reveals can use fabricated hashes; the attacker does not need to win or pass proof checks.

**Bug:** same penalty rollback as attack 3 — failed or out-of-gas `claim()` reverts all `freezeDeposit()` calls from `winnerSelection()`.

### 3. Truth poisoning / proof deadlock

Attack: sybil reveals with a fabricated `(hash, depth)` and enough aggregate `stakeDensity` to be selected as truth.

Effect: truth selection is a stake-density-weighted lottery over individual reveals, not a majority vote or correctness check. `reveal()` does not verify that the hash exists in storage; any revealed tuple can become truth with probability proportional to its `stakeDensity`. Commit order also influences the draw because randomness is keyed on commit array index `i`.

If a fabricated hash is selected:

- Only reveals matching that exact `(hash, depth)` enter winner selection.
- Honest nodes cannot supply valid chunk proofs for the selected hash.
- `claim()` reverts during proof verification; penalties and `currentClaimRound` roll back with the tx.

A single malicious reveal in a round becomes truth deterministically. This is a liveness attack independent of exceeding gas limits.

**Bug:** dishonest nodes can block every `claim()` attempt without being penalized. `winnerSelection()` applies `freezeDeposit()` before proofs are checked; when inclusion verification fails, the whole transaction reverts and none of those freezes persist. Blocking payout is effectively free for the attacker.

**Fix:** split finalization so objective non-reveal penalties persist before proof validation. Apply disagreement penalties and oracle adjustment only after the selected truth passes storage proofs.

### 4. Commit-only spam with at least one reveal

Attack: many commits, one honest or sybil reveal, all other sybils skip reveal.

Effect: bloats the `winnerSelection()` loop. Each non-revealed commit can trigger `freezeDeposit()` only if the full `claim()` succeeds. Freeze duration scales as `2 ** truthRevealedDepth`, not the offender's own depth.

With default `penaltyRandomFactor = 100`, disagreeing reveals are also always frozen when claim succeeds.

**Bug:** same as attack 3 — if `claim()` never completes, non-reveal freezes computed in `winnerSelection()` are rolled back and commit-only sybils stay unpenalized.

---

## Gas model: how many nodes to block `claim()`?

### Illustrative baseline (unverified)

The following figures are engineering estimates, not regression-tested benchmarks. No `gasUsed` assertions for sybil scaling exist in `test/Redistribution.test.ts` today. Re-measure on a Gnosis-compatible fork before relying on thresholds.

These are claim-side thresholds only. Attack feasibility must also account for the 38-block commit window: O(N²) uniqueness scans consume aggregate block gas and late commits become individually expensive. Benchmark the complete round, not just one `claim()` transaction.

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
| ~16.78M gas | Post-Fusaka per-transaction cap | ~650-660 |
| ~17M gas | Gnosis Chain block limit (production) | ~660-680 |

Production `mainnet` in this repo deploys to Gnosis Chain (chainId 100), not Ethereum L1. Live blocks are approximately 17M gas, while the post-Fusaka transaction cap is 16,777,216. Size from the stricter limit with substantial operational margin; do not target the cliff or use Ethereum's historical ~30M figure.

Examples (illustrative formula):

- N = 100: ~450k + 99×25k ≈ 2.9M gas (may fail under tight wallet limits)
- N = 500: ~450k + 499×25k ≈ 12.9M gas
- N = 660: ~450k + 659×25k ≈ ~17M gas (Gnosis block-limit cliff)

Re-measure after contract, compiler, or proof changes. Cold/warm storage, calldata size, external-call costs, the commit-phase block budget, and the chain's current block gas limit can shift coefficients.

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
| Freeze after penalized behavior | `freezeDeposit()` moves the staking timestamp into the future; the normal two-round maturity check still applies afterward |

Example: ~100 sybils for wallet-limit griefing ≈ 1,000 BZZ minimum locked stake at height 0, plus gas. If every claim is successfully blocked, no freeze is applied.

Example: ~660 sybils for Gnosis block-limit griefing ≈ 6,600 BZZ minimum locked stake at height 0, plus O(N²) commit gas and operational burden.

Eligibility rules change how sybils must stake and reveal. Bounded work is what caps N and protects claim liveness.

Effective re-entry is approximately the configured freeze duration **plus two rounds**, not merely the nominal freeze interval.

---

## Mitigation package

The package has three layers:

```
bounded online admission
        +
objective participation finalization
        +
proof validation before subjective penalties, oracle update, and payout
```

Supporting eligibility rules (depth floor, proximity, declared depth) raise sybil cost but do not cap N on their own.

This package bounds gas and safely persists non-reveal penalties. It deliberately does not claim that fabricated reveals are solved: if false reveals must be prevented from suppressing every payout, reveal-time validity proof or a separately audited bounded fallback protocol is required.

---

## Penalty gaps in the current contract

Penalties are the main reason a capped sybil farm cannot attack every round cheaply. Today there are four bugs and one economic limitation.

### Gap 1: penalties live inside the same tx as proofs (bug)

`claim()` calls `winnerSelection()` first, then verifies proofs:

```solidity
function claim(...) external {
    winnerSelection();   // freezeDeposit() for non-reveal / wrong-truth
    // ... proof verification (reverts on failure)
    // ... withdraw pot
}
```

Any proof revert rolls back the entire transaction, including all `freezeDeposit()` calls and `currentClaimRound`. So a sybil winner with a fake hash can undo penalties for everyone by failing proofs.

This is a bug that must be fixed: dishonest play should trigger penalization, not a full rollback of punishments already computed.

### Gap 2: zero reveals means no penalty path (bug)

`winnerSelection()` reverts `NoReveals()` when `currentRevealRound != currentRound`. That happens when nobody revealed in the round (`currentRevealRound` is only set on the first successful reveal).

The penalty loop never runs. Commit-only sybils pay commit gas only and stay unfrozen.

### Gap 3: freeze is a time-lock, not a slash (economic limitation)

`freezeDeposit()` prevents participation for a period. Stake is not destroyed. After the freeze ends the same capital can attack again (with new wallets still needing the two-round staking wait). This raises repeat-attack cost but is not a protocol bug.

### Gap 4: disagreement penalties require validated truth

Failure to reveal is objective after the reveal deadline. Disagreement is relative to a lottery-selected tuple that may be fabricated and cannot pass storage proofs.

Only non-reveal penalties belong in proof-independent finalization. Disagreement penalties and oracle adjustment require a validated truth.

### Gap 5: payout failure is currently treated as success (bug)

`claim()` makes a low-level `PostageStamp.withdraw()` call, emits `WithdrawFailed` on failure, and still completes. Because `currentClaimRound` was already set, the winner cannot retry that round.

Settlement must revert or retain an explicit retryable payout state when withdrawal fails. It must never emit final success or consume the round's payout right after a failed transfer.

### Who gets penalized today (only if full `claim()` succeeds)

| Participant | Condition | Penalty |
|-------------|-----------|---------|
| Commit, no reveal | `!revealed` in loop | Always frozen (`penaltyMultiplierNonRevealed`) |
| Reveal, wrong truth | hash/depth != truth | Frozen with probability `penaltyRandomFactor` |
| Reveal, matches truth | exact tuple match | No disagreement penalty |
| Selected winner | bad proofs | No penalty; whole tx reverts |

---

## Safe staged finalization

Use explicit current-round state and three stages. Today `claim()` is one transaction; the proposed design splits the claim phase into separate on-chain actions.

### Claim-phase actions

| Round outcome | Transactions | Calls |
|---------------|--------------|-------|
| Zero reveals | **1** | `finalizeParticipation(round)` — freeze non-revealers, close round, no payout |
| Reveals, happy path | **3** | `finalizeParticipation` → `verifyWinner(proofs)` → `settleRound` |
| Reveals, proof failure | **1–2** | `finalizeParticipation` always persists non-reveal penalties; `verifyWinner` may fail/retry; `settleRound` is not reached |

`settleRound` may need more than one attempt if withdrawal fails, but it remains a separate retryable step rather than replaying the full penalty and proof work.

All claim-phase actions must complete within the current round's claim window (or the round's payout right expires at rollover).

### Caller incentives

Today one `claim()` ties everything together: whoever submits valid proofs triggers payout to `winner.owner` in the same transaction. The winner (or a relayer acting on their behalf) has a direct economic reason to call it.

The staged design must preserve that chain:

| Step | Who is likely to call | Incentive |
|------|----------------------|-----------|
| `finalizeParticipation` | Anyone (permissionless) | **Weakest.** No pot is paid here. Non-revealers get frozen; tentative winner is stored. The tentative winner benefits indirectly and should call this before trying to prove, but can free-ride if they expect someone else to pay. Zero-reveal rounds have no winner — this step only closes the round and applies penalties. |
| `verifyWinner` | Tentative winner or relayer | **Strong once step 1 ran.** Proofs are required; payout still does not happen in this tx. Same relayer model as today's `claim()`: pot goes to stored `winner.owner`, not `msg.sender`. |
| `settleRound` | Tentative winner or relayer | **Strongest payout step.** Pot is withdrawn to stored `winner.owner` only after `truthValidated`. This is the step that actually pays. |

**Requirement:** a round with reveals only pays if all three steps succeed in order before the claim deadline. The protocol should enforce that ordering (`participationFinalized` → `truthValidated` → payout) and that only the stored winner receives the pot.

**Not specified yet (needs design):**

- What incentivizes step 1 on zero-reveal rounds when there is no winner to call it.
- Whether to expose a convenience wrapper (for example `verifyAndSettle(proofs)`) so the winner can complete steps 2–3 in one transaction while keeping the gas-bounded split internally.
- Whether step 1 receives any explicit caller reward; the doc does not assume one.

Without step 1, the winner cannot reach `verifyWinner` or `settleRound`. Without steps 2–3, the winner never receives the pot even if step 1 ran.

### 1. `finalizeParticipation(uint64 round)`

Callable only after reveal closes and before a fixed finalization deadline:

```solidity
require(round == currentRound())
require(selectedCount <= MAX_COMMITS)
freeze only selected commits that did not reveal
store tentative truth and tentative winner
mark participationFinalized
```

If there are zero reveals, close the round with no truth, no oracle update, and no payout. If there are reveals, the selected tuple remains tentative.

An empty round has no `truthRevealedDepth`, so its freeze duration cannot reuse the current truth-depth penalty formula. Define a bounded governed duration or derive a capped duration from each selected commit's stored responsibility.

This stage must **not** freeze disagreeing revealers or adjust the oracle. A false tentative truth has not earned that authority.

### 2. `verifyWinner(uint64 round, proofs...)`

During a bounded proof window:

```solidity
require(participationFinalized)
require(tentative winner exists)
verify chunk, stamp, SOC, order, and reserve-size proofs
mark truthValidated
```

Invalid proofs revert only this transaction. Because anyone can submit `verifyWinner()` with deliberately invalid calldata, a failed transaction is not evidence that the selected winner cheated and must never directly slash/freeze the winner. A timeout penalty can apply to non-delivery at the deadline if that rule is specified in advance.

Persist the round's reveal anchor, proof-selection seed, winner/truth, and proof parameters in `RoundState`; do not read mutable globals from a later phase. Stamp/proof reference timing against PostageStamp expiry is out of scope for this doc (separate PR).

### 3. `settleRound(uint64 round)`

After successful proof validation:

```solidity
require(truthValidated)
apply bounded disagreement penalties
adjust oracle using validated redundancy
withdraw the current pot to the stored winner
mark settled only after withdrawal succeeds
```

Payout failure must revert settlement or remain retryable.

### Deadlines and global-pot safety

`PostageStamp.withdraw()` transfers the entire pot at call time; it does not escrow a round-specific amount. Therefore a stale finalized winner must not be allowed to claim in a later round after more value accrued.

Use one of these audited models:

1. **Current-round-only rights:** all three stages have deadlines inside the current claim phase. An unpaid reward expires at rollover and the pot carries forward. Past rounds cannot call `withdraw()`.
2. **Escrowed round amount:** snapshot and reserve an amount in PostageStamp, then expose amount-bounded withdrawal. This requires a PostageStamp protocol change.

Storing `finalized[round]` while calling the current global `withdraw()` later is unsafe.

The design requires an explicit bounded `RoundState` record containing phase/status, reveal anchor, proof seed, tentative/validated truth, winner, and payment status. New rounds must not alias singleton proof context. Cleanup must be generation-tagged, fixed-capacity, or cursor-bounded; never bulk-delete attacker-sized arrays.

### Gas statement

Set `MAX_COMMITS` only after fork benchmarks prove every stage and downstream call fits with margin at N = MAX. The ~2.9M figure above is an estimate for the current atomic `claim()` at N = 100; benchmark the staged implementation separately.

---

## MAX_COMMITS and bounded admission

### Why a hard cap

A cap bounds `currentCommits.length`, so finalization loops and external freeze calls stay under the block/wallet gas limit.

### Why not first-come-first-served

If the first `MAX_COMMITS` txs win, sybils can race to fill slots and exclude honest nodes for that round. Admission must not be pure FCFS.

### Bounded online selection

Keep at most `MAX_COMMITS` selected records throughout the commit phase. Each accepted transaction performs bounded work, for example O(log MAX) replacement in a fixed-capacity heap. Admission must not depend on a single end-of-phase transaction that scans unbounded state.

Separate weight from random priority:

```text
weight = objectivelyLockedEffectiveStake(owner)
entropy = H(domain, round, fixedRoundSeed, overlay)
priority = auditedWeightedPriority(entropy, weight)
```

Requirements:

- `overlay` must be fixed by a stake old enough to satisfy the two-round wait.
- Near-term admission weight is stake-only. Declared depth and proximity are eligibility filters, not weight, until depth has an objective pre-admission proof; otherwise fabricated deep declarations receive unearned priority.
- Do not include `_obfuscatedHash`, reveal nonce, transaction index, or another user-grindable value in `entropy`.
- Specify an exact integer weighted-sampling algorithm; prove/check overflow bounds and capital-splitting behavior.
- Keep the best `MAX_COMMITS` priorities online and evict the current worst when appropriate.
- Emit admission/eviction events and expose final selected status so clients know whether they must reveal.
- Snapshot owner, overlay, height, effective stake, declared depth, weight, and priority at commit.
- Bound auxiliary mappings and define cleanup. A fixed array plus an ever-growing "seen candidate" mapping is not bounded.

The seed is known during commit in the simple online model. That permits mature identities to decide whether their fixed overlay has a favorable ticket, but avoids transaction-order dependence and arbitrary nonce grinding.

Weighted admission improves proportional fairness; it does not guarantee an honest node a slot. Inclusion probability depends on honest weight versus total admitted attacker weight.

For a side-by-side comparison of stake-weighted admission versus proximity-ranked admission under the same staged-finalization and eligibility baseline, see [ADMISSION_COMPARISON.md](./ADMISSION_COMPARISON.md).

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
require(height <= MAX_STAKE_HEIGHT)
require(_depth <= MAX_REPORTED_DEPTH)
require(_depth > height)
depthResponsibility = _depth - height
inProximity(overlay, currentRoundAnchor(), depthResponsibility)
_depth >= currentFloor()
```

**3. Depth floor:** governed or bootstrap `currentFloor()`. Floor changes are round-versioned and activate only in a future round; store the applicable value in round/commit state so governance cannot accept a commit under one floor and force its reveal to fail under another. See [MINIMUM_DEPTH_OPTIONS.md](./MINIMUM_DEPTH_OPTIONS.md).

**4. Staking:** validate the resulting post-state on every height change, including `_addAmount == 0`: `potentialStake >= MIN_STAKE * 2^newHeight`. Specify whether `committedStake` is recomputed at the current oracle price; do not leave this to implementer interpretation.

**5. Stake state:** ensure selected participants cannot withdraw or mutate stake/overlay/height during their obligation window. Snapshot values for selection, but apply penalties to the same owner/stake identity that created the commit.

**6. Objective validity:** if all-revealing fabricated cohorts are in scope, require a bounded reveal-time sample/validity proof or design a timeout-and-fallback mechanism. This is a required liveness decision for attack 3, not an optional hardening item.

---

## How the mitigation package handles each attack

Attacks covered: (1) zero-reveal lock, (2) claim gas grief, (3) truth poisoning / penalty-free blocking, (4) commit-only spam.

`MAX_COMMITS` remains a placeholder until measured. The examples below use K selected participants, not an assumed safe value of 100.

### 1. Zero reveal

- Bounded admission limits work to K.
- `finalizeParticipation()` freezes all selected non-revealers and closes the round.
- This defense depends on someone calling `finalizeParticipation()` before the deadline.
- The pot carries forward; there is no winner for that round.

### 2. Commit/reveal gas grief

- Online admission keeps storage and each later scan bounded by K.
- Fork benchmarks must cover worst-case K external freeze calls and not only happy-path proof verification.

### 3. Truth poisoning / proof deadlock

- The fabricated tuple can still win the stake-weighted lottery; admission and floors do not prevent that.
- Staged finalization stops a false truth from freezing honest disagreeing revealers or updating price before proofs pass.
- **Fix for the penalty rollback bug:** `finalizeParticipation()` persists non-reveal freezes even when later proof validation fails.
- All-revealing fabricated cohorts still need objective reveal validity or a timeout/fallback (see eligibility rule 6).

### 4. Commit-only spam with at least one reveal

- Participation finalization persists non-reveal freezes before proof validation, fixing the rollback bug for commit-only sybils.
- If an honest node was selected and reveals valid truth, settlement can apply disagreement policy, update the oracle, and pay.
- Admission remains probabilistic: this outcome assumes the honest node was selected.

### Slot filling (supports attacks 1–4)

- FCFS allows transaction-speed exclusion.
- Bounded stake-weighted admission makes selection depend on fixed identity and objectively locked stake rather than arrival order.
- It does not guarantee honest inclusion. A coalition with sufficient total weight can occupy all K positions.

### Rollover (supports attacks 1–2)

- Fixed-cap/generation-tagged state prevents dynamic-array deletion from becoming the next-round DoS.

---

## Related code and docs

- [`Redistribution.sol`](../src/Redistribution.sol): `commit()`, `reveal()`, `claim()`, `winnerSelection()`
- [`Staking.sol`](../src/Staking.sol): `MIN_STAKE`, `freezeDeposit()`, `manageStake()`
- [MINIMUM_DEPTH_OPTIONS.md](./MINIMUM_DEPTH_OPTIONS.md): depth floor policy
- [ADMISSION_COMPARISON.md](./ADMISSION_COMPARISON.md): proximity vs stake-weighted admission
- [REDISTRIBUTION.md](./REDISTRIBUTION.md): game overview

## Status

Proposed mitigation architecture. Not yet implemented in the contracts.
