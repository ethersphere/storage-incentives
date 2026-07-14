# Minimum Depth / Spam Protection: Design Options

Possible approaches for minimum depth ("floor") policy in `Redistribution.sol`.

For the sybil / claim gas griefing threat model, see [SPAM_GRIEFING.md](./SPAM_GRIEFING.md).

## Background

The contract previously exposed `currentMinimumDepth()`, which enforced a minimum reported depth during `reveal()`. That floor was derived from the winner's depth in the last claimed round and decayed when rounds were skipped without a claim.

That design was removed because a malicious or unusually deep winner could raise the floor and lock out honest participants.

The question now is whether some form of minimum depth should return, and if so, how to preserve spam protection without giving the winner unilateral control of the floor or relying on a floor signal that is tautological under current truth semantics.

## Current State

On branch `fix/minimal_depth_resolve`, there is no minimum depth check in `reveal()`. Participation is gated by:

- Staking requirements
- Commit/reveal proximity to the round anchor (reveal only today; commit has no proximity check)
- Penalties for disagreeing with selected truth

This document compares that baseline with alternative policies.

---

## Truth semantics constraint

Current truth is an exact pair `(hash, depth)` selected by stake-density-weighted lottery over individual reveals in `getCurrentTruth()`. A reveal agrees with truth only if both `hash == truthHash` and `depth == truthDepth`.

Consequence for floor policy:

- Every truth-agreeing revealer has depth exactly `truthDepth`.
- Therefore `min(depth among truth-agreeing revealers) == truthDepth`.
- The winner is also chosen only among that exact pair, so `winner.depth == truthDepth`.

Option B as originally written is not a distinct policy under current semantics. It renames the old winner-derived floor without changing the value. Examples with truth-agreeing depths 10, 12, and 20 are impossible: all agreeing revealers must share the same depth.

Any independent floor signal must either:

1. Not derive from the selected truth tuple (governed constant, bootstrap minimum, external oracle), or
2. Change truth aggregation first so depth can vary among hash-agreeing revealers (Option B′ below).

Depth floor alone does not cap sybil count N for commit spam. See [SPAM_GRIEFING.md](./SPAM_GRIEFING.md).

---

## Option A: Remove the floor entirely (current branch)

Policy: no minimum depth check in `reveal()` (or `commit()`). Any staked node that passes proximity checks can participate.

Pros:

- Simplest design; no winner-gaming vector via floor
- No lockout after a deep or adversarial win

Cons:

- Loses explicit spam protection at low depth (`depth == height` path always available)
- Relies on stake, proximity, and penalty mechanics alone
- Does not bound claim-loop size

---

## Option B: Honest-participant floor (original proposal)

Policy (as originally drafted): set the floor from the minimum depth among truth-agreeing revealers in the last completed round.

```
floorNext = min(depth) over reveals where hash == truthHash && depth == truthDepth
```

Status under current contract: not viable as a distinct policy.

Because truth agreement requires `depth == truthDepth`, the minimum is always `truthDepth`. This is equivalent to the removed winner-based floor (and to using the truth-teller's depth directly).

The original example ("truth-agreeing depths 10, 12, 20 → floor = 10") cannot occur. Do not implement Option B without first changing truth semantics.

---

## Option B′: Hash-level truth, then cohort minimum depth

Policy: redesign truth selection so the protocol first selects a hash (e.g. stake-weighted vote or density lottery on hash only), then sets:

```
floorNext = min(reveal.depth) over reveals where hash == selectedTruthHash
```

Varying depths among hash-agreeing revealers become meaningful again.

Pros:

- Restores the original intent of "honest cohort minimum" without winner-only control
- Floor can be lower than the winner's depth if the winner played deeper than some hash-agreeing peers

Cons:

- Requires protocol change to `getCurrentTruth()` and downstream winner/agreement checks
- Winner selection, penalties, and client semantics must be re-specified
- Higher implementation and audit cost than a governed floor

When to choose: only if the product goal is an adaptive floor tied to observed honest depth, and the team accepts a truth-model change.

---

## Option C: Gradual floor increase (+1 per round max)

Policy: the floor may rise by at most 1 per claimed round.

```
floorNext = min(referenceDepth, floorPrev + 1)
```

Where `referenceDepth` must be defined without Option B tautology, e.g. governed target, bootstrap constant, or Option B′ cohort minimum.

Pros:

- Limits rapid escalation
- Cheap to implement; one stored `floor` value
- Predictable for operators

Cons:

- Still needs a non-tautological `referenceDepth` source
- Slow to converge if honest network depth is legitimately higher
- Does not cap sybil N

---

## Option D: Self-healing / collapsing floor (low participation)

Policy: if participation is too low, automatically lower the floor.

Example rule:

- If `revealerCount < X` in the last round → `floorNext = floorPrev / 2` (or `floorPrev - k`)

Pros:

- Recovers from adversarial high-floor lockout scenarios

Cons:

- Attacker could force collapse by suppressing participation (tune `X`, collapse rate, stake economics carefully)
- Must define what `revealerCount` means (all revealers vs hash-agreeing only)
- Interacts poorly with Option B under current semantics; more sensible with governed floor or Option B′

---

## Option E: Combined adaptive policy

Stack mechanisms (only meaningful with a valid base floor source):

| Layer       | Mechanism                                              |
|-------------|--------------------------------------------------------|
| Base floor  | Governed constant, bootstrap minimum, or Option B′   |
| Rise cap    | `floorNext = min(baseFloor, floorPrev + 1)` (Option C) |
| Recovery    | If `revealerCount < X`, apply collapse (Option D)      |
| Skip decay  | Optional: decay floor when claim rounds are skipped    |

Do not stack Option B (original) with C/D/E. The base signal is tautological.

---

## Option F: Governed / bootstrap floor (recommended for near-term)

Policy: `currentFloor()` is a stored value set by governance (multisig/admin) or a fixed bootstrap constant until a better adaptive signal exists. Enforced at both `commit()` and `reveal()`.

Pros:

- Independent of winner/truth-teller depth
- Simple to specify and audit
- Works with current `(hash, depth)` truth model
- Pairs with commit proximity and `depth > height` requirement

Cons:

- Not self-tuning; requires governance or parameter choice
- Wrong constant can lock out honest nodes or leave spam window open

Typical pairing: Option F + minimum `depth - height` responsibility + commit proximity + hard `MAX_COMMITS` (see [SPAM_GRIEFING.md](./SPAM_GRIEFING.md)).

---

## Comparison

| Option                    | Shallow-reveal spam | Sybil / claim gas grief | Independent of truth depth | Lockout recovery | Complexity |
|---------------------------|---------------------|-------------------------|----------------------------|------------------|------------|
| A: Remove floor           | None                | Unchanged               | N/A                        | N/A              | Low        |
| B: Honest min (original)  | N/A (tautological)  | Unchanged               | No                         | n/a              | n/a        |
| B′: Hash then min depth   | Partial             | Unchanged               | Yes (with redesign)        | Partial          | High       |
| C: +1 cap                 | Partial             | Unchanged               | If paired with F or B′     | Slow             | Low        |
| D: Collapse on low N      | Partial             | Unchanged               | If paired with F or B′     | High             | Medium     |
| E: Combined adaptive      | Partial             | Unchanged               | Only with F or B′ base     | High             | Higher     |
| F: Governed / bootstrap   | Partial             | Unchanged               | Yes                        | Manual/governance| Low        |

"Shallow-reveal spam" = blocking the cheapest path (`depth == height`). "Sybil / claim gas grief" = many staked identities bloating per-round arrays. Not solved by any floor alone.

---

## Suggested decision process

1. Decide whether any depth floor is required, or stake plus penalties are sufficient (Option A).
2. Option B (original) is invalid under current truth semantics unless truth aggregation changes.
3. For near-term spam/liveness work, prefer Option F (governed/bootstrap floor) plus the bounded-work package in [SPAM_GRIEFING.md](./SPAM_GRIEFING.md).
4. If an adaptive floor tied to honest cohort depth is required long-term, evaluate Option B′ (truth redesign) before reintroducing Options C/D/E.
5. Address sybil / claim gas griefing with hard `MAX_COMMITS` or batched finalization. Depth floor alone is insufficient.
6. Add reproducible gas benchmarks on Gnosis before setting constants.

---

## Recommended combined approach with commit proximity

See [SPAM_GRIEFING.md](./SPAM_GRIEFING.md#proposed-mitigation-package) for the full threat-model context.

### Rationale

- Depth floor alone does not stop global sybil commits; it only affects shallow reveals.
- Commit proximity alone is bypassed at `depth == height` (responsibility 0) and by zero-deposit height changes in `manageStake()`.
- Proximity is probabilistic, not a hard cap on N.
- Bounded work (commit cap or batched finalization) is required for claim liveness.

### Proposed pairing

| Component | Choice |
|-----------|--------|
| Commit proximity | `inProximity(overlay, currentRoundAnchor(), _depth - height)` in `commit()` |
| Minimum responsibility | Require `_depth > height` at commit and reveal |
| Stored depth | `Commit.declaredDepth`; reveal must match |
| Depth floor | Option F (governed/bootstrap) |
| Height changes | Revalidate `MIN_STAKE * 2^height` on every `manageStake` height update |
| Bounded work | `MAX_COMMITS` from gas benchmarks, or batched `finalizeRound()` |
| Finalization split | `finalizeRound()` before `claimReward()` proofs |

### Example flow

1. Governance sets `currentFloor()` (Option F) or bootstrap constant applies.
2. Commit phase: `commit(hash, round, depth)`; revert if `depth <= height`, not in proximity, `depth < floor`, or cap reached.
3. Reveal phase: `declaredDepth` match, proximity to reveal anchor, `depth > height`, `depth >= floor`.
4. `finalizeRound()`: truth, winner, penalties, oracle (bounded); then `claimReward()` with proofs.

### Comparison (with combined approach)

| Approach | Shallow-reveal spam | Sybil / claim gas grief | Independent floor |
|----------|---------------------|-------------------------|-------------------|
| Option A only (current) | None | Unchanged | N/A |
| Depth floor only (F) | Partial | Unchanged | Yes |
| Commit proximity only | Low (`depth==height` bypass) | Unchanged | N/A |
| Proximity + F + `depth > height` | High | Low | Yes |
| Full package (+ bounded work + split finalize) | High | High | Yes |

### Open design questions

- Bootstrap floor value when no governance parameter exists
- `MAX_COMMITS` vs batched finalization trade-off
- Admission policy under hard cap (censorship resistance)
- Whether to pursue Option B′ / truth redesign in a later phase
- Skipped-round floor decay (carry forward from old design or drop)

---

## Related code and docs

- [`Redistribution.sol`](../src/Redistribution.sol): reveal, claim, and truth selection
- [`REDISTRIBUTION.md`](./REDISTRIBUTION.md): contract overview and game phases
- [`SPAM_GRIEFING.md`](./SPAM_GRIEFING.md): sybil spam and claim gas model

## Status

Option A is on `fix/minimal_depth_resolve`. Next step: Option F floor + commit eligibility + bounded work (see [SPAM_GRIEFING.md](./SPAM_GRIEFING.md)).
