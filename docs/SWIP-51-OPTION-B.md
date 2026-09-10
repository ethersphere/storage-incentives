# SWIP-51 Option B — what actually landed in this contract

Bee / reviewer note for **this repo**. Attack catalog and design options stay in [SWIP-51](https://github.com/ethersphere/swip-51/blob/main/swip-51.md). Contract overview: [REDISTRIBUTION.md](./REDISTRIBUTION.md).

Claim path: **Option B** — still one `claim()`. Shared admission + automatic participation close ship now. Proof-before-selection (B1 / STS) waits for **SWIP-49 + SWIP-50**.

## Read this first

Bee still calls the same three functions: `commit` → `reveal` → `claim`. There is **no new public function** to “finalize” a round.

| SWIP-51 name | In this contract? | What Bee does |
|--------------|-------------------|---------------|
| `commit(hash, round, depth)` | **Yes — new ABI** | Call this. Depth is now required. |
| `reveal` / `claim` | Yes — same names | Still call these. Reveal depth must match commit. |
| `finalizeParticipation(round)` | **No public function** | Internal `_finalizeParticipation`. Runs automatically from `claim()` and from the **next round’s first `commit()`**. Do not look for it on the ABI. |
| `verifyWinner` / `settleRound` | **Not here** | Option A only. Claim stays one tx. |
| `retryPayout` | **Not here** | If withdraw fails, replay `claim()` in the same claim phase. |

## What is new vs not

### New (this PR)

- **`commit(obfuscatedHash, round, depth)`** — breaking. Depth is declared here; proximity is checked at commit against the **commit-phase** anchor; `depth > height` is required.
- **Cap `MAX_COMMITS = 128`** — stake-weighted admission (lower `admissionPriority` wins). Watch `CommitSelected` / `CommitEvicted` / `CommitRejected`.
- **`Committed` event** now includes `depth`.
- **Automatic participation close** — first `commit` of round R+1 freezes non-revealers from R if `claim()` never ran. Zero-reveal rounds: `claim()` reverts `NoReveals()`; the next `commit` still freezes everyone who committed and did not reveal.
- **Failed pot withdraw reverts the whole `claim()`** — no pay, no claim. Replay `claim()`.

### Unchanged

- Still one `claim(entryProof1, entryProof2, entryProofLast)`.
- `reveal(depth, hash, nonce)` name and proof-of-commit flow.
- `StakeRegistry` ABI.

### Not in this PR

- Public `finalizeParticipation`, `verifyWinner`, `settleRound`.
- Proof-before-selection / round-scoped postage (SWIP-49/50).
- All-sybil same-fake-hash coalition (still open).
- `StakeRegistry` min-stake-on-height-change.

## Round lifecycle (what the contract does for you)

```text
Round R commit
  → if R−1 is still open, this tx finalizes it (freeze non-revealers)
  → then admit into R (eligibility + MAX_COMMITS)

Round R reveal
  → depth must equal declaredDepth
  → proximity re-checked against the reveal anchor

Round R claim          (optional — someone may skip it)
  → same internal finalize if not done yet
  → verify proofs → disagree penalties → oracle → withdraw
  → if withdraw reverts, the whole claim rolls back

Round R+1 first commit
  → if R never got a successful claim, this tx finalizes R, then admits into R+1
```

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

Admission: eligible commits enter until `length == MAX_COMMITS`; when full, replace the worst slot only if the newcomer is strictly better. Weight is snapshotted effective stake; depth/proximity are eligibility only. `MAX_COMMITS = 128` is a placeholder until Gnosis fork benchmarks (see SWIP-51).

`CommitRejected` does **not** revert the tx (so a prior-round freeze in the same tx still sticks).

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
- Do not wait for a `finalizeParticipation` tx — there isn’t one. If withdraw reverts, replay **`claim()`** in the same claim phase.
- Skipped or failed claims are closed by the next round’s first `commit`.

### 4. Eligibility / ABI

- `isParticipatingInUpcomingRound(owner, depth)` returns `false` if `depth <= height` (does not revert for that case).
- Regenerate Go bindings from the new `Redistribution` ABI. Old 2-arg `commit` will not exist. `StakeRegistry` is unchanged.
