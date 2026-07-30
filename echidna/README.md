# Echidna fuzzing in this repo

Stateful fuzzing with [Echidna](https://github.com/crytic/echidna): deploy a **harness**, call its `act_*` functions in random **sequences**, and check that `echidna_*` **properties** stay `true`. A failing property prints a **reproducer** (call sequence + inputs).

Source: `src/echidna/` (harnesses), `echidna/echidna.yaml` (defaults), `scripts/echidna.sh` (Docker runner).

## How a campaign works (newcomers)

Echidna does **not** run all actions at once. Each **sequence** is one fresh harness deploy, then up to **`seqLen` steps** (default **320**). Each step = **one** `act_*` call with pseudo-random arguments. Between steps Echidna may advance `block.number` by up to **`maxBlockDelay`** (default **152**, one redistribution round).

Example sequence:

```text
deploy harness
→ act_happyCommit(0, …)
→ act_tick()
→ act_updater_adjustPrice(3)
→ act_rando_tryAdjustPrice(1, 2)
→ act_happyReveal(0)
→ … (up to 320 steps)
```

After **every** step, **all** `echidna_*` properties (invariants) are checked. They must return `true`. If one fails, Echidna saves that prefix as a **reproducer**:

```text
act_A()  →  check all echidna_*  ✓
act_B()  →  check all echidna_*  ✓
act_C()  →  check all echidna_*  ✗  →  FAIL, report sequence A → B → C
```

Echidna then tries many such sequences (**`testLimit`**, default **60 000**). Each sequence starts from a **new deploy** (constructor runs again). Which action runs next is guided by randomness + coverage/corpus—not a fixed script.

| Term | Meaning |
|------|---------|
| **One sequence** | Up to 320 txs on one deployment |
| **One tx** | One `act_*` (or other callable on the harness) |
| **Properties** | Invariants checked **after each tx**, not only at the end |
| **Campaign** | 60 000 sequences × up to 320 steps (per harness) |

**Actions** = moves in a long random game. **Properties** = rules that must hold after every move.

## Concepts

| Piece | Role |
|-------|------|
| `act_*` | Fuzz actions — drive state on deployed contracts. |
| `echidna_*` | Invariants — must always return `true`. |
| `Echidna*Actor` | Separate `msg.sender` for role tests; usually `.call()` so expected reverts don’t abort the `act_*` step. |
| `act_happy*` | Pre-conditioned inputs (tracked preimages, mock stake, phase/round) so commit/reveal are **likely** to succeed. |
| Harness stack | `act_claimStub` → actor `callClaimStub` → `RedistributionClaimStub.claimStub()`. |

**Mocks** trim dependencies to what the unit under test needs (e.g. oracle harness: postage `setPrice` + optional revert only). **System harness** uses real cross-contract wiring.

**If a property fails:** real on-chain bug, too-strong property, or bad harness setup (roles/assumptions). Continuing after an expected revert only means the **next** fuzz step runs on unchanged storage — not that the protocol ignored the revert.

## Harnesses

| Harness | File | Under test | Focus |
|---------|------|------------|--------|
| Staking | `EchidnaStakeRegistryHarness.sol` | `StakeRegistry` | stake, freeze, migrate, roles |
| Oracle | `EchidnaPriceOracleHarness.sol` | `PriceOracle` | price, pause, `adjustPrice`, postage callback fail/revert |
| Postage | `EchidnaPostageStampHarness.sol` | `PostageStamp` | batches, pot, expiry, roles |
| Redistribution (base) | `EchidnaRedistributionHarness.sol` | `RedistributionExposed` | commit/reveal ledger, `winnerSelection`, dummy `claim()` |
| Redistribution (claim) | `EchidnaRedistributionClaimHarness.sol` | `RedistributionClaimStub` | claim-phase pot, withdraw, rounds, H-1 |
| System | `EchidnaSystemHarness.sol` | full wired stack | cross-contract invariants only |

**Support (not Echidna targets):** `RedistributionExposed.sol` (`winnerSelection`, safe array lengths); `EchidnaMocks.sol` (stake + oracle mocks for redistribution harnesses).

**Proof verification:** real `claim()` with Merkle/SOC/postage proofs → Hardhat `test/Redistribution.test.ts`. Echidna cannot generate valid proofs; base harness uses dummy calldata (`act_claim`) only to stress panics/guards.

### Redistribution: base vs claim-stub

| | Base | Claim-stub |
|--|------|------------|
| Deploy | `RedistributionExposed` + mocks (withdraw counter, no token pot) | `RedistributionClaimStub` + `TestToken` + pot mock (balance, optional withdraw revert) |
| Claim | `act_claim` → real `claim()`, proofs almost always revert | `act_claimStub` → `claimStub()` = `winnerSelection()` + `withdraw` (no proof checks) |
| Winner | `act_winnerSelection` | inside `claimStub()` |
| Happy path | `act_happyCommit` → `act_happyReveal` | + `act_claimStub` |
| Also | random commit/reveal, admin tuning | `act_seedPot`, `act_setWithdrawRevertMode` |

```text
Base:   commit ─ reveal ─ [winnerSelection] ─ act_claim(dummy → revert)
Claim:  happy commit ─ happy reveal ─ claimStub (winner + pot)
System: real contracts; happy commit/reveal only
```

## Actions (by harness)

Written to be **mostly non-reverting** (bounded inputs, low-level calls) so sequences stay long.

- **Staking:** `act_actor_manageStake`, `withdrawSurplus`, `migrateStake`; admin pause/unpause/networkId; redistributor freeze; `act_actor_try*`; `act_fundActor`
- **Oracle:** `act_admin_setPrice`, pause/unpause; `act_updater_adjustPrice`; `act_rando_try*`; `act_setStampRevertMode`
- **Postage:** `act_createBatch`, `topUp`, `increaseDepth`, `expireAll`; `act_oracle_setPrice`; `act_redistributor_withdraw`; pauser pause/unpause; `act_rando_try*`; `act_fundActor`
- **Redistribution (base):** `act_commit`, `reveal`, `claim`; `act_happyCommit`, `happyReveal`; `act_winnerSelection`; `act_setActorStake`; admin pause/unpause/sample/freezing
- **Redistribution (claim):** `act_happyCommit`, `happyReveal`, `claimStub`; `act_seedPot`, `setWithdrawRevertMode`, `setActorNode`; `act_tick`
- **System:** stake/postage/oracle actions above + `act_redist_happyCommit`, `happyReveal`

## Properties (by harness)

Patterns: **must-never-happen** (auth), **global invariants**, **post-conditions** on last successful action (`pending*` flags).

- **Staking:** `echidna_never_performed_forbidden_calls`; registry balance vs potential stake; per-actor stake/overlay/freeze; post-conditions for manageStake/freeze/migrate
- **Oracle:** forbidden calls; price ≥ minimum; `lastAdjustedRound` not in future; post-conditions for `setPrice` / `adjustPrice`
- **Postage:** forbidden calls; batch post-conditions; `expireAll`; withdraw/pot; `echidna_pot_never_decreases_except_withdraw`
- **Redistribution (base):** `echidna_commit_overlays_unique`, `revealed_commit_indices_valid`, `reveal_entries_imply_matching_commit`, `winnerSelection_only_once_per_round`, `last_winnerSelection_freezes_nonrevealed`, `tracked_commit_matches_storage`, `tracked_reveal_matches_storage`  
  _(AccessControl/Pausable/phase math: Hardhat, not fuzzed here.)_
- **Redistribution (claim):** `echidna_claim_only_once_per_round`, `claim_withdraws_pot_to_winner_when_successful`, `failed_withdraw_preserves_pot_and_consumes_round`, `claim_triggers_oracle_adjustPrice`, `nonrevealers_frozen_after_claim_selection`
- **System:** oracle price ↔ stamp `lastPrice`; stamp pot ≤ balance; unauthorized oracle adjust fails; tracked commit/reveal in storage

## Triage example

`manageStake` with `_addAmount == 0` can change `height` without recomputing `committedStake` — so \( committedStake \cdot 2^{height} \le potentialStake \) is **not** a valid invariant (property failed correctly during bring-up).

Other false-positive sources: harness grants roles it shouldn’t; property assumes unreachable state; too many action reverts (weak exploration).

## How to run

```bash
yarn echidna   # all harnesses; needs Docker
```

| Setting | Default | Override env |
|---------|---------|----------------|
| `testLimit` | 60000 | `ECHIDNA_TEST_LIMIT` |
| `seqLen` | 320 | `ECHIDNA_SEQ_LEN` |
| `maxBlockDelay` | 152 | — |
| workers | yaml | `ECHIDNA_WORKERS` |

Single harness: `ECHIDNA_CONTRACT=EchidnaRedistributionHarness yarn echidna` (also: `EchidnaStakeRegistryHarness`, `EchidnaPriceOracleHarness`, `EchidnaPostageStampHarness`, `EchidnaRedistributionClaimHarness`, `EchidnaSystemHarness`).

Config: `echidna/echidna.yaml` (`ECHIDNA_CONFIG` to override). Corpus/coverage: `echidna/corpus/by-contract/<HarnessName>/` (gitignored). Crytic: `crytic-export/`.

## Extend

1. Add `src/echidna/Echidna*Harness.sol` — auto-discovered by `scripts/echidna.sh`.
2. Prefer non-reverting `act_*`, explicit roles, a few solid properties first.
3. On counterexample: bug vs property vs harness — then fix code or narrow the invariant.
