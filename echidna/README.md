# Echidna fuzzing in this repo

This directory contains a **minimal, stateful fuzz-testing setup** using [Echidna](https://github.com/crytic/echidna).

Echidna works by:

- Deploying a “harness” contract.
- Calling its public/external **action functions** with many randomized inputs, building **sequences** of calls.
- After (and during) those sequences, checking that `echidna_*` **property functions** always return `true`.

If a property returns `false`, Echidna prints a **reproducer** (a short sequence of calls/inputs that triggers the failure).

## What we are testing right now

### Harness

- **Harness contract**: `src/echidna/EchidnaStakeRegistryHarness.sol`

It deploys:

- `TestToken` (a mintable ERC20 preset used as BZZ stand-in)
- `StakeRegistry` (from `src/Staking.sol`)
- a small constant-price oracle used by `StakeRegistry`

It also deploys several **actor contracts** (`EchidnaStakeActor`) which behave like independent users (each has its own address and token balance), plus a dedicated actor that receives the `REDISTRIBUTOR_ROLE` so we can fuzz freeze/slash flows.

### Actions (what Echidna mutates)

These functions are intentionally written to be **mostly non-reverting**, so Echidna can explore longer state sequences:

- **Per-actor stake actions**
  - `act_actor_manageStake(actorId, setNonce, addAmount, height)`
  - `act_actor_withdrawSurplus(actorId)`
  - `act_actor_migrateStake(actorId)` (only succeeds when paused)
- **Admin actions (executed by the harness admin)**
  - `act_admin_pause()`, `act_admin_unpause()`
  - `act_admin_changeNetworkId(newNetworkId)`
- **Redistributor actions (executed by the redistributor actor)**
  - `act_redistributor_freeze(targetActorId, time)`
  - `act_redistributor_slash(targetActorId, amount)`
- **Negative tests (unauthorized attempts)**
  - `act_actor_tryPause(...)`, `act_actor_tryUnpause(...)`, `act_actor_tryChangeNetworkId(...)`
  - `act_actor_tryFreeze(...)`, `act_actor_trySlash(...)`
- **Funding**
  - `act_fundActor(actorId, amount)` transfers tokens from the harness to an actor so fuzzing doesn’t get “stuck” when actors run out of balance.

### Properties (what must always hold)

The harness defines `echidna_*` properties that Echidna checks continuously:

- **Authorization / “must never happen”**
  - `echidna_never_performed_forbidden_calls`: asserts that unauthorized actors never successfully paused/unpaused/changed network id, never successfully froze/slashed, and that we didn’t observe other action-level invariant violations.
- **Cross-actor accounting**
  - `echidna_registry_balance_covers_sum_potential`: registry token balance covers the sum of all actors’ `potentialStake`.
- **Per-actor stake invariants**
  - `echidna_stake_committed_never_decreases_per_actor`: committed stake never decreases for an actor while it has an active stake entry.
  - `echidna_nodeEffective_matches_freeze_rule_per_actor`: effective stake is `0` while frozen, otherwise matches expected effective stake math.
  - `echidna_empty_state_is_zeroed_for_all`: if a stake entry is deleted/empty, all fields are zeroed.
  - `echidna_overlay_matches_last_manageStake_for_all`: overlay matches `keccak256(owner, reverse(networkIdAtLastStake), lastNonce)` per actor.
- **Post-conditions for successful `manageStake(add > 0)`**
  - `echidna_last_manageStake_add_updates_potential_and_registry_balance`: on the immediate post-state after a successful `manageStake` with `addAmount > 0`, both the actor’s `potentialStake` and the registry’s ERC20 balance must increase by exactly `addAmount`.
  - `echidna_last_manageStake_add_recomputes_committedStake`: on that same immediate post-state, `committedStake` must equal `floor(potential / (price * 2**height))`.
- **Pause/migrate and penalty post-conditions**
  - `echidna_migrate_never_succeeds_while_unpaused`: `migrateStake()` must never succeed unless the registry is paused.
  - `echidna_last_migrate_refunds_and_deletes_when_stake_exists`: on the immediate post-state after a successful `migrateStake()`, the stake is deleted and the actor is refunded exactly their previous `potentialStake` (or it is a no-op if no stake existed).
  - `echidna_last_freeze_only_updates_lastUpdated`: on the immediate post-state after a successful redistributor `freezeDeposit`, only `lastUpdatedBlockNumber` is modified (other stake fields remain unchanged).
  - `echidna_last_slash_updates_expected_fields`: on the immediate post-state after a successful redistributor `slashDeposit`, partial slashes only decrease `potentialStake` and set `lastUpdatedBlockNumber`, and full slashes delete the stake.

These are “sanity properties”: they’re meant to detect obvious bugs and unintended state corruption early.

## What we expect (and what can go wrong)

### When a property fails

A failure means one of two things:

- **Real bug**: there is a reachable sequence of calls that violates an intended invariant.
- **Bad/too-strong property**: the property is not actually guaranteed by the contract’s design.

Example of the second case (we hit this during bring-up):

- It is possible to change `height` with `_addAmount == 0` in `StakeRegistry.manageStake()`.
- In that case `committedStake` is **not recomputed**, so a property like
  \( committedStake \cdot 2^{height} \le potentialStake \)
  is **not guaranteed** and will correctly fail.

### Common sources of “false positives”

- **Role-gated functions**: if an invariant assumes some privileged function cannot be called, make sure the harness never grants itself those roles (or explicitly models them).
- **Reverts shortening sequences**: if actions revert too often, Echidna explores fewer interesting states. Prefer bounding inputs and using low-level calls (as the current harness does).
- **Time/block effects**: some contracts depend on `block.number`. Echidna can advance time with `--delay`/`--wait`, but invariants should be designed with that in mind.

## How to run

From repo root:

```bash
yarn echidna
```

This uses Docker and the image `ghcr.io/crytic/echidna/echidna:latest`.

### Output files

Echidna may write artifacts such as:

- `echidna/corpus/` (saved interesting inputs)
- `echidna/coverage/`
- `crytic-export/` (Crytic export artifacts)

These are ignored by git via `.gitignore`.

## How to extend this

Typical next steps:

- Add another harness under `src/echidna/` for `PostageStamp` or `Redistribution`.
- Keep actions non-reverting and model only the roles/privileges you want to include.
- Start with a few **obviously true** invariants, then iterate:
  - If Echidna finds a counterexample, decide whether that is a **bug** or a **property mismatch**.
  - Tighten properties only when you’re confident the protocol/design guarantees them.

