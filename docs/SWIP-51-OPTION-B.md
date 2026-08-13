# SWIP-51 Option B — Redistribution changes (pre-PR)

Branch: `feat/swip-51-option-b`  
Spec: [SWIP-51](https://github.com/ethersphere/swip-51/blob/main/swip-51.md)  
Claim path: **Option B** — keep a single atomic `claim()`, ship shared §4.1 + Layer 2 now; leave B1 / STS to **SWIP-49 + SWIP-50** later.

This document is the detailed change note for reviewers and Bee implementers. It is not a substitute for the attack catalog in SWIP-51; it describes what landed in this repo and what clients must change.

---

## Summary

| Area | Change |
|------|--------|
| Claim UX | Still one `claim(proofs…)` call (Option B). No `verifyWinner` / `settleRound`. |
| Participation | Layer 2 close inside `claim()` and the **commit gate** on the next round’s first `commit`. No permissionless closer. |
| Commit API | **Breaking:** `commit(obfuscatedHash, round, depth)` — depth declared and proximity checked at commit. |
| Cap | `MAX_COMMITS = 128` with stake-weighted online admission (lower priority wins). |
| Depth floor | Winner-derived `currentMinimumDepth()` remains **removed** (no floor jacking). |
| Payout | Failed pot withdraw reverts the whole `claim()` (no pay, no claim). Replay `claim()` if it was transient. |
| Deferred | Proof-before-selection / round-scoped postage (SWIP-49/50). Truth-poison coalition worst case still open. |

---

## Why Option B

SWIP-51 offers two Layer-3 claim paths after a shared package:

- **Option A** — split claim into `finalizeParticipation` → `verifyWinner` → `settleRound` (fixes penalty rollback now).
- **Option B** — keep one `claim()`; fix B1 later via STS / proof-before-selection (SWIP-49/50).

This branch implements **Option B** plus the **shared §4.1** Redistribution package (admission, eligibility, Layer 2 gate, atomic payout). The §4.1 staking height-min rule is **not** in this PR — `StakeRegistry` is unchanged; that lands with the upcoming staking rewrite. Bee keeps a single claim transaction for payout; it must still learn the new commit signature and that skipped/failed claims are closed by the next round’s first commit.

```text
  Layer 1 — SHARED (§4.1)          ← implemented
  MAX_COMMITS · eligibility · fixed-cap clear · atomic withdraw · commit gate
           │
  Layer 2 — PARTICIPATION CLOSE    ← implemented (internal)
  _finalizeParticipation from claim() or next commit
           │
  Layer 3 — Option B               ← implemented (atomic claim)
  claim(proofs…) — withdraw must succeed
           │
  Later — SWIP-49 / SWIP-50        ← not in this branch
```

---

## Round lifecycle (new)

```text
Round R commit
  → first commit in R may finalize R−1 (gate)
  → eligibility + stake-weighted admission (≤ MAX_COMMITS)

Round R reveal
  → depth must equal declaredDepth
  → proximity re-checked against reveal anchor

Round R claim
  → _finalizeParticipation(R) if not done
      • freeze all non-revealers (uses declaredDepth)
      • if reveals exist: store tentative truth + winner + redundancy
  → claim(proofs):
      • verify proofs against stored winner
      • apply disagree penalties
      • adjust oracle
      • withdraw pot — if this reverts, the whole claim rolls back

Round R+1 commit
  → must finalize R if still open (gate), then admit into R+1
```

Zero-reveal rounds: `claim()` reverts `NoReveals()`. The next round’s first `commit` freezes every admitted non-revealer, marks participation closed, and the pot carries.

---

## Contract changes

### `Redistribution.sol`

#### Breaking API

| Before | After |
|--------|--------|
| `commit(bytes32 obfuscatedHash, uint64 round)` | `commit(bytes32 obfuscatedHash, uint64 round, uint8 depth)` |
| Proximity only at reveal | Proximity at **commit** (commit-phase anchor) and again at reveal (reveal-phase anchor) |
| Depth chosen only at reveal | Depth **declared at commit**; reveal must match (`DepthMismatch`) |
| `depth == height` allowed (proximity always true) | **`depth > height` required** (`DepthNotGreaterThanHeight`) |
| Unbounded `currentCommits` | Cap `MAX_COMMITS = 128`; eviction by stake-weighted priority |
| `Committed(round, overlay, height)` | `Committed(round, overlay, height, depth)` |
| Penalties + proofs + payout in one reverting `claim` path | Non-reveal freezes in `_finalizeParticipation` (from `claim` or next `commit`); proofs then disagree then payout in `claim` |
| Failed `withdraw` still left round “done” via selection path | Failed withdraw reverts `claim()`; replay the same call. No `retryPayout`. |

#### New / notable functions

| Function | Role |
|----------|------|
| `admissionPriority(round, seed, overlay, stake)` | View/pure helper: `keccak256(round, seed, overlay) / max(stake, 1)` — **lower is better**. |
| `participationFinalized(round)` | Whether Layer 2 ran for that round (`claim` or the next `commit` gate). |

#### New events

- `ParticipationFinalized(uint64 roundNumber, uint256 revealCount)`
- `CommitSelected(uint256 roundNumber, bytes32 overlay, uint8 height, uint8 depth, uint256 priority)`
- `CommitEvicted(uint256 roundNumber, bytes32 overlay)`
- `CommitRejected(uint256 roundNumber, bytes32 overlay)` — admission full and newcomer not better; **tx does not revert** (so a prior finalize in the same tx still sticks)

#### New errors (client-facing)

- `DepthNotGreaterThanHeight`
- `OutOfDepth` — commit-time proximity failure
- `DepthMismatch` — reveal depth ≠ `declaredDepth`
- `NoWinner` / `ParticipationNotFinalized` — reserved / used where applicable

#### Admission rule (stake-weighted)

1. Eligible commits enter until `length == MAX_COMMITS`.
2. When full, find worst slot: highest `priority`, tie-break higher `uint256(overlay)`.
3. Replace only if newcomer is **strictly better**; else emit `CommitRejected` and return (no revert).
4. Weight is snapshotted effective stake at commit; depth/proximity are eligibility only, not weight.

`MAX_COMMITS = 128` is a placeholder until Gnosis fork benchmarks (see SWIP-51). Treat it as a hard protocol constant for Bee until governance/redeploy changes it.

#### `claim()` behaviour (Option B)

1. Require claim phase.
2. If needed, `_finalizeParticipation(cr)` (non-reveal freezes + tentative winner).
3. Require reveals for this round; not already claimed.
4. **Proofs first** against stored `winner`.
5. Apply disagreement freezes.
6. `OracleContract.adjustPrice(lastRedundancyCount)`.
7. `PostageStamp.withdraw(winner.owner)` — reverts the whole `claim` on failure.
8. Set `currentClaimRound`, emit `WinnerSelected` / `ChunkCount`.

Disagree penalties sit in the same tx as proofs and payout; full “proof-before-selection” weight (B1 via STS) waits for SWIP-50. If `claim` reverts (bad proofs or failed withdraw), nothing from that tx sticks; the next round’s first `commit` still freezes non-revealers.

#### Removed / not reintroduced

- Winner-derived `currentMinimumDepth()` — not restored (floor jacking). Near-term: no on-chain floor; eligibility is `depth > height` + proximity. See `MINIMUM_DEPTH_OPTIONS.md`.
- `StakeRegistry` / `manageStake` min-stake-on-height-change — **deferred** to the staking rewrite.

---

## What Bee must change

### 1. Commit transaction (required, breaking)

```text
Old: redistribution.commit(obfuscatedHash, round)
New: redistribution.commit(obfuscatedHash, round, depth)
```

- Choose **storage depth before commit** (same depth later used in `wrapCommit` / reveal).
- Enforce locally: `depth > height`.
- Enforce locally: overlay in proximity of **commit-phase** `currentRoundAnchor()` with `depthResponsibility = depth - height`.
- Do **not** commit at `depth == height` — chain rejects it.
- Listen for `CommitSelected` / `CommitEvicted` / `CommitRejected`. If rejected, the node is **not** in the round (no reveal obligation from an admission that never stuck); gas was still spent.

### 2. Reveal (required)

- Reveal depth **must equal** commit `declaredDepth`.
- Re-check proximity against **reveal** anchor (`currentRevealRoundAnchor` after first reveal).
- Wrong depth → `DepthMismatch` (checked before hash mismatch).
- Wrong nonce/hash with matching depth → `NoMatchingCommit`.

### 3. Events / indexing

| Event | Bee use |
|-------|---------|
| `Committed(..., depth)` | Extra indexed field vs old ABI — update decoders. |
| `CommitSelected` | Confirm admission into the capped set. |
| `CommitEvicted` | Previously selected overlay lost its slot — stop planning reveal for that identity. |
| `CommitRejected` | Not admitted; do not reveal. |
| `ParticipationFinalized(round, revealCount)` | Round participation closed; non-revealers frozen. |

### 4. Claim path (mostly same UX)

- Still submit one `claim(entryProof1, entryProof2, entryProofLast)` with inclusion / stamp / SOC proofs for the **stored winner**.
- There is **no** separate `finalizeParticipation` or `retryPayout`. `claim()` finalizes if needed and must withdraw successfully; skipped or failed claims are closed by the next round’s first `commit`.
- If `claim` reverts on withdraw, replay `claim()` in the same claim phase. Nothing from the failed tx is persisted.

### 5. Eligibility helpers

- `isParticipatingInUpcomingRound(owner, depth)` returns `false` if `depth <= height` (does not revert for that case).
- Local pre-checks should mirror on-chain: maturity (2 rounds), depth, proximity to the correct phase anchor.

### 7. ABI / bindings

Regenerate Go bindings (or equivalent) from the new `Redistribution` ABI. Old 2-arg `commit` will not exist on the new deployment. `StakeRegistry` is unchanged.

### 6. Operational notes for node operators

- First committer of a new round may pay **finalize gas** for the previous round (O(`MAX_COMMITS`) freezes). Acceptable while K is bounded.
- A node that committed but was **evicted** must not expect to reveal or win.
- After a non-reveal freeze, effective stake is zero until the freeze window ends; the freeze also bumps `lastUpdatedBlockNumber`, so the usual two-round wait applies before the next commit.
- `MAX_COMMITS = 128` means a neighbourhood can be capacity-constrained; higher stake improves admission odds but does not guarantee a slot.

### 7. Out of scope for Bee in this release

- SWIP-49 round-scoped postage / price-after-proofs.
- SWIP-50 STS-1 proof-before-selection weights / unfinished-commit carry-over.
- On-chain adaptive depth floor (Option E in `MINIMUM_DEPTH_OPTIONS.md`).
- Reveal-time hash validity / claim-window timeout for the all-sybil fabricated-hash coalition.
- `MIN_STAKE * 2^height` on every `manageStake` (staking rewrite).

---

## Attack / defect coverage (this branch)

| ID | Issue | Status on this branch |
|----|--------|------------------------|
| 1 / B3 | Claim gas grief / unbounded commits | Mitigated: `MAX_COMMITS` + bounded clears |
| B4 / commit-only stall | Optional finalize, no freezes | Mitigated: Layer 2 + commit gate |
| 2 / B1 | Truth poison / penalty rollback | Partially: non-reveal freezes persist on the next `commit` gate; a reverting `claim` still undoes freezes from that tx. Disagree still after proofs in `claim`. Full fix → SWIP-50 |
| 2 worst case | All admitted sybils same fake hash | **Open** (needs validity / timeout) |
| 3 | Floor jacking | Mitigated: no winner-derived floor |
| B2 | Payout failure treated as success | Mitigated: failed withdraw reverts `claim()` (no pay, no claim). Replay `claim()`. |

---

## Test coverage

- Existing Redistribution suite updated for 3-arg `commit` and new `Committed` args.
- New `SWIP-51 Option B` block: depth≤height reject, `DepthMismatch`, commit-gate freezes non-revealers, `admissionPriority` stake effect.
- Intentionally skipped: bee SOC fixture at depth 0; Stats 1:3 fairness sim (needs depth≥1 remine).

---

## Commits on this branch (implementation)

```text
2a60202 feat(redistribution): implement SWIP-51 Option B
756e5c0 fix(redistribution): check declaredDepth before wrapCommit match
f2efa6b test: cover SWIP-51 Option B eligibility, finalize, and gate
```

(Plus earlier docs on `fix/minimal_depth_resolve`: admission comparison, minimum-depth options, spam/griefing notes, removal of `currentMinimumDepth`.)

---

## Suggested PR blurb (when opened)

**Title:** feat(redistribution): SWIP-51 Option B shared package + Layer 2  

**Body sketch:**

- Implement SWIP-51 §4.1 (MAX_COMMITS, commit-time eligibility, stake-weighted admission, atomic withdraw) and Layer 2 close via `claim()` plus the next-round commit gate.
- Keep single-transaction `claim()` (Option B); defer STS / postage redesign to SWIP-49/50.
- Breaking Bee API: `commit(..., depth)`; reveal must match declared depth.

**Test plan:**

- [ ] `npx hardhat test test/Redistribution.test.ts`
- [ ] Bee integration: commit with depth, reject depth≤height, reveal match, claim
- [ ] Confirm event ABI consumers updated for `Committed` + admission events

---

## Related docs

- [SPAM_GRIEFING.md](./SPAM_GRIEFING.md) — threat model and staged-finalization design notes  
- [ADMISSION_COMPARISON.md](./ADMISSION_COMPARISON.md) — proximity vs stake-weighted admission  
- [MINIMUM_DEPTH_OPTIONS.md](./MINIMUM_DEPTH_OPTIONS.md) — floor policy (Option A = none near term)  
- [REDISTRIBUTION.md](./REDISTRIBUTION.md) — general contract overview (update in follow-up if needed to match this branch)
