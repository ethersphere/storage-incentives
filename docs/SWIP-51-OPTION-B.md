# SWIP-51 Option B — proposed Redistribution changes

Bee / reviewer note for **this PR** (under review, not deployed). Attack catalog and design options stay in [SWIP-51](https://github.com/ethersphere/swip-51/blob/main/swip-51.md). Contract overview: [REDISTRIBUTION.md](./REDISTRIBUTION.md).

Claim path: **Option B** — still one `claim()`. This PR proposes shared admission + automatic participation close. Proof-before-selection (B1 / STS) waits for **SWIP-49 + SWIP-50**.

## Read this first

Bee would still call the same three functions: `commit` → `reveal` → `claim`. There is no new public function to “finalize” a round.

| SWIP-51 name                   | In this PR?            | What Bee would do                                                                                                           |
| ------------------------------ | ---------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `commit(hash, round, depth)`   | **Yes — new ABI**      | Call this. Depth is required.                                                                                               |
| `reveal` / `claim`             | Yes — same names       | Still call these. Reveal depth must match commit.                                                                           |
| `finalizeParticipation(round)` | **No public function** | Internal `_finalizeParticipation`. Would run from `claim()` and from the **next round’s first `commit()`**. Not on the ABI. |
| `verifyWinner` / `settleRound` | **Not in this PR**     | Option A only. Claim stays one tx.                                                                                          |
| `retryPayout`                  | **Not in this PR**     | If withdraw fails, replay `claim()` in the same claim phase.                                                                |

## What is new vs not

### Proposed in this PR

- **`commit(obfuscatedHash, round, depth)`** — breaking. Depth is declared here; proximity is checked at commit against the **commit-phase** anchor; `depth > height` is required.
- **Cap `MAX_COMMITS = 32`** — stake-weighted admission (lower `admissionPriority` wins). Watch `CommitSelected` / `CommitEvicted` / `CommitRejected`.
- **`Committed` event** now includes `depth`.
- **Automatic participation close** — first `commit` of round R+1 freezes non-revealers from R if `claim()` never ran. Freeze duration is `max(truth, lastClaimedDepth)` when someone revealed, or `lastClaimedDepth` if nobody did (floor `MIN_NONREVEAL_FREEZE_DEPTH` if unset). `lastClaimedDepth` is written only after a successful `claim()`, so a skipped-claim fake-low truth cannot shrink the freeze. A no-show who is that first committer closes R but is `CommitRejected` for R+1 (finalize sticks; they do not get a slot). Zero-reveal rounds: `claim()` reverts `NoReveals()`; the next `commit` still freezes everyone who committed and did not reveal.
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

## Round lifecycle (if this PR is merged)

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
  → if R never got a successful claim, this tx finalizes R
  → then re-checks stake; a just-frozen no-show is CommitRejected and is not admitted
```

## Breaking API (`Redistribution.sol`)

| Before                                         | After                                                             |
| ---------------------------------------------- | ----------------------------------------------------------------- |
| `commit(bytes32 obfuscatedHash, uint64 round)` | `commit(bytes32 obfuscatedHash, uint64 round, uint8 depth)`       |
| Proximity only at reveal                       | Proximity at **commit** and again at reveal                       |
| Depth chosen only at reveal                    | Depth **declared at commit**; reveal must match (`DepthMismatch`) |
| `depth == height` allowed                      | **`depth > height` required** (`DepthNotGreaterThanHeight`)       |
| Unbounded `currentCommits`                     | Cap `MAX_COMMITS = 32`; eviction by stake-weighted priority       |
| `Committed(round, overlay, height)`            | `Committed(round, overlay, height, depth)`                        |
| Failed `withdraw` still left round “done”      | Failed withdraw reverts `claim()`. No `retryPayout`.              |

Admission: eligible commits enter until `length == MAX_COMMITS`; when full, replace the worst slot only if the newcomer is strictly better. Weight is snapshotted effective stake; depth/proximity are eligibility only. `MAX_COMMITS = 32` matches current neighborhood sizes (typical honest rounds are well under 32; the oracle only uses redundancy up to 8).

`CommitRejected` does **not** revert the tx (so a prior-round freeze in the same tx still sticks).

## What Bee would change

### 1. Commit (required, breaking)

```text
Old: redistribution.commit(obfuscatedHash, round)
New: redistribution.commit(obfuscatedHash, round, depth)
```

Before sending the tx: pick storage depth (same value later used in `wrapCommit` / reveal); require `depth > height`; require overlay in proximity of the **commit-phase** `currentRoundAnchor()` with `depthResponsibility = depth - height`; confirm two-round stake wait; do not send in the last block of commit phase.

Once the set is full (`MAX_COMMITS = 32`):

- `CommitSelected` — this overlay is in the round. Plan to reveal.
- `CommitEvicted` — stop planning reveal for that identity; no reveal obligation.
- `CommitRejected` — not in the round. Gas was still spent. Do not reveal. Treat as “not participating,” not as a failed transaction. Also emitted if this node just got frozen by auto-finalize in the same tx (no-show closer).
- `Committed` now includes `depth`. Update decoders.

If this node is the **first committer of a new round** after a skipped or failed claim, the tx may freeze up to 32 non-revealers from the previous round. Set a high gas limit on commit. If this node itself failed to reveal in that prior round, the tx still finalizes (and freezes them) but emits `CommitRejected` — they are not in the new round.

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
