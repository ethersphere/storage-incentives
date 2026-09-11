# PostageStamp Contract

> **SWIP-049 changes the rules around batch operations on this branch.** A redistribution round
> now fixes which batches and stamp indexes it may use at the block sampling begins, and the
> contract keeps the history needed to answer that. The user-visible consequences are listed
> under [Fixed redistribution scope](#fixed-redistribution-scope-swip-049) — in particular the
> top-up cliff and permanent batch id consumption. Review of the SWIP itself:
> [SWIP-49-50-SCRUTINY.md](./SWIP-49-50-SCRUTINY.md); integration notes: [STS-1.md](./STS-1.md).

## Overview

The `PostageStamp` contract manages postage stamp batches that users purchase to store chunks on the Swarm network. It implements a sophisticated price normalization system that tracks storage costs over time.

## Purpose

Users buy postage stamps (batches) upfront to pay for future data storage. The contract:

- Tracks batches with their storage capacity and balance
- Manages batch expiration based on price accumulation
- Accumulates expired batch funds into a pot for redistribution
- Provides role-based access for price updates and withdrawals

## Key Concepts

### Normalized Balance

The contract uses a "normalized balance" system to track the actual storage cost accumulated over time:

```solidity
normalizedBalance = totalOutPayment + initialBalancePerChunk
```

- `totalOutPayment`: Accumulated per-chunk cost since contract deployment
- New batches are credited with current `totalOutPayment` as if they existed since inception
- When price changes, `totalOutPayment` is updated based on blocks elapsed

### Batch Structure

```solidity
struct Batch {
  address owner; // Owner of the batch
  uint8 depth; // Total depth (2^depth = max chunks)
  uint8 bucketDepth; // Bucket depth for addressing
  bool immutableFlag; // Whether batch can be modified
  uint256 normalisedBalance; // Normalized balance per chunk
  uint256 lastUpdatedBlockNumber; // Last update timestamp
}
```

### Order Statistics Tree

Batches are stored in an ordered tree structure sorted by normalized balance. This enables:

- Efficient expiration checking (start from lowest balance)
- O(log n) operations for insert/remove
- Predictable gas costs for batch lookups

## Functions

### User Functions

#### createBatch()

Creates a new postage stamp batch.

**Parameters**:

- `_owner`: Address that will own the batch
- `_initialBalancePerChunk`: Balance to add per chunk
- `_depth`: Total batch depth (capacity = 2^depth)
- `_bucketDepth`: Bucket depth for chunk addressing
- `_nonce`: Random nonce for batch ID generation
- `_immutable`: Whether batch can be topped up later

**Requirements**:

- `_initialBalancePerChunk >= minimumInitialBalancePerChunk()` (24h minimum validity)
- `_bucketDepth >= minimumBucketDepth && _bucketDepth < _depth`
- Sufficient ERC20 token approval

**Returns**: `bytes32 batchId`

**Batch ID Generation**:

```solidity
batchId = keccak256(abi.encode(msg.sender, _nonce))
```

#### topUp()

Adds more balance to an existing batch.

**Parameters**:

- `_batchId`: ID of the batch to top up
- `_topupAmountPerChunk`: Additional balance per chunk

**Requirements**:

- Batch must exist and not be expired
- Batch depth must be > minimumBucketDepth
- New total balance must meet minimum validity

**Effects**:

- Transfers tokens from caller
- Updates normalized balance
- Reinserts batch into tree with new balance

#### increaseDepth()

Increases the depth (capacity) of a batch.

**Parameters**:

- `_batchId`: ID of the batch
- `_newDepth`: New depth value (must be larger than current)

**Requirements**:

- Caller must be batch owner
- `_newDepth > batch.depth`
- Batch must not be expired
- New balance per chunk must meet minimum validity

**Effects**:

- Doubles capacity for each additional depth level
- Redistributes existing balance across new capacity

### Admin Functions

#### copyBatch()

Manually creates a batch (for migrations).

**Parameters**: Same as `createBatch()`, plus `_batchId` (the specific ID to use)

**Requirements**:

- Only `DEFAULT_ADMIN_ROLE` can call
- Used during contract migrations to preserve batch data

#### copyBatchBulk()

Bulk import batches (for large migrations).

**Parameters**:

- `bulkBatches`: Array of ImportBatch structures

**Requirements**:

- Only `DEFAULT_ADMIN_ROLE` can call
- Processes 60-90 batches optimally
- Emits `CopyBatchFailed` event if batch import fails

### Price Management

#### setPrice()

Updates the price per chunk.

**Parameters**:

- `_price`: New price value

**Requirements**:

- Only `PRICE_ORACLE_ROLE` can call

**Logic**:

```solidity
if (lastPrice != 0) {
    // Account for price accumulation since last update
    totalOutPayment = currentTotalOutPayment()
}
lastPrice = _price
lastUpdatedBlock = block.number
```

### Expiration Management

#### expireLimited()

Reclaims expired batches (called automatically or manually).

**Parameters**:

- `limit`: Maximum number of batches to expire (prevents gas limit issues)

**Logic**:

1. Iterate batches in ascending balance order
2. If `remainingBalance(batch) <= 0`:
   - Remove chunks from `validChunkCount`
   - Add to pot: `pot += batchSize * (normalizedBalance - lastExpiryBalance)`
   - Delete batch
3. For remaining valid batches:
   - `pot += validChunkCount * (currentTotalOutPayment - lastExpiryBalance)`
4. Update `lastExpiryBalance`

### Pot Withdrawal

#### withdraw()

Withdraws the accumulated pot to a beneficiary.

**Parameters**:

- `beneficiary`: Address to receive the funds

**Requirements**:

- Only `REDISTRIBUTOR_ROLE` can call

**Returns**: Transfers current pot amount and resets it to 0

### View Functions

#### remainingBalance(batchId)

Returns the unused balance per chunk for a batch.

#### currentTotalOutPayment()

Returns the total per-chunk cost since contract deployment.

#### totalPot()

Returns the current pot amount (also calls `expireLimited`).

#### validChunkCount

Public variable representing total chunks available from all active batches.

#### minimumInitialBalancePerChunk()

Returns minimum balance for 24h validity: `minimumValidityBlocks * lastPrice`

## Fixed redistribution scope (SWIP-049)

A redistribution round for round `r` fixes its usable batch and index set at

```
samplingStartBlock(r) = (r - 1) * 152 + 38
```

the first reveal block of the preceding round. Two reads answer the question for that block:

```solidity
redistributionMinimumNormalisedBalance(uint256 samplingStartBlock) returns (uint256)
redistributionBatchAt(bytes32 batchId, uint256 samplingStartBlock)
  returns (address owner, uint8 depthAtSamplingStart, uint8 bucketDepth, uint256 normalisedBalance)
```

`redistributionBatchAt` reverts `BatchNotUsableForRedistribution` if the batch is absent, expired,
or had no depth before sampling began. `batchDepthHistory(batchId)` exposes the retained history
so a client can check its own reconstruction against the contract.

### State this adds

| Field                                        | Purpose                                                                                        |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `previousPrice`, `previousPriceUpdatedBlock` | reconstruct the price in force at a past sampling start, and prove the reconstruction is sound |
| two-slot depth history per batch             | resolve the batch depth that a past sampling boundary observed                                 |
| `batchIdUsed`                                | consume a batch id permanently                                                                 |

The depth history rotates only when a sampling boundary actually observed the superseded depth,
so repeated dilutions between boundaries do not evict a depth an open claim still needs.

### What changes for batch owners

- **A batch bought after sampling started is unusable by the open round.** It works for uploads
  immediately; it just cannot be sampled or claimed until the next round fixes its scope.
- **A dilution mid-round does not widen the index range an open round accepts.** The new indexes
  are real and usable for uploads, but a claim for the open round verifies against the smaller
  range that existed at its sampling start.
- **A top-up is rejected once remaining balance falls below the minimum.** The check runs _before_
  the top-up, so a batch that has dropped under `minimumValidityBlocks * price` can no longer be
  rescued at any size and will expire. That threshold is currently 24 hours of balance, not the
  six rounds the SWIP reasons about — see scrutiny 1.2.
- **A dilution must leave at least the minimum.** A dilution can no longer drive a batch into
  expiry; it reverts `InsufficientBalance` instead.
- **A batch id is consumed forever.** An expired id can never be recreated, and a duplicate
  import reverts `BatchIdAlreadyUsed` rather than `BatchExists`.
- **`setMinimumValidityBlocks` will not accept less than 912 blocks**, six redistribution rounds.

## Events

```solidity
event BatchCreated(
  bytes32 indexed batchId,
  uint256 totalAmount,
  uint256 normalisedBalance,
  address owner,
  uint8 depth,
  uint8 bucketDepth,
  bool immutableFlag
);

event BatchTopUp(bytes32 indexed batchId, uint256 topupAmount, uint256 normalisedBalance);

event BatchDepthIncrease(bytes32 indexed batchId, uint8 newDepth, uint256 normalisedBalance);

event PriceUpdate(uint256 price);
event PotWithdrawn(address recipient, uint256 totalAmount);
```

## Roles

- **DEFAULT_ADMIN_ROLE**: Full admin access, can grant/revoke other roles
- **PRICE_ORACLE_ROLE**: Can update prices (typically PriceOracle contract)
- **REDISTRIBUTOR_ROLE**: Can withdraw pot (typically Redistribution contract)
- **PAUSER_ROLE**: Can pause/unpause the contract

## Deployment Configuration

```typescript
constructor(address _bzzToken, uint8 _minimumBucketDepth)
```

- `_bzzToken`: ERC20 token address for payments
- `_minimumBucketDepth`: Minimum bucket depth (typically 16)

## Pausability

The contract implements `Pausable` from OpenZeppelin:

- Pauses all user operations (createBatch, topUp, increaseDepth)
- Admin operations (setPrice, copyBatch) can still proceed
- Can be made immutable by renouncing Pauser and Admin roles

## Gas Considerations

- Batch expiration is bounded (`expireLimited()`) to prevent gas limit issues
- Tree operations are O(log n)
- Bulk imports optimize gas usage (60-90 batches per transaction)

## Examples

### Creating a Batch

```solidity
// User approves tokens
ERC20(bzzToken).approve(postageStamp, amount);

// Create batch
bytes32 batchId = PostageStamp(postageStamp).createBatch(
    owner,
    1000000000000000,  // 0.001 tokens per chunk
    20,                  // depth = 2^20 = 1,048,576 chunks
    16,                  // bucketDepth
    keccak256("nonce"),  // unique nonce
    false                // mutable
);
```

### Topping Up a Batch

```solidity
PostageStamp(postageStamp).topUp(
    batchId,
    500000000000000  // add 0.0005 tokens per chunk
);
```

### Checking Batch Status

```solidity
uint256 remaining = PostageStamp(postageStamp).remainingBalance(batchId);
if (remaining > 0) {
    // Batch is still valid
}
```

## Related Contracts

- **PriceOracle**: Sets price via PRICE_ORACLE_ROLE
- **Redistribution**: Withdraws pot via REDISTRIBUTOR_ROLE
- **Token**: ERC20 token used for payments

## Security Considerations

1. Batch IDs are derived from transaction sender and nonce to prevent collisions
2. Minimum balance enforces 24h minimum batch validity
3. Normalized balance system prevents price manipulation attacks
4. Expiration process is atomic and gas-bounded
5. Admin functions protected by role-based access control

## Error Codes

```solidity
error ZeroAddress(); // Owner cannot be zero
error InvalidDepth(); // Invalid depth parameters
error BatchExists(); // Batch ID already exists
error InsufficientBalance(); // Below minimum balance requirement
error BatchExpired(); // Batch has expired
error BatchTooSmall(); // Depth too small for top-up
error NotBatchOwner(); // Caller is not batch owner
error PriceOracleOnly(); // Only price oracle can set price
error InsufficienChunkCount(); // Invalid chunk count
error OnlyRedistributor(); // Only redistributor can withdraw
error OnlyPauser(); // Only pauser can pause/unpause
```
