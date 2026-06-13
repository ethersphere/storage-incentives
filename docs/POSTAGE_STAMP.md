# PostageStamp Contract

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
    address owner;                    // Owner of the batch
    uint8 depth;                      // Total depth (2^depth = max chunks)
    uint8 bucketDepth;               // Bucket depth for addressing
    bool immutableFlag;              // Whether batch can be modified
    uint256 normalisedBalance;       // Normalized balance per chunk
    uint256 lastUpdatedBlockNumber;   // Last update timestamp
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

event BatchTopUp(
    bytes32 indexed batchId,
    uint256 topupAmount,
    uint256 normalisedBalance
);

event BatchDepthIncrease(
    bytes32 indexed batchId,
    uint8 newDepth,
    uint256 normalisedBalance
);

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
error ZeroAddress();                  // Owner cannot be zero
error InvalidDepth();                 // Invalid depth parameters
error BatchExists();                  // Batch ID already exists
error InsufficientBalance();         // Below minimum balance requirement
error BatchExpired();                 // Batch has expired
error BatchTooSmall();                // Depth too small for top-up
error NotBatchOwner();                // Caller is not batch owner
error PriceOracleOnly();              // Only price oracle can set price
error InsufficienChunkCount();        // Invalid chunk count
error OnlyRedistributor();            // Only redistributor can withdraw
error OnlyPauser();                   // Only pauser can pause/unpause
```

