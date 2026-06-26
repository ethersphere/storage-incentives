# Test coverage — `feat/new_staking`

## Summary

The Hardhat suite validates the new queue-based `StakeRegistry` (`src/Staking.sol`) and its integration with `Redistribution`. As of this branch:

| Metric | Value |
|--------|-------|
| Total tests | **177** |
| Staking unit tests | **51** (`test/Staking.test.ts`) |
| Redistribution integration | **51** (`test/Redistribution.test.ts`) |
| Runtime (local) | ~33s |

Run:

```bash
npx hardhat compile
npm test
```

> If deploy fails with `expected 3 constructor arguments, got 5`, compile first — stale artifacts from the old constructor.

---

## What changed in staking tests

The old committed-chunk / potential-stake model was replaced with tests for:

- Round-based update queue (`WAIT_BASE`, `WAIT_OVERLAY_CHANGE`, `WAIT_WITHDRAWAL`)
- Enqueue API: `createDeposit`, `addTokens`, `changeOverlay`, `increaseHeight`, `withdraw`, `exit`
- Materialization via `applyUpdates` (FIFO, mixed delays, atomic revert on frozen withdrawal)
- Effective stake previews: `nodeEffectiveStake`, `*Lookahead` view functions
- Freeze-only penalties (slash removed); freeze survives exit, migrate, redeposit
- Pause / `migrateStake` emergency path
- Oracle price changes no longer affect effective stake (balance-only model)

`test/Redistribution.test.ts` was updated to use `createDeposit` / `addTokens`, assert effective stake in reveals/claims, and cover next-round eligibility after queued exit.

Property tests: `src/echidna/EchidnaStakingHarness.sol` replaces the old stake-registry harness.

---

## New tests (latest commit)

Edge-case coverage added for previously untested revert paths and cross-contract events:

### `test/Staking.test.ts`

| Test | Covers |
|------|--------|
| should reject createDeposit when the address already has active stake | `AlreadyStaked()` |
| should reject addTokens with zero amount | `InvalidAmount()` |
| should reject height increase when balance is below minimum for the new height | `BelowMinimumStake` on `increaseHeight` |
| should reject freezeDeposit from callers without REDISTRIBUTOR_ROLE | `OnlyRedistributor()` |
| should emit AccountFreezeExtended when freezing an address with no stake or queue | `AccountFreezeExtended` event + `freezeUntilBlock` |

### `test/Redistribution.test.ts`

| Assertion | Covers |
|-----------|--------|
| Parse `StakeFrozen` from claim tx logs | Non-revealer frozen by `Redistribution.claim`; checks `frozen`, `overlay`, `durationBlocks` (`2 × ROUND_LENGTH × 2^depth`) |

---

## Staking test map (`test/Staking.test.ts`)

### Deposits & queue lifecycle

- Deploy with wait parameters
- `createDeposit` scheduling and activation delay
- Inactive until delay elapses (overlay / effective stake = 0)
- Top-up, height increase, overlay change (queued, applied after delay)
- Lookahead previews match post-delay state
- Queue full (`UpdateQueueFull`)
- Queue closed after `exit()`
- Redeposit after full exit

### Withdrawals & exit

- Partial withdraw + `applyUpdates` token transfer
- Full exit clears stake
- Invalid withdraw amounts / below-minimum remainder
- Withdraw/exit while active in current round (Redistribution commit interaction)
- Mature withdrawal applied during freeze; future ones blocked

### Freeze

- Effective stake = 0 while frozen; non-withdrawal updates still queue/apply
- Queued withdrawal blocked until freeze expires (`FrozenWithdrawal`)
- Freeze monotonic (shorter freeze cannot shorten existing)
- Freeze survives full exit and `migrateStake`
- `freezeDeposit` while paused reverts
- `AccountFreezeExtended` for unstaked accounts

### Pause & migration

- Staking mutations blocked when paused
- `migrateStake` only when paused; includes queued deposits / addTokens
- Unpause restores normal flow

### Validation & config

- Below minimum stake at height
- `AlreadyStaked`, `InvalidAmount`
- Height decrease rejected; height increase below new minimum rejected
- `MAX_STAKING_HEIGHT` enforced
- Invalid constructor wait config

### Enqueue API surface

- `callStatic` return matches event effective round for all enqueue functions
- Overlay unchanged revert; height unchanged is no-op
- Non-decreasing rounds when stacking `addTokens`
- Atomic `applyUpdates` revert when withdrawal blocked mid-batch

### FIFO & mixed delays

- Different wait configs: addTokens → withdraw → overlay order
- Same effective round: addTokens → withdraw → addTokens
- Uniform waits: addTokens → withdraw → increaseHeight in one round

---

## Redistribution integration highlights

- Unstaked / recently staked nodes cannot commit
- Height-based minimum stake at commit time
- Multi-node fixture with queued top-ups (`addTokens`)
- Effective stake in `currentReveals` and `WinnerSelected`
- Next-round stake state during claim-phase eligibility (queued exit)
- Non-revealer frozen on claim; `StakeFrozen` event verified from logs
- Winner selection, pot payout, postage price updates unchanged

---

## Test plan (manual / CI checklist)

- [ ] `npm test` — 177 passing
- [ ] Staking: deposit → wait → commit/reveal round (via Redistribution fixture)
- [ ] Staking: partial withdraw leaves valid minimum for height
- [ ] Staking: exit → redeposit on same address after freeze window
- [ ] Redistribution: single reveal freezes non-revealer (`nodeEffectiveStake == 0`)
- [ ] Pause staking → `migrateStake` returns funds → unpause → redeposit
- [ ] (Optional) Echidna: `EchidnaStakingHarness` per `echidna/README.md`

---

## Intentionally removed

- Slash penalty tests — protocol uses **freeze-only** penalties (`7495f08`). `Redistribution` never wired slash into staking.
