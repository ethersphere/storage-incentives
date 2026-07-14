# Redistribution: Spam and Griefing Threat Model

This document describes how sybil spam and griefing attacks work against `Redistribution.sol`, what they can achieve, order-of-magnitude estimates for how many nodes are needed to block `claim()`, and the proposed mitigation package.

For depth-floor policy details, see [MINIMUM_DEPTH_OPTIONS.md](./MINIMUM_DEPTH_OPTIONS.md).

## Summary

The main griefing vector is a sybil farm: many staked addresses, each with one commit per round, inflating `currentCommits` so `claim()` does linear work in `getCurrentTruth()` and `winnerSelection()`.

There is no hard cap on `currentCommits.length`. Claim work scales as O(N) over commits; commit-phase attacker work scales as O(N²) across the round. Arrays do not grow forever, but deleting attacker-sized dynamic storage arrays can move the gas failure to the first commit/reveal of the next round.

Depth floors and proximity are economic filters, not deterministic liveness guarantees.

Current contract limits:

- `currentCommits` is unbounded, so `claim()` work scales linearly with sybil count.
- Penalties, oracle adjustment, and payout all run inside one atomic `claim()`; proof failure rolls them back.
- `PostageStamp.withdraw()` and `PriceOracle.adjustPrice()` can perform unbounded downstream work.
- Round state is global and arrays are bulk-deleted on rollover, so spam can also grief the next round.

Proposed fix:

1. A **bounded online admission set** whose storage and per-call work are capped at all times.
2. **Participation finalization** that persists only objective non-reveal penalties.
3. Proof validation before disagreement penalties, oracle adjustment, or payout.
4. Current-round-only payout rights, retryable withdrawal, explicit deadlines, and an incentive to pay finalization gas.
5. Reported-depth and penalty-duration caps with checked arithmetic.

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

### 5. Unbounded-depth arithmetic surface

The contract accepts `uint8` reported depths without an explicit protocol maximum. Penalty expressions multiply `ROUND_LENGTH * 2 ** truthRevealedDepth`, and stake density multiplies `stake * 2 ** depthResponsibility`; extreme accepted values can panic on overflow.

This is not a cheap deterministic `depth == height` attack: `manageStake()` evaluates `MIN_STAKE * 2 ** height` even on a zero-amount update and itself reverts before a staker can set height near penalty-overflow levels. A higher reported depth also has to pass increasingly improbable proximity. Treat this as a defensive arithmetic/domain gap, not a demonstrated practical lock.

Defense: enforce protocol-level `MAX_REPORTED_DEPTH`, revalidate stake collateral on every height change, and cap/check stake-density and penalty-duration arithmetic. Do not rely only on incidental overflow in another contract to define valid protocol depths.

### 6. False-truth penalty amplification

Attack: malicious revealers submit a fabricated tuple that wins the truth lottery.

Effect: proof verification fails and rolls back disagreement freezes, so a fabricated truth can block payout without penalty.

Defense: non-reveal penalties may be persisted before proof validation because non-participation is objective. Disagreement penalties and oracle adjustment must wait until the selected truth has passed an objective proof.

### 7. Price-oracle griefing

`redundancyCount` counts revealers matching the selected exact `(hash, depth)` tuple. A successful claim/finalization after skipped rounds causes `PriceOracle.adjustPrice()` to apply the maximum increase once for every skipped round.

Therefore repeated claim suppression can later produce a compounded price increase **and unbounded catch-up work**: `adjustPrice()` loops once per skipped round. A sufficiently long gap can make every retry OOG or overflow.

The current oracle also updates `currentPriceUpScaled` and `lastAdjustedRound` before calling `PostageStamp.setPrice()`. If that call returns false, oracle state remains advanced while postage price is stale, and same-round retry reverts `PriceAlreadyAdjusted`.

Defense: a fabricated but unproved truth must not adjust the oracle. Replace per-skipped-round looping with an O(1)/strictly bounded catch-up policy with specified rounding and saturation, and make the oracle/postage transition atomic or expose an idempotent resynchronization operation.

### 8. Randomness and ordering influence

Truth selection uses deterministic hashes keyed by commit-array position. The seed is updated on the first successful reveal, using `block.prevrandao`; it is not updated after every reveal. This creates first-revealer timing and block-producer influence, while commit ordering changes the lottery inputs.

The disagreement penalty also evaluates the same `block.prevrandao % 100` for every revealer in one transaction. Below 100, penalties are cohort-correlated (all eligible disagreeing revealers pass the random check or none do), not independent per participant.

Do not reuse this construction for admission without a separate analysis. Admission randomness must not include user-grindable fields such as `_obfuscatedHash` or reveal nonce, and its bias/order properties must be specified and tested. If probabilistic disagreement penalties remain, derive a domain-separated value per participant from committed entropy rather than reusing one block value for the whole cohort.

### 9. Downstream batch-expiry gas lock

Even if commit processing is capped, the current `PostageStamp.withdraw()` is not bounded. It calls `totalPot()`, which calls `expireLimited(type(uint256).max)` and loops over every expired batch.

Many batches expiring together can make settlement exceed its current-round deadline. The mitigation must bound the entire call graph and remove the checkpoint-to-withdraw race: reserve an immutable amount, or atomically finish the last bounded expiry step and withdraw that exact amount.

### 10. Oversized proof calldata

Each claim proof contains dynamic Merkle arrays, dynamic signatures, and a dynamic `SOCProof[]`. Proof helpers iterate caller-supplied array lengths, while only the first SOC proof is consumed.

An arbitrary caller can submit oversized shapes that waste its own gas, but canonical bounds are still required for predictable relayer estimation, RPC acceptance, and protocol-level worst-case guarantees. Require exact proof depths, exact signature lengths, and `socProof.length <= 1` before expensive hashing.

### 11. Cross-contract pause/migration penalty evasion

Staking and Redistribution pause independently. While Staking is paused, `migrateStake()` deletes a participant's stake; a later `freezeDeposit()` silently does nothing when that stake no longer exists.

A participant represented by a selected commit snapshot can therefore escape a later obligation if migration is allowed before the round becomes terminal. Coordinate pause/cutover state, or make migration reject stakes referenced by unresolved rounds and preserve penalty obligations during migration.

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

Re-measure after contract, compiler, or proof-shape changes. Cold/warm storage, calldata size, external-call costs, the commit-phase block budget, and the chain's current block gas limit can shift coefficients.

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

The package has four layers:

```
bounded eligibility and arithmetic
        +
bounded online admission
        +
objective participation finalization
        +
proof validation before subjective penalties, oracle update, and payout
```

This package bounds gas and safely persists non-reveal penalties. It deliberately does not claim that fabricated reveals are solved: if false reveals must be prevented from suppressing every payout, reveal-time validity proof or a separately audited bounded fallback protocol is required.

---

## Penalty gaps in the current contract

Penalties are the main reason a capped sybil farm cannot attack every round cheaply. Today there are five gaps that break that story.

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

### Gap 4: disagreement penalties require validated truth

Failure to reveal is objective after the reveal deadline. Disagreement is relative to a lottery-selected tuple that may be fabricated and cannot pass storage proofs.

Only non-reveal penalties belong in proof-independent finalization. Disagreement penalties and oracle adjustment require a validated truth.

### Gap 5: payout failure is currently treated as success

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

Use explicit current-round state and three stages.

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

Invalid proofs revert only this transaction. Because anyone can submit `verifyWinner()` with deliberately invalid calldata, a failed transaction is not evidence that the selected winner cheated and must never directly slash/freeze the winner. A timeout bond can penalize non-delivery at the deadline if that rule is specified in advance.

Persist the round's reveal anchor, proof-selection seed, winner/truth, and canonical proof parameters; never read mutable globals from a later phase. Postage batches can expire and be deleted before a delayed proof is checked, so either snapshot/historically prove stamp validity at the protocol-defined reference block or make the proof deadline/expiry rules guarantee equivalent immutable context. A short deadline alone is not protection against permissionless early expiry.

Reject non-canonical proof shapes before expensive work: exact Merkle path lengths, exact signature sizes, and at most one SOC attachment.

### 3. `settleRound(uint64 round)`

After successful proof validation:

```solidity
require(truthValidated)
apply bounded disagreement penalties
adjust oracle using validated redundancy
withdraw the current pot to the stored winner
mark settled only after withdrawal succeeds
```

Oracle calls need explicit failure semantics so an integration failure cannot erase objective non-reveal penalties. A Redistribution-side retry flag alone is insufficient with the current oracle transition. Payout failure must revert settlement or remain retryable.

This requires changes below Redistribution:

- `PriceOracle.adjustPrice()` must not leave `lastAdjustedRound` advanced when `PostageStamp.setPrice()` failed, unless an idempotent sync operation can complete that exact transition later.
- Skipped-round catch-up must be O(1) or strictly bounded; the current loop over every skipped round is attacker-amplifiable.
- `PostageStamp.withdraw()` must not call an unbounded `expireLimited(type(uint256).max)` sweep. Settlement must consume an immutable reserved/checkpointed amount, or perform the final bounded expiry step and withdrawal atomically. A prior "clean" checkpoint alone is racy because another batch can expire before withdrawal.

### Deadlines and global-pot safety

`PostageStamp.withdraw()` transfers the entire pot at call time; it does not escrow a round-specific amount. Therefore a stale finalized winner must not be allowed to claim in a later round after more value accrued.

Use one of these audited models:

1. **Current-round-only rights:** all three stages have deadlines inside the current claim phase. An unpaid reward expires at rollover and the pot carries forward. Past rounds cannot call `withdraw()`.
2. **Escrowed round amount:** snapshot and reserve an amount in PostageStamp, then expose amount-bounded withdrawal. This requires a PostageStamp protocol change.

Storing `finalized[round]` while calling the current global `withdraw()` later is unsafe.

The design requires an explicit bounded `RoundState` record containing phase/status, reveal anchor, proof seed, tentative/validated truth, winner, and payment status. New rounds must not alias singleton proof context. Cleanup must be generation-tagged, fixed-capacity, or cursor-bounded; never bulk-delete attacker-sized arrays.

### Finalization incentive

Permissionless does not mean someone will pay gas. `finalizeParticipation()`, especially the zero-reveal path, needs a keeper obligation or bounded caller bounty funded from commit bonds/protocol fees. Without this, the attacker can simply rely on nobody spending gas to freeze it.

### Gas statement

Set `MAX_COMMITS` only after fork benchmarks prove every stage and downstream call fits with margin at N = MAX. The ~2.9M figure above is an estimate for the current atomic `claim()` at N = 100; benchmark the staged implementation separately with worst-case capped batch expiry and maximum skipped-round catch-up.

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
- Keep bond escrow only for the K currently selected slots. Refund an eviction synchronously in that eviction transaction (with checks-effects-interactions/reentrancy protection); do not create permanent per-evictee credits.
- Bound auxiliary mappings and define cleanup. A fixed array plus an ever-growing "seen candidate" mapping is not bounded.

The seed is known during commit in the simple online model. That permits mature identities to decide whether their fixed overlay has a favorable ticket, but avoids transaction-order dependence and arbitrary nonce grinding. If unpredictability until cutoff is required, use a VRF/commitment design with a separately proven bounded data path.

Weighted admission improves proportional fairness; it does not guarantee an honest node a slot. Inclusion probability depends on honest weight versus total admitted attacker weight.

### Optional: commit bond

For extra protection on the zero-reveal path and to fund finalization:

```
commit() locks bond
  → held only while the candidate occupies one of K bounded slots
  → synchronously refunded if evicted; failed refund reverts replacement
  → refunded on valid reveal under the specified policy
  → forfeited if a selected participant does not reveal by deadline
  → bounded portion funds the finalizer bounty
```

Do not create pull-refund credits for every evicted candidate: candidate count is unbounded, so those credits recreate unbounded storage. Keep at most K bond records and clear them by a fixed deadline. The exact amount needs an economic model; illustrative values are not a specification. A bond addresses non-reveal and finalizer incentives but does not prove that a fabricated reveal is valid.

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

**4. Staking:** validate the resulting post-state on every height change, including `_addAmount == 0`: `potentialStake >= MIN_STAKE * 2^newHeight`. Specify whether `committedStake` is recomputed at the current oracle price; do not leave this to implementer interpretation. Use checked bounds before exponentiation.

**5. Arithmetic:** define `MAX_STAKE_HEIGHT`, `MAX_REPORTED_DEPTH`, `MAX_DEPTH_RESPONSIBILITY`, and `MAX_PENALTY_BLOCKS` from protocol limits. Use checked helper functions for weight/stake-density and penalty duration. Reject values outside the domain rather than allowing arithmetic panics to decide eligibility.

**6. Stake state:** ensure selected participants cannot withdraw or mutate stake/overlay/height during their obligation window. Snapshot values for selection, but apply penalties to the same owner/stake identity that created the commit.

**7. Objective validity:** if all-revealing fabricated cohorts are in scope, require a bounded reveal-time sample/validity proof or design a timeout-and-fallback mechanism. This is a required liveness decision, not an optional hardening item.

**8. Pause and migration:** unresolved round obligations survive coordinated pauses and stake migration. A migration cannot delete the target of a future freeze.

---

## How the mitigation package handles each attack

`MAX_COMMITS` remains a placeholder until measured. The examples below use K selected participants, not an assumed safe value of 100.

### Zero reveal

- Bounded admission limits work to K.
- `finalizeParticipation()` freezes all selected non-revealers and closes the round.
- This defense depends on a keeper/bounty actually causing finalization.
- The pot carries forward; there is no winner for that round.

### Commit/reveal gas grief

- Online admission keeps storage and each later scan bounded by K.
- Fork benchmarks must cover worst-case K external freeze calls and not only happy-path proof verification.

### Commit-only sybils plus one valid honest reveal

- Participation finalization persists non-reveal freezes.
- Honest proofs validate the truth; settlement can then apply disagreement policy, update the oracle, and pay.
- Admission remains probabilistic: this outcome assumes the honest node was selected.

### Commit-only sybils plus one fabricated reveal

- Non-reveal sybils are frozen during participation finalization.
- The fabricated tuple remains tentative and cannot freeze honest disagreeing revealers or update price.
- Proof validation fails, so there is no payout.

### All selected sybils reveal the same fabricated tuple

- Gas is bounded, but there are no non-reveal penalties.
- Proof validation fails, and the current-round payout expires.
- The same capital can repeat after paying gas because no disagreement has been objectively established.

This is a remaining liveness attack. A floor, stake-weighted admission, and staged finalization do not solve it. Require reveal-time objective validity, a meaningful timeout bond on the selected proof provider, or a bounded fallback that can move to another objectively validated candidate.

### Slot filling

- FCFS allows transaction-speed exclusion.
- Bounded stake-weighted admission makes selection depend on fixed identity and objectively locked stake rather than arrival order.
- It does not guarantee honest inclusion. A coalition with sufficient total weight can occupy all K positions.

### Extreme-depth arithmetic

- Explicit height/depth/responsibility/penalty caps reject the input before exponentiation.
- Tests exercise every maximum and one-above-maximum value.

### Skipped-round oracle and expired-batch backlog

- The cap on commits does not bound downstream loops.
- Oracle catch-up uses a bounded policy rather than one iteration per missed round.
- Batch expiry is processed in capped calls and settlement atomically consumes an immutable amount; it never performs an unlimited or racy sweep.
- Oracle/postage price synchronization is atomic or idempotently repairable.

### Rollover, proof shape, and stake migration

- Fixed-cap/generation-tagged state prevents dynamic-array deletion from becoming the next-round DoS.
- Canonical proof-shape checks bound calldata and hashing work.
- Coordinated pause/migration rules preserve unresolved freeze and payout obligations.

### Sybils with real storage and valid proofs

If sybils actually satisfy objective storage and reveal requirements, they are protocol participants rather than the cheap fake-hash grief considered here. Admission fairness and stake centralization remain economic/governance questions.

### Sustained multi-round attack

Non-reveal attacks consume fresh or frozen capital once finalization is incentivized. All-reveal fabricated attacks do not, unless validity/bond/fallback rules add a penalty. State both cases separately; it is incorrect to claim every successful attack round becomes progressively more expensive.

---

## Round flow (recommended)

1. Governance sets bounded floor/depth/penalty parameters.
2. Commit phase: `commit(hash, round, depth)` validates stake age, collateral, depth, proximity, and computes a fixed-identity weighted priority.
3. The fixed-cap online structure admits or evicts in bounded work.
4. At commit cutoff, selected status is final and queryable.
5. Reveal phase: only selected records reveal; the round-versioned floor, declared depth, and all eligibility snapshots are checked.
6. Early claim phase: `finalizeParticipation(round)` applies only non-reveal penalties and stores tentative truth/winner.
7. Proof window: `verifyWinner(round, proofs)` marks the truth valid only after all current proof checks pass.
8. Settlement window: after bounded oracle catch-up, atomically consume an immutable Postage checkpoint/reservation (or atomically complete the last bounded expiry step), apply disagreement penalties, synchronize price, and withdraw exactly that amount. Mark settled only after payout succeeds.
9. At rollover, current-round payout rights expire unless PostageStamp was redesigned to escrow a round-specific amount. Bounded old metadata may be cleaned; no stale winner may withdraw the future global pot.

---

## Required decisions before implementation

- Exact `MAX_COMMITS` from complete-round Gnosis fork benchmarks with safety margin
- Exact weighted-priority algorithm and fixed-seed bias/grinding analysis
- Maximum stake height, reported depth, responsibility, and penalty duration
- Exact Staking post-state invariant and committed-stake recomputation rule on height change
- Future-round activation and emergency-decrease rules for governed floor changes
- Claim-phase sub-deadlines with enough retry blocks for proof and settlement
- Immutable stamp/proof reference context and canonical proof-shape limits
- Finalizer/keeper incentive and bond accounting
- Objective-validity approach for all-reveal fabricated tuples
- Oracle failure policy and retry/skip observability
- Bounded skipped-round price catch-up with explicit rounding/saturation semantics
- Immutable/atomic Postage expiry checkpoint and amount-bounded withdrawal
- Current-round expiry versus PostageStamp round-amount escrow
- Timeout consequence for a selected winner; failed arbitrary calldata must not count as winner fault
- Coordinated pause/migration behavior for unresolved participant obligations
- Fixed-cap/generation-tagged round-state retention and cleanup
- Multi-contract deployment cutover: active-round handling, state continuity, role grants verified before old-role revocation, and fail-closed post-deploy assertions

---

## Implementation order

1. Add regression tests reproducing zero-reveal, proof rollback, false-truth disagreement freeze, depth-boundary arithmetic, stale payout, withdrawal failure, rollover cleanup, oversized proofs, floor changes between phases, and pause/migration cases.
2. Add reproducible complete-round gas benchmarks on a current Gnosis-compatible fork.
3. Specify and test bounded online stake-weighted admission independently, including eviction, identity grinding, capital splitting, cleanup, and maximum K.
4. Bound PriceOracle skipped-round catch-up and make oracle/Postage synchronization atomic or idempotently repairable.
5. Add immutable/atomic bounded Postage expiry checkpointing and amount-bounded withdrawal so settlement never performs an unlimited or racy batch sweep.
6. Add depth/collateral/arithmetic bounds in Staking and Redistribution.
7. Add `Commit.declaredDepth`, eligibility snapshots, and bounded admission.
8. Implement `finalizeParticipation`, `verifyWinner`, and retry-safe settlement with current-round deadlines.
9. Add finalizer incentives and bounded-slot bond accounting.
10. Implement the chosen objective-validity/fallback defense before claiming fake-truth liveness.
11. Update ABI consumers: Bee/client, docs/examples, deployment JSON/codegen, `isWinner` semantics, events/errors, tests, and Echidna harnesses.
12. Execute a fail-closed multi-contract cutover: handle the active round; preserve required pot/oracle/stake state; grant and verify Postage `REDISTRIBUTOR_ROLE` → new Redistribution, Staking `REDISTRIBUTOR_ROLE` → new Redistribution, PriceOracle `PRICE_UPDATER_ROLE` → new Redistribution, and Postage `PRICE_ORACLE_ROLE` → new PriceOracle; then revoke every corresponding old Redistribution/oracle edge and assert the complete role graph.

---

## Related code and docs

- [`Redistribution.sol`](../src/Redistribution.sol): `commit()`, `reveal()`, `claim()`, `winnerSelection()`
- [`Staking.sol`](../src/Staking.sol): `MIN_STAKE`, `freezeDeposit()`, `manageStake()`
- [MINIMUM_DEPTH_OPTIONS.md](./MINIMUM_DEPTH_OPTIONS.md): depth floor policy
- [REDISTRIBUTION.md](./REDISTRIBUTION.md): game overview

## Status

Proposed mitigation architecture. Not yet implemented in the contracts.
