# Minimum Depth / Spam Protection — Design Options

This document captures possible approaches for reveal-phase minimum depth (“floor”) policy in `Redistribution.sol`. It is intended for discussion and decision-making before implementation.

## Background

The contract previously exposed `currentMinimumDepth()`, which enforced a minimum reported depth during `reveal()`. That floor was derived from the **winner’s depth** in the last claimed round and decayed when rounds were skipped without a claim.

That design was removed because a malicious or unusually deep winner could raise the floor and lock out honest participants.

The question now is whether some form of minimum depth should return, and if so, how to preserve spam protection without giving the winner unilateral control of the floor.

## Current State

On branch `fix/minimal_depth_resolve`, there is **no minimum depth check** in `reveal()`. Participation is gated by:

- Staking requirements
- Commit/reveal proximity to the round anchor
- Penalties for disagreeing with selected truth

This document compares that baseline with alternative policies.

---

## Option A — Remove the floor entirely (current branch)

**Policy:** No minimum depth check in `reveal()`. Any staked node that passes commit/reveal proximity checks can participate.

**Pros**

- Simplest design; no winner-gaming vector
- No lockout after a deep or adversarial win

**Cons**

- Loses explicit spam protection at low depth
- Relies on stake, proximity, and penalty mechanics alone

---

## Option B — Honest-participant floor (middle ground)

**Policy:** Set the floor from the **minimum depth among truth-agreeing revealers** in the last completed round, not from the winner.

After claim, once truth `(hash, depth)` is known:

1. Collect all reveals where `hash == truthHash && depth == truthDepth`
2. Set `floorNext = min(reveal.depth)` over that set
3. In `reveal()`, reject if `_depth < floorNext` (optional decay for skipped rounds)

**Example:** Truth-agreeing revealers at depths 10, 12, and 20 → floor = **10**, even if the winner was at 20.

**Pros**

- Preserves spam protection
- Winner cannot unilaterally raise the floor
- Floor reflects the honest cohort, not one beneficiary

**Cons**

- Requires persisted state from claim (truth plus agreeing depths, or a precomputed minimum)
- If only one honest revealer exists, floor still follows that single node
- Sybil among “agreeing” revealers could manipulate the floor downward (likely bounded by stake and proximity economics)

**Open parameters**

- Decay when rounds are skipped (retain old `skippedRounds` logic or drop it)
- Default floor when no prior round or no truth-agreeing revealers exist (0 vs fixed bootstrap value)

---

## Option C — Gradual floor increase (+1 per round max)

**Policy:** The floor may rise by **at most 1 per claimed round**, regardless of winner depth.

```
floorNext = min(winner.depth, floorPrev + 1)
```

**Example:** Previous floor 10; winner at 20 → next floor **11**, not 20. If the winner played at 20 and others at 10, the next round floor is **11**.

**Pros**

- Limits rapid escalation by a deep winner
- Cheap to implement; one stored `floor` value
- Predictable for operators

**Cons**

- Still winner-influenced, only capped
- Slow to converge if honest network depth is legitimately higher
- Does not help if the floor has already crept above honest depth

**Variants**

- Combine with Option B: `floorNext = min(minHonestDepth, floorPrev + 1)`
- Combine with decay on skipped rounds

---

## Option D — Self-healing / collapsing floor (low participation)

**Policy:** If participation is too low, **automatically lower the floor** so locked-out honest nodes can re-enter.

Example rule:

- If `revealerCount < X` in the last round → `floorNext = floorPrev / 2` (or `floorPrev - k`)
- Repeat if still below threshold

**Example:** Floor 20, winner at 20, only 3 revealers (< 4) → floor collapses to **10**; if the next round still has fewer than 4 revealers → **5**.

**Pros**

- Recovers from adversarial “win deep, lock everyone out” scenarios
- Directly targets the failure mode of the old winner-based floor

**Cons**

- Attacker could potentially force collapse by suppressing participation (needs careful tuning of `X`, collapse rate, and stake economics)
- Collapse logic adds parameters and edge cases (empty round, first round, interaction with Options B/C)

**Open parameters**

- `X` — minimum revealers before collapse triggers
- Collapse function: half, minus fixed step, minimum bound (e.g. never below 0 or a bootstrap floor)
- Whether collapse applies to Option B/C floor or only a winner-derived floor

---

## Option E — Combined policy (recommended direction to evaluate)

Stack mechanisms instead of choosing only one:

| Layer       | Mechanism                                              |
|-------------|--------------------------------------------------------|
| Base floor  | `min(depth)` among truth-agreeing revealers (Option B) |
| Rise cap    | `floorNext = min(baseFloor, floorPrev + 1)` (Option C) |
| Recovery    | If `revealerCount < X`, apply collapse (Option D)      |
| Skip decay  | Optional: decay floor when claim rounds are skipped    |

**Example walkthrough**

1. Last round: truth-agreeing depths 10, 12, 20 → base = 10
2. Previous floor was 10 → capped rise → **10**
3. Only 2 revealers → collapse → **5**
4. Next round, honest nodes at depth ≥ 5 can reveal again

---

## Comparison

| Option                    | Spam protection | Winner gaming | Lockout recovery | Complexity |
|---------------------------|-----------------|---------------|------------------|------------|
| A — Remove floor          | None            | None          | N/A              | Low        |
| B — Honest min depth      | Yes             | Low           | Partial          | Medium     |
| C — +1 cap                | Yes             | Medium        | Slow             | Low        |
| D — Collapse on low N     | Yes             | Medium        | Strong           | Medium     |
| E — Combined              | Yes             | Low           | Strong           | Higher     |

---

## Suggested decision process

1. Decide whether **any** reveal floor is required, or stake plus penalties are sufficient (Option A).
2. If a floor is required, prefer **Option B** as the base signal (not winner depth).
3. Add **Option C** if deep winners remain a concern.
4. Add **Option D** if lockout after low-participation rounds is the main incident to prevent.
5. Specify concrete constants: `X`, collapse rule, bootstrap floor, and skipped-round decay.
