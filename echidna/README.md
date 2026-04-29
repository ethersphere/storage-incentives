# Echidna fuzzing in this repo

This directory contains a **minimal, stateful fuzz-testing setup** using [Echidna](https://github.com/crytic/echidna).

Echidna works by:

- Deploying a “harness” contract.
- Calling its public/external **action functions** with many randomized inputs, building **sequences** of calls.
- After (and during) those sequences, checking that `echidna_*` **property functions** always return `true`.

If a property returns `false`, Echidna prints a **reproducer** (a short sequence of calls/inputs that triggers the failure).

## What we are testing right now

### Harness

This repo currently contains multiple harnesses:

- **Staking harness**: `src/echidna/EchidnaStakeRegistryHarness.sol`
- **Oracle harness**: `src/echidna/EchidnaPriceOracleHarness.sol`
- **PostageStamp harness**: `src/echidna/EchidnaPostageStampHarness.sol`
- **Redistribution harness**: `src/echidna/EchidnaRedistributionHarness.sol`
- **Redistribution claim-stub harness**: `src/echidna/EchidnaRedistributionClaimHarness.sol`
- **Redistribution real-claim harness**: `src/echidna/EchidnaRedistributionRealClaimHarness.sol`
- **System/integration harness**: `src/echidna/EchidnaSystemHarness.sol`

### What each harness deploys

The **staking harness** deploys:

- `TestToken` (a mintable ERC20 preset used as BZZ stand-in)
- `StakeRegistry` (from `src/Staking.sol`)
- a small constant-price oracle used by `StakeRegistry`

It also deploys several **actor contracts** (`EchidnaStakeActor`) which behave like independent users (each has its own address and token balance), plus a dedicated actor that receives the `REDISTRIBUTOR_ROLE` so we can fuzz freeze/slash flows.

The **oracle harness** deploys:

- `PriceOracle` (from `src/PriceOracle.sol`)
- a `PostageStamp` mock that can succeed or revert on `setPrice(uint256)`
- an updater actor (has `PRICE_UPDATER_ROLE`) and a random actor (no roles) to fuzz access control

The **postage stamp harness** deploys:

- `TestToken` (ERC20 used as BZZ stand-in)
- `PostageStamp` (from `src/PostageStamp.sol`)
- actor contracts with roles:
  - a price oracle actor (has `PRICE_ORACLE_ROLE`)
  - a redistributor actor (has `REDISTRIBUTOR_ROLE`)
  - a pauser actor (has `PAUSER_ROLE`)

The **redistribution harness** (base) deploys:

- `Redistribution` (from `src/Redistribution.sol`)
- mocks for its dependencies:
  - `IStakeRegistry` (overlay/height/effective stake + `freezeDeposit` tracking)
  - `IPostageStamp` (tracks `withdraw()` calls; provides minimal `batches()`/`validChunkCount()` access)
  - `IPriceOracle` (tracks `adjustPrice()` calls)
- a small set of actor contracts (independent `msg.sender`s) to fuzz access control and commit/reveal/claim entrypoints

It also includes “happy-path” actions (`act_happyCommit`, `act_happyReveal`) that try to **increase the rate of successful**
`commit → reveal` sequences by pre-conditioning the mocked stake/overlay inputs (so we can assert stronger post-conditions).

The **redistribution claim-stub harness** deploys:

- a fuzz-only `RedistributionClaimStub` that runs the real `winnerSelection()` but exposes `claimStub()` which **bypasses**
  inclusion/SOC/stamp proof verification and directly calls `withdraw(winner)` on a small pot mock.

This is meant to fuzz the **claim-phase state machine + pot withdrawal effects** end-to-end, without paying the cost of generating
valid Merkle/SOC/postage proofs.

The **redistribution real-claim harness** deploys:

- the real `Redistribution` contract
- the shared redistribution stake/oracle mocks
- a fixture-aware postage mock that returns batch metadata matching the fixed proof bundles

This harness stores one fixed CAC proof bundle and one fixed SOC proof bundle, both derived from the existing
Hardhat proof fixtures, and then fuzzes:

- the real `commit -> reveal -> claim` path needed to activate those fixtures
- mutations of selected proof fields (reserve-commitment inclusion roots/branches, postage indices, SOC identifier)

The goal is not to randomly discover valid proofs. Instead, it uses **known-good proofs as seed fixtures** and lets Echidna
mutate the surrounding scenario and targeted proof bytes while the real on-chain verifier runs.

The **system/integration harness** deploys:

- `TestToken`
- `PostageStamp`
- `PriceOracle` (wired as the `PRICE_ORACLE_ROLE` on `PostageStamp`)
- `StakeRegistry` (wired to `PriceOracle.currentPrice()`)
- `Redistribution` (wired to `StakeRegistry`, `PostageStamp`, `PriceOracle`)

and grants:

- `StakeRegistry.REDISTRIBUTOR_ROLE` to `Redistribution` (so it can `freezeDeposit`)
- `PostageStamp.REDISTRIBUTOR_ROLE` to `Redistribution` (so it can `withdraw`)
- `PriceOracle.PRICE_UPDATER_ROLE` to one actor (to fuzz `adjustPrice`)

### Actions (what Echidna mutates)

Harness action functions are intentionally written to be **mostly non-reverting**, so Echidna can explore longer state sequences.

Key actions per harness:

- **Staking harness**

  - Stake actions: `act_actor_manageStake`, `act_actor_withdrawSurplus`, `act_actor_migrateStake`
  - Admin actions: `act_admin_pause`, `act_admin_unpause`, `act_admin_changeNetworkId`
  - Redistributor actions: `act_redistributor_freeze`, `act_redistributor_slash`
  - Negative tests: `act_actor_try*` (unauthorized attempts)
  - Funding: `act_fundActor`

- **Oracle harness**

  - Admin actions: `act_admin_setPrice`, `act_admin_pause`, `act_admin_unpause`
  - Updater actions: `act_updater_adjustPrice`
  - Negative tests: `act_rando_try*`
  - PostageStamp mock behavior: `act_setStampRevertMode`

- **PostageStamp harness**

  - Batch actions: `act_createBatch`, `act_topUp`, `act_increaseDepth`, `act_expireAll`
  - Price update: `act_oracle_setPrice`
  - Pot withdrawal: `act_redistributor_withdraw`
  - Pause/unpause: `act_pauser_pause`, `act_pauser_unpause`
  - Negative tests: `act_rando_try*`
  - Funding: `act_fundActor`

- **Redistribution harness (base)**

  - Stake configuration: `act_setActorStake`
  - Game entrypoints: `act_commit`, `act_reveal`, `act_claim` (often reverts early; still useful to shake out panics/state bugs)
  - Happy-path flow: `act_happyCommit`, `act_happyReveal`
  - Winner selection (fuzz-only exposure): `act_winnerSelection`
  - Admin actions: `act_admin_pause`, `act_admin_unpause`, `act_admin_setSampleMaxValue`, `act_admin_setFreezingParams`
  - Negative tests: `act_rando_try*` (unauthorized attempts)
  - Pause gating checks: `act_tryCommitWhilePaused`, `act_tryRevealWhilePaused`

- **Redistribution claim-stub harness**

  - Happy-path flow: `act_happyCommit`, `act_happyReveal`, `act_claimStub`
  - Pot seeding: `act_seedPot`

- **Redistribution real-claim harness**

  - Fixture selection: `act_useCacFixture`, `act_useSocFixture`
  - Fixture setup: `act_prepareFixtureCommit`, `act_prepareFixtureReveal`, `act_claimActiveFixture`
  - Pot seeding: `act_seedPot`
  - Proof mutations: `act_mutateReserveCommitmentRoot`, `act_mutateOriginalChunkBranch`, `act_mutateTransformedChunkBranch`, `act_mutatePostageIndexLow`, `act_mutatePostageIndexHigh`, `act_mutateSocIdentifier`

- **System/integration harness**
  - Stake actions: `act_actor_manageStake`, `act_actor_withdrawSurplus`
  - Postage actions: `act_actor_createBatch`, `act_actor_topUp`, `act_actor_increaseDepth`, `act_actor_expireAll`
  - Oracle actions: `act_admin_setOraclePrice`, `act_updater_adjustOraclePrice`, `act_rando_tryAdjustOraclePrice`
  - Redistribution flow: `act_redist_happyCommit`, `act_redist_happyReveal`

### Properties (what must always hold)

Each harness defines `echidna_*` properties that Echidna checks continuously.

Common patterns used across harnesses:

- **Authorization (“must never happen”)**: calls that should be role-gated must never succeed for unauthorized actors.
- **Post-conditions**: for successful state transitions, the immediate post-state must match expected math and accounting.

High-signal properties per harness:

- **Staking harness**

  - Access control + “must never happen” flags (`echidna_never_performed_forbidden_calls`)
  - Registry accounting (ERC20 balance covers sum of potential stake)
  - Per-actor invariants (commitment monotonicity, effective stake/freeze semantics, overlay derivation)
  - Post-conditions for `manageStake(add>0)`, `freezeDeposit`, `slashDeposit`, `migrateStake`

- **Oracle harness**

  - Access control (admin-only + updater-only) and “paused means no changes”
  - Price invariants: price never below minimum; lastAdjustedRound not in the future
  - Post-conditions for `setPrice` and `adjustPrice` (including skipped-round math), with overflow-aware modeling

- **PostageStamp harness**

  - Access control (oracle-only price updates, redistributor-only withdraw, pauser-only pause/unpause)
  - Pause-mode negative tests (batch mutations must not succeed while paused)
  - Batch post-conditions (`createBatch`, `topUp`, `increaseDepth`) and expiry sanity (`expireAll`)
  - Pot/withdraw post-conditions (beneficiary receives exactly the withdrawn amount; `pot` resets)
  - Non-interference checks for unrelated tracked batches during targeted operations (now checks multiple other batches)
  - Pot monotonicity: pot must never decrease except by a successful withdraw-to-zero (`echidna_pot_never_decreases_except_withdraw`)

- **Redistribution harness (base)**

  - Access control “must never happen” flag (`echidna_never_performed_forbidden_calls`)
  - Pause gating: `echidna_never_succeeded_while_paused`
  - Phase sanity: exactly one of commit/reveal/claim is active (`echidna_phase_partitions_round`)
  - Round bookkeeping sanity (`currentCommitRound/currentRevealRound` never in the future)
  - Commit/reveal internal consistency:
    - committed overlays remain unique
    - if a commit is marked as revealed, its `revealIndex` points to a reveal with the same overlay/owner
    - every reveal entry must correspond to a revealed commit (`echidna_reveal_entries_imply_matching_commit`)
  - Claim-phase state machine (using a fuzz-only exposed `winnerSelection()`):
    - winner selection cannot succeed twice in the same round (`echidna_winnerSelection_only_once_per_round`)
    - successful winner selection freezes all non-revealers (`echidna_last_winnerSelection_freezes_nonrevealed`)
  - Happy-path post-conditions (only asserted for the currently active commit round):
    - `echidna_tracked_commit_matches_storage`
    - `echidna_tracked_reveal_matches_storage`

- **Redistribution claim-stub harness**

  - claim can only succeed once per round (`echidna_claim_only_once_per_round`)
  - successful claim withdraws the entire pot to the selected winner (`echidna_claim_withdraws_pot_to_winner_when_successful`)
  - claim triggers an oracle `adjustPrice` call (`echidna_claim_triggers_oracle_adjustPrice`)
  - non-revealers are frozen during claim processing (`echidna_nonrevealers_frozen_after_claim_selection`)

- **Redistribution real-claim harness**

  - untouched CAC/SOC fixtures can complete the real `claim()` path (`echidna_unmutated_fixture_claim_succeeds`)
  - corrupted proof fixtures do not successfully claim (`echidna_mutated_fixture_claim_does_not_succeed`)
  - successful real claims trigger the expected withdraw/oracle side-effects (`echidna_successful_real_claim_effects_hold`)

- **System/integration harness**
  - Oracle↔stamp invariant: `PostageStamp.lastPrice` tracks `PriceOracle.currentPrice()` after updates
  - Stamp accounting: internal `pot` does not exceed the stamp contract’s BZZ balance (`echidna_stamp_internal_pot_not_above_contract_balance`)
  - Redistribution happy-path consistency: tracked commit/reveal values appear in `Redistribution` storage

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

By default, this runs **all** Echidna harness contracts in `src/echidna/`.

By default, the runner uses `echidna/echidna.yaml`. You can override that with `ECHIDNA_CONFIG` if a harness needs its own
corpus or tuned fuzzing parameters.

To run only a specific harness contract:

```bash
ECHIDNA_CONTRACT=EchidnaStakeRegistryHarness yarn echidna
ECHIDNA_CONTRACT=EchidnaPriceOracleHarness yarn echidna
ECHIDNA_CONTRACT=EchidnaPostageStampHarness yarn echidna
ECHIDNA_CONTRACT=EchidnaRedistributionHarness yarn echidna
ECHIDNA_CONTRACT=EchidnaRedistributionClaimHarness yarn echidna
ECHIDNA_CONTRACT=EchidnaRedistributionRealClaimHarness yarn echidna
ECHIDNA_CONTRACT=EchidnaSystemHarness yarn echidna
```

This uses Docker and the image `ghcr.io/crytic/echidna/echidna:latest`.

### Output files

Echidna may write artifacts such as:

- `echidna/corpus/` (saved interesting inputs)
- `echidna/coverage/`
- `crytic-export/` (Crytic export artifacts)

These are ignored by git via `.gitignore`.

### Config files

- `echidna/echidna.yaml`: default config for all harness runs (override with `ECHIDNA_CONFIG` if needed)

## How to extend this

Typical next steps:

- Add another harness under `src/echidna/` following the naming convention `Echidna*Harness.sol`. The runner script auto-discovers files matching that pattern, so no manual script edits are needed.
- Keep actions non-reverting and model only the roles/privileges you want to include.
- Start with a few **obviously true** invariants, then iterate:
  - If Echidna finds a counterexample, decide whether that is a **bug** or a **property mismatch**.
  - Tighten properties only when you’re confident the protocol/design guarantees them.
