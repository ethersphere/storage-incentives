# Redistribution: Spam and Griefing Threat Model

Threat model and proposed mitigations for sybil spam / griefing against `Redistribution.sol`. Standards track: [SWIP-51](https://github.com/ethersphere/SWIPs). Depth floors: [MINIMUM_DEPTH_OPTIONS.md](./MINIMUM_DEPTH_OPTIONS.md). Admission trade-offs: [ADMISSION_COMPARISON.md](./ADMISSION_COMPARISON.md).

**Scope:** honest nodes are playing. Empty rounds (nobody reveals) are not sybil grief — no honest participant is harmed.

---

## 1. Background

### Attacker model

- **Sybil farm:** many staked addresses, one commit per overlay per round (`AlreadyCommitted`), one reveal per commit (`AlreadyRevealed`).
- **Entry cost:** `MIN_STAKE * 2^height` (10 BZZ at height 0), two-round stake wait, commit/reveal gas. `manageStake()` resets the wait.
- **Commit vs reveal:** `commit()` has no proximity check; `reveal()` requires proximity. Cheapest path: `depth == height` (proximity always passes).
- **No real storage needed:** hashes are not checked against chunks until `claim()` proofs.
- **`claim()`:** permissionless — any caller with valid proofs pays gas; pot goes to `winner.owner`. Failed claim does **not** set `AlreadyClaimed`; anyone may retry until one succeeds. Junk proofs only burn caller gas and are **not** a standalone DoS.

### Where N hurts

| Phase  | Function            | Cost                |
|--------|---------------------|---------------------|
| Commit | overlay uniqueness  | O(n) / tx           |
| Reveal | `findCommit()`      | O(n) / tx           |
| Claim  | `getCurrentTruth()` | O(n)                |
| Claim  | `winnerSelection()` | O(n) + freeze calls |

Commit-only sybils are cheap in truth selection, expensive in `winnerSelection()` (`freezeDeposit()`). Bulk `delete currentCommits` on rollover can also grief the next round if N is unbounded.

### Gas and economics (illustrative)

```
G_claim(N) ≈ 450k + (N − 1) × 25k
```

| Limit | Context            | ~Sybils |
|-------|--------------------|---------|
| ~3M   | Wallet / RPC cap   | ~100    |
| ~17M  | Gnosis block limit | ~660    |

Examples: N = 100 → ~2.9M; N = 500 → ~12.9M; N = 660 → ~17M.

Commit-phase attacker cost is O(N²) — partial deterrent, not protection for the single `claim()` tx. ~100 sybils ≈ 1,000 BZZ locked; ~660 ≈ 6,600 BZZ. If every claim is blocked, no freeze applies (rollback bug). Benchmark on a Gnosis fork before setting `MAX_COMMITS`.

---

## 2. Attacks

| # | Name | Attacker action | Effect on honest nodes | Blocks payout when |
|---|------|-----------------|------------------------|--------------------|
| **1** | Claim gas grief | N commits + ≥1 reveal | `winnerSelection()` O(N); claim gas grows linearly | Gas exceeds tx/block limit; retries repeat full work |
| **2** | Truth poisoning | Fabricated `(hash, depth)` may win stake-weighted truth lottery | Honest proofs fail on selected hash | Proof revert rolls back entire `claim()` including penalties |
| **3** | Commit-only spam | Same as **1** with one revealer, N−1 commit-only | Same loop bloat | Same as **1** — not a separate vector |

**Attack 1:** Failed or OOG `claim()` reverts all freezes. One sybil reveal is enough to enter the claim path; attacker need not pass proofs.

**Attack 2:** Truth is a stake-density lottery keyed on commit index, not correctness. Sole sybil reveal wins truth deterministically; with multiple reveals, probabilistic. `reveal()` does not verify storage.

**Not an attack:** outsider submits bad proofs — burns own gas; round stays claimable. Matters only as the delivery of **B1** under attacks 1–2.

---

## 3. Current contract bugs

| ID | Bug | Symptom |
|----|-----|---------|
| **B1** | Penalties inside same tx as proofs | Proof / OOG failure reverts all `freezeDeposit()` and `currentClaimRound` |
| **B2** | Payout failure treated as success | `WithdrawFailed` emitted but round marked claimed; no retry |
| **B3** | Unbounded `currentCommits` | Claim and rollover scale with attacker-chosen N |

**Economic limitation (not a bug):** freeze is a time-lock, not a slash; capital returns after freeze + two rounds.

```solidity
function claim(...) external {
    winnerSelection();   // freezes + currentClaimRound
    // ... proofs (revert → full rollback)
    // ... withdraw pot
}
```

**Penalties today (only if full `claim()` succeeds):**

| Participant | Condition | Penalty |
|-------------|-----------|---------|
| Commit, no reveal | `!revealed` | Always frozen |
| Reveal, wrong truth | hash/depth ≠ truth | Frozen (`penaltyRandomFactor`) |
| Reveal, matches truth | exact match | None |
| Winner | bad proofs | Whole tx reverts; nobody penalized |

---

## 4. Proposed mitigations

```
bounded online admission (MAX_COMMITS)
        +
finalizeParticipation — persist non-reveal penalties
        +
verifyWinner → settleRound — proofs before subjective penalties, oracle, payout
```

Eligibility (depth floor, proximity, declared depth) raise sybil cost but do **not** cap N alone. Fabricated-hash coalitions still need reveal-time validity or timeout/fallback (out of scope for core package).

### 4.1 Staged claim finalization

| Step | Function | Persists on revert | Purpose |
|------|----------|-------------------|---------|
| 1 | `finalizeParticipation(round)` | **Yes** — non-reveal freezes | Tentative truth/winner; loop capped at K |
| 2 | `verifyWinner(round, proofs…)` | No | Chunk/stamp/SOC proofs; mark `truthValidated` |
| 3 | `settleRound(round)` | Retryable | Disagreement penalties, oracle, pot — only after success |

**Rules:**

- Step 1 must **not** freeze disagreeing revealers or adjust the oracle.
- Invalid `verifyWinner` calldata must not slash the winner (anyone can submit junk).
- Global `PostageStamp.withdraw()` → current-round-only payout rights or round escrow.
- Snapshot round context in `RoundState`; fixed-cap / generation-tagged storage — no bulk-delete of attacker-sized arrays.
- All steps inside the claim window; unpaid rights expire at rollover.

**Open:** step-1 incentive on empty rounds; optional `verifyAndSettle(proofs)` for steps 2–3.

### 4.2 Bounded admission (`MAX_COMMITS`)

Hard cap on selected commits. **Not FCFS** (sybils would race slots). Stake-weighted online selection:

```text
weight = objectivelyLockedEffectiveStake(owner)
entropy = H(domain, round, fixedRoundSeed, overlay)
priority = auditedWeightedPriority(entropy, weight)
```

Keep best K; O(log K) eviction per commit. Emit admission/eviction events. Set K after fork benchmarks with margin. Details: [ADMISSION_COMPARISON.md](./ADMISSION_COMPARISON.md).

### 4.3 Eligibility (supporting)

1. `commit(obfuscatedHash, round, depth)` — store `declaredDepth`; reveal must match.
2. Proximity, `depth > height`, depth floor — [MINIMUM_DEPTH_OPTIONS.md](./MINIMUM_DEPTH_OPTIONS.md).
3. Validate `potentialStake >= MIN_STAKE * 2^newHeight` on every height change.
4. Lock stake/overlay/height for selected participants until obligation ends.
5. **Separate (attack 2):** reveal-time validity sample or timeout/fallback.

### 4.4 Attack → mitigation map

| Attack | Primary fix | Also helps |
|--------|-------------|------------|
| Gas grief (1, 3) | `MAX_COMMITS` + staged loops | O(N²) commit cost (existing) |
| Truth poison (2) | Staging: non-reveal freezes persist when proofs fail | Eligibility |
| Penalty-free blocking (2) | Split proofs from `finalizeParticipation` | — |
| Fabricated-hash coalition (2) | **Not solved by core package** | Rule 4.3.5 |
| Rollover DoS | Fixed-cap state, no bulk delete | `MAX_COMMITS` |

---

## 5. Rationale

**Bounded admission, not only economic filters.** Floors and stake raise cost but cannot cap per-round work.

**Staged finalization.** Objective (did not reveal) before proofs; subjective (disagreement, oracle, payout) after validated truth. Fixes **B1** without letting false tentative truth punish honest revealers.

**Stake-weighted admission.** Aligns with truth-selection economics; proximity ranking compared in ADMISSION_COMPARISON.md.

**Current-round-only payout rights.** Global `withdraw()` must not let a stale winner drain a pot enlarged by later rounds.

**Out of scope for core package.** All-revealing fabricated-hash coalition still needs cryptographic reveal validity or audited timeout/fallback.

---

## Related

- [`Redistribution.sol`](../src/Redistribution.sol)
- [`Staking.sol`](../src/Staking.sol)
- [MINIMUM_DEPTH_OPTIONS.md](./MINIMUM_DEPTH_OPTIONS.md)
- [ADMISSION_COMPARISON.md](./ADMISSION_COMPARISON.md)
- [REDISTRIBUTION.md](./REDISTRIBUTION.md)

**Status:** proposed architecture; not implemented in production contracts.
