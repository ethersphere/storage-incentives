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

The harness gives `StakeRegistry` an infinite token allowance and then exposes a few actions Echidna can call.

### Actions (what Echidna mutates)

These functions are intentionally written to be **mostly non-reverting**, so Echidna can explore longer state sequences:

- `act_manageStake(setNonce, addAmount, height)`
  - Calls `StakeRegistry.manageStake(...)` with bounded inputs.
  - Ensures the first stake can satisfy the minimum-stake requirement (otherwise skips).
- `act_withdrawSurplus()`
  - Calls `StakeRegistry.withdrawFromStake()`.
- `act_tokenTransfer(to, amount)`
  - Moves some tokens out of the harness to vary balances and edge cases.

### Properties (what must always hold)

The harness defines `echidna_*` properties that Echidna checks continuously:

- **Token invariants**
  - `echidna_token_supply_constant`: total supply stays equal to the initial supply minted to the harness.
  - `echidna_token_decimals_16`: decimals stays `16` (this repo’s BZZ/sBZZ convention).
- **Stake invariants**
  - `echidna_stake_committed_never_decreases`: after a *successful* `manageStake`, the recorded `committedStake` for the harness address never decreases.
  - `echidna_stake_commitment_implies_potential_cover`: `nodeEffectiveStake(address(this)) <= potentialStake`.

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

