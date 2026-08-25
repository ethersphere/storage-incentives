# SWIP-51 Option B — Redistribution changes

Spec: [SWIP-51](https://github.com/ethersphere/swip-51/blob/main/swip-51.md)  
Claim path: **Option B** — keep a single atomic `claim()`, ship shared §4.1 + Layer 2 now; leave B1 / STS to **SWIP-49 + SWIP-50**.

This is the Bee / implementer note for what landed in this repo. The attack catalog and design options stay in SWIP-51 (including [admission comparison](https://github.com/ethersphere/swip-51/blob/main/docs/ADMISSION_COMPARISON.md) and [depth-floor options](https://github.com/ethersphere/swip-51/blob/main/docs/MINIMUM_DEPTH_OPTIONS.md)).

Contract overview: [REDISTRIBUTION.md](./REDISTRIBUTION.md).

## Summary

| Area | Change |
|------|--------|
| Claim UX | Still one `claim(proofs…)` call (Option B). No `verifyWinner` / `settleRound`. |
| Participation | Layer 2 close inside `claim()` and the **commit gate** on the next round’s first `commit`. |
| Commit API | **Breaking:** `commit(obfuscatedHash, round, depth)` — depth declared and proximity checked at commit. |
| Cap | `MAX_COMMITS = 128` with stake-weighted online admission (lower priority wins). |
| Depth floor | Winner-derived `currentMinimumDepth()` remains **removed** (no floor jacking). |
| Payout | Failed pot withdraw reverts the whole `claim()` (no pay, no claim). Replay `claim()` if it was transient. |
| Deferred | Proof-before-selection / round-scoped postage (SWIP-49/50). Truth-poison coalition worst case still open. `StakeRegistry` height-min is not in this PR. |

## Round lifecycle

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

## Breaking API (`Redistribution.sol`)

| Before | After |
|--------|--------|
| `commit(bytes32 obfuscatedHash, uint64 round)` | `commit(bytes32 obfuscatedHash, uint64 round, uint8 depth)` |
| Proximity only at reveal | Proximity at **commit** and again at reveal |
| Depth chosen only at reveal | Depth **declared at commit**; reveal must match (`DepthMismatch`) |
| `depth == height` allowed | **`depth > height` required** (`DepthNotGreaterThanHeight`) |
| Unbounded `currentCommits` | Cap `MAX_COMMITS = 128`; eviction by stake-weighted priority |
| `Committed(round, overlay, height)` | `Committed(round, overlay, height, depth)` |
| Failed `withdraw` still left round “done” | Failed withdraw reverts `claim()`. No `retryPayout`. |

Notable helpers / events: `admissionPriority` (lower is better), `participationFinalized`, `CommitSelected` / `CommitEvicted` / `CommitRejected`. `CommitRejected` does **not** revert the tx (so a prior-round finalize in the same tx still sticks).

Admission: eligible commits enter until `length == MAX_COMMITS`; when full, replace the worst slot only if the newcomer is strictly better. Weight is snapshotted effective stake; depth/proximity are eligibility only. `MAX_COMMITS = 128` is a placeholder until Gnosis fork benchmarks (see SWIP-51).

## What Bee must change

### 1. Commit (required, breaking)

```text
Old: redistribution.commit(obfuscatedHash, round)
New: redistribution.commit(obfuscatedHash, round, depth)
```

Before sending the tx: pick storage depth (same value later used in `wrapCommit` / reveal); require `depth > height`; require overlay in proximity of the **commit-phase** `currentRoundAnchor()` with `depthResponsibility = depth - height`; confirm two-round stake wait; do not send in the last block of commit phase.

Once the set is full (`MAX_COMMITS = 128`):

- `CommitSelected` — this overlay is in the round. Plan to reveal.
- `CommitEvicted` — stop planning reveal for that identity; no reveal obligation.
- `CommitRejected` — not in the round. Gas was still spent. Do not reveal. Treat as “not participating,” not as a failed transaction.
- `Committed` now includes `depth`. Update decoders.

If this node is the **first committer of a new round** after a skipped or failed claim, the tx may freeze up to 128 non-revealers from the previous round. Set a high gas limit on commit.

### 2. Reveal

- Reveal depth **must equal** the depth declared at commit (`DepthMismatch`, checked before hash mismatch).
- Re-check proximity against the **reveal** anchor.
- Only reveal if this overlay still has `CommitSelected` and was not later `CommitEvicted`.

### 3. Claim

- Still one `claim(entryProof1, entryProof2, entryProofLast)` with proofs for the **stored winner**.
- No `finalizeParticipation` and no `retryPayout`. If withdraw reverts, replay **`claim()`** in the same claim phase.
- Skipped or failed claims are closed by the next round’s first `commit`.

### 4. Eligibility / ABI

- `isParticipatingInUpcomingRound(owner, depth)` returns `false` if `depth <= height` (does not revert for that case).
- Regenerate Go bindings from the new `Redistribution` ABI. Old 2-arg `commit` will not exist. `StakeRegistry` is unchanged.
