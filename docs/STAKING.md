# StakeRegistry Contract

## Overview

The `StakeRegistry` contract (`src/Staking.sol`) manages BZZ staking for node operators in the Swarm redistribution game. Nodes lock tokens, register an overlay and height, and become subject to freeze penalties from the `Redistribution` contract.

There is **no PriceOracle dependency**. Stake is a single on-chain BZZ balance per account, not a committed-chunk / potential-stake pair.

## Purpose

The contract:

- Derives and tracks each node's overlay address
- Holds staked BZZ with height-based minimum requirements
- Queues stake changes with round-based delays (FIFO update queue)
- Exposes **effective** overlay, height, and balance to `Redistribution` (including matured-but-not-yet-applied queue items)
- Applies freeze penalties (participation exclusion) via `REDISTRIBUTOR_ROLE`

## Key Concepts

### Overlay address

```solidity
overlay = keccak256(abi.encodePacked(owner, reverse(networkId), nonce))
```

`networkId` is set at deploy time and used for all new overlay derivations on that deployment.

### Stake balance and height

Each committed account has:

- **`balance`**: BZZ held in the contract for that stake
- **`height`**: Staking height (0–128). Minimum required balance is:

```solidity
minimumForHeight(h) = MIN_STAKE * (2 ** h)
```

Higher height means a higher minimum deposit and a higher minimum remainder after partial withdrawal. Height does **not** multiply effective stake in the redistribution game; it scales **eligibility requirements** and how `Redistribution` computes depth responsibility (`depth - height`).

### Effective stake (for Redistribution)

```solidity
nodeEffectiveStake(owner) =
    addressNotFrozen(owner) && overlay != 0
        ? previewedBalance(owner)
        : 0
```

`previewedBalance` includes all queue items at the account head whose `effectiveFromRound <= currentRound()` (and that are not blocked by freeze for withdrawal types), even if the owner has not called `applyUpdates()`.

**Freeze** is not a token lock: while `block.number <= freezeUntilBlock`, effective stake is zero, but the owner can still enqueue non-withdrawal updates. Due `withdraw` / `exit` payouts are blocked until unfreeze (or advanced via redistributor paths — see below).

### Update queue

Most mutations are **scheduled**, not immediate:

| Function | Queue kind | Typical wait |
|----------|------------|--------------|
| `createDeposit` | `CreateDeposit` | `WAIT_BASE` rounds |
| `addTokens` | `AddTokens` | `WAIT_BASE` |
| `increaseHeight` | `IncreaseHeight` | `WAIT_BASE` |
| `changeOverlay` | `ChangeOverlay` | `WAIT_OVERLAY_CHANGE` |
| `withdraw` | `WithdrawTokens` | `WAIT_WITHDRAWAL` |
| `exit` | `ExitStake` | `WAIT_WITHDRAWAL` |

Items become applicable when `effectiveFromRound <= currentRound()`. `applyUpdates(owner)` materializes the ready prefix of the queue. Queue length is capped at `UPDATE_QUEUE_MAX_LENGTH` (10). After `exit()` is queued, the queue is **closed** (no further mutations until processed or migrated).

Rounds are `block.number / ROUND_LENGTH` (152 blocks per round).

## Functions

### Node functions

#### createDeposit(setNonce, amount, height)

First stake for an address (no existing committed stake with balance).

- Pulls `amount` of BZZ via `transferFrom`
- Requires `amount >= MIN_STAKE * 2**height`
- Reverts `AlreadyStaked()` if the address already has committed stake with balance
- Reverts `StakingHeightTooLarge()` if `height > MAX_STAKING_HEIGHT`
- Returns `effectiveFromRound` (same value as in `DepositCreated`)
- Emits `DepositCreated`

#### addTokens(amount)

Adds BZZ to an existing stake (queued). Reverts `InvalidAmount()` if `amount == 0`.

#### changeOverlay(setNonce)

Changes overlay after `WAIT_OVERLAY_CHANGE`; reverts `OverlayUnchanged` if derived overlay is unchanged.

#### increaseHeight(height)

Increases height only (cannot decrease). Requires preview balance ≥ minimum for the new height at enqueue time.

#### withdraw(amount)

Partial withdrawal after `WAIT_WITHDRAWAL`. Remainder must stay ≥ minimum for current height. Full unwind uses `exit()`, not `withdraw(fullBalance)`.

#### exit()

Schedules full exit: clears stake and returns all balance when applied; closes the queue.

#### applyUpdates(owner)

Public. Applies all ready queue items in order. Reverts `FrozenWithdrawal()` if the head item is a due withdrawal/exit while frozen (whole tx rolls back).

Integrators and Bee should align commit/reveal data with **previewed** overlay/height/stake from view functions, not only storage before `applyUpdates`.

#### migrateStake()

When contract is **paused**: returns active balance plus amounts from queued `CreateDeposit` / `AddTokens`, clears stake and queue. Freeze deadline on the account is unchanged.

### Redistributor functions

#### freezeDeposit(owner, time)

Requires `REDISTRIBUTOR_ROLE` and `whenNotPaused`.

- Extends `freezeUntilBlock` to at least `block.number + time` (monotonic — never shortened)
- If the account has no stake and no queue: records account-level freeze only and emits `AccountFreezeExtended`
- Otherwise calls `_applyReadyUpdates` first: a **matured** withdrawal at queue head on an **unfrozen** account can pay out in the same tx before the new freeze applies
- While frozen: `nodeEffectiveStake` is 0; further due withdrawals are blocked
- Emits `StakeFrozen` when committed stake remains after applying ready updates

### Admin functions

#### pause() / unpause()

`DEFAULT_ADMIN_ROLE`. Pauses user-facing mutations (`whenNotPaused`). `applyUpdates` and `migrateStake` are not gated by pause.

There is no `changeNetworkId()` in the current contract; `networkId` is constructor-initialized only.

### View functions

| Function | Returns |
|----------|---------|
| `stakes(owner)` | Previewed `Stake` (overlay, balance, height) |
| `nodeEffectiveStake(owner)` | Previewed balance if committed and not frozen, else 0 |
| `overlayOfAddress(owner)` | Previewed overlay if committed, else `0` |
| `heightOfAddress(owner)` | Previewed height if committed, else 0 |
| `nodeEffectiveStakeLookahead(owner, n)` | Same at round `currentRound() + n` |
| `overlayOfAddressLookahead` / `heightOfAddressLookahead` | Lookahead previews |
| `freezeUntilBlock(owner)` | Freeze deadline (exclusive: unfrozen when `block.number >` this) |
| `currentRound()` | `block.number / ROUND_LENGTH` |

## Data structures

```solidity
struct Stake {
    bytes32 overlay;   // zero = not committed
    uint256 balance;   // BZZ in contract
    uint8 height;
}

struct ScheduledUpdate {
    UpdateKind kind;
    uint64 effectiveFromRound;
    bytes32 nonce;
    uint256 amount;
    uint8 height;
}
```

Per-account `Account` holds `stake`, `freezeUntilBlock`, and `queue`. Freeze survives stake deletion and exit.

## Events

```solidity
event DepositCreated(address indexed owner, uint64 registeredFromRound, uint256 amount, bytes32 overlay, uint8 height);
event TokensAdded(address indexed owner, uint64 registeredFromRound, uint256 amount);
event OverlayChanged(address indexed owner, uint64 registeredFromRound, bytes32 overlay);
event HeightIncreased(address indexed owner, uint64 registeredFromRound, uint8 height);
event WithdrawalQueued(address indexed owner, uint64 effectiveFromRound, uint256 amount);
event Withdrawal(address indexed owner, uint64 executedInRound, uint256 amount);
event StakeFrozen(address indexed frozen, bytes32 indexed overlay, uint256 durationBlocks);
event AccountFreezeExtended(address indexed account, uint256 freezeUntilBlock);
event StakeMigrated(address indexed owner, uint256 totalReturned);
```

## Roles

- **DEFAULT_ADMIN_ROLE**: pause / unpause
- **REDISTRIBUTOR_ROLE**: `freezeDeposit` (typically granted to `Redistribution`)

## Deployment

```typescript
constructor(
  bzzToken: address,
  networkId: uint64,
  waitBase: uint64,
  waitOverlayChange: uint64,
  waitWithdrawal: uint64
)
```

- `waitOverlayChange` and `waitWithdrawal` must be ≥ `waitBase`
- Example deploy args: `[token.address, swarmNetworkId, 2, 2, 2]` (see `deploy/*/003_deploy_staking.ts`)

No oracle address in the constructor.

## Constants

```solidity
MIN_STAKE = 10 * 1e16;           // 0.1 BZZ at height 0
ROUND_LENGTH = 152;
UPDATE_QUEUE_MAX_LENGTH = 10;
MAX_STAKING_HEIGHT = 128;
```

## Lifecycle examples

### Initial deposit

```solidity
ERC20(bzz).approve(stakeRegistry, amount);
stakeRegistry.createDeposit(nonce, amount, height);
// ... advance rounds ...
stakeRegistry.applyUpdates(node);
```

At height 1, minimum deposit is `MIN_STAKE * 2`.

### Partial withdrawal

```solidity
stakeRegistry.withdraw(partialAmount);
// after WAIT_WITHDRAWAL rounds and applyUpdates (and not frozen):
// BZZ transferred, balance reduced
```

### Freeze penalty

```solidity
// Called by Redistribution
stakeRegistry.freezeDeposit(node, durationBlocks);
// nodeEffectiveStake(node) == 0 until block.number > freezeUntilBlock
```

## Integration with Redistribution

`Redistribution` reads `overlayOfAddress`, `heightOfAddress`, and `nodeEffectiveStake` (and lookahead variants for eligibility). Commit requires `_stake != 0`. Stake density in winner selection uses the stake recorded at commit time.

On claim, `Redistribution` calls `freezeDeposit` on non-revealers and on revealers whose hash/depth disagrees with the selected truth (subject to `penaltyRandomFactor`). Freeze duration scales with `ROUND_LENGTH` and truth depth.

Price oracle affects **postage** economics only, not stake effective balance.

## Errors

```solidity
error BelowMinimumStake(uint256 have, uint256 need);
error NotStaked();
error AlreadyStaked();
error InvalidAmount();
error FrozenWithdrawal();
error UpdateQueueFull(uint256 queuedCount, uint256 limit);
error QueueClosed();
error OnlyRedistributor();
error InvalidWithdrawalAmount(WithdrawalAmountIssue reason);
error OverlayUnchanged();
error HeightDecreaseNotAllowed();
error StakingHeightTooLarge(uint8 height, uint8 maxHeight);
error InvalidWaitConfiguration(uint64 waitBase, uint64 waitOverlayChange, uint64 waitWithdrawal);
error TransferFailed();
```

Penalties are **freeze-only**; there is no slash path on `StakeRegistry`.

## Security and integration notes

1. **Preview vs storage**: View functions include matured queue state; Bee must use the same semantics as `commit`/`reveal` verification.
2. **Freeze**: Participation ban, not confiscation; first `freezeDeposit` may execute a due queued withdrawal.
3. **Pause**: Stops new queue items from users; `applyUpdates` can still run.
4. **Minimum stake**: Enforced at deposit, height increase, and partial withdraw scheduling — not re-checked on every queued apply path.

## Related contracts

- **Token**: ERC20 BZZ (`bzzToken`)
- **Redistribution**: Commit/reveal game; holds `REDISTRIBUTOR_ROLE` for penalties

## Test coverage

Hardhat suite: **177 tests** (~33s). Staking-specific: **51 tests** in `test/Staking.test.ts`. Run `npx hardhat compile && npm test`.

Property tests: `src/echidna/EchidnaStakingHarness.sol` (see `echidna/README.md`).

### Unit tests (`test/Staking.test.ts`)

| Area | What is tested |
|------|----------------|
| **Deposit & queue** | Deploy wait params; `createDeposit` delay and activation; inactive until delay; top-up / height / overlay scheduling; lookahead previews; queue full; queue closed after `exit()`; redeposit after exit |
| **Validation** | Below minimum at deposit; `AlreadyStaked()`; `InvalidAmount()` on `addTokens(0)`; height decrease rejected; height increase below new minimum; `MAX_STAKING_HEIGHT`; invalid constructor wait config |
| **Withdraw & exit** | Partial withdraw + `applyUpdates` payout; full exit; invalid amounts; below-minimum remainder; withdraw/exit while active in current round (Redistribution commit) |
| **Freeze** | Effective stake = 0 while frozen; non-withdrawal updates still apply; queued withdrawal blocked until unfreeze; `FrozenWithdrawal()` atomic revert on `applyUpdates`; freeze monotonic; freeze survives exit and `migrateStake`; `OnlyRedistributor()`; `AccountFreezeExtended` on unstaked account; freeze while paused reverts |
| **Pause & migrate** | Staking blocked when paused; `migrateStake` only when paused (includes queued `CreateDeposit` / `AddTokens`); unpause restores flow |
| **Enqueue API** | `callStatic` return matches event effective round; overlay unchanged revert; height unchanged no-op; non-decreasing rounds when stacking `addTokens`; atomic `applyUpdates` when withdrawal blocked mid-batch |
| **FIFO & mixed delays** | Different wait configs (top-up → withdraw → overlay); same-round ordering; uniform waits (top-up → withdraw → height in one round) |
| **Oracle independence** | Price oracle change does not change effective stake |

### Integration tests (`test/Redistribution.test.ts`)

| Area | What is tested |
|------|----------------|
| **Eligibility** | Unstaked / recently staked cannot commit; height-based minimum at commit; effective stake in reveals and winner selection |
| **Queued stake** | Multi-node fixture with `createDeposit` and `addTokens`; effective stake after top-ups |
| **Exit & lookahead** | Next-round stake state during claim-phase eligibility after queued `exit()` |
| **Freeze from game** | Non-revealer frozen on claim (`nodeEffectiveStake == 0`); `StakeFrozen` event parsed from claim tx logs (overlay + duration) |
| **Winner flow** | Single reveal, both reveal, postage payout failure retry — unchanged game logic with new stake API |

### Not tested in Hardhat (by design)

- Slash penalties (removed; freeze-only protocol)
- Mainnet / testnet deployed bytecode (local fixture only)
