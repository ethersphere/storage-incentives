# StakeRegistry Contract

## Overview

The `StakeRegistry` (Staking) contract manages staking for node operators participating in the Swarm network's redistribution game. Nodes stake tokens to become eligible for rewards and penalties.

## Purpose

The contract:
- Tracks node stakes with overlay addresses
- Manages committed vs potential stake
- Allows height-based reserve calculations
- Provides freeze/slash mechanisms for penalties
- Enables stake withdrawal for surplus amounts

## Key Concepts

### Overlay Address

Each node has an "overlay address" which is derived from:
```solidity
overlay = keccak256(abi.encodePacked(nodeAddress, reverse(networkId), nonce))
```

This creates a unique identifier for the node within a specific Swarm network.

### Two-Stake System

The contract maintains two types of stake:

1. **Committed Stake**: Chunks pledged to store (in oracle price units)
2. **Potential Stake**: Actual BZZ tokens staked

The effective stake (used in redistribution) is the minimum of:
```solidity
effectiveStake = min(
    committedStake * price * 2^height,
    potentialStake
)
```

### Height Parameter

The `height` parameter allows nodes to register additional capacity:
- Height 0: Normal capacity (committed stake * price)
- Height 1: Double capacity (committed stake * price * 2)
- Height 2: 4x capacity, etc.

This allows nodes to increase their effective stake without depositing more tokens by registering additional storage space.

## Functions

### Node Functions

#### manageStake()
Creates or updates a node's stake, optionally changing overlay.

**Parameters**:
- `_setNonce`: Nonce for overlay calculation
- `_addAmount`: Additional BZZ tokens to add (0 if only changing overlay)
- `_height`: Height multiplier (0-255)

**Requirements**:
- Minimum stake: `_addAmount >= MIN_STAKE * 2^height` (first deposit only)
- If frozen: transaction reverts with `Frozen()` error

**Logic**:
1. Calculate new overlay from nonce
2. If first stake: check minimum deposit requirement
3. If frozen: revert (can't change stake while frozen)
4. Update potential stake if depositing
5. Calculate new committed stake: `potentialStake / (price * 2^height)`
6. Never allow committed stake to decrease
7. Transfer tokens if depositing
8. Store new stake state
9. Emit events

**Overlay Change**:
If overlay changes, emits `OverlayChanged` event (useful for monitoring).

#### withdrawFromStake()
Withdraws surplus stake (difference between potential and effective stake).

**Requirements**:
- No special roles needed (only withdraws surplus)

**Logic**:
```solidity
surplus = potentialStake - effectiveStake
if (surplus > 0) {
    transfer tokens to node
    potentialStake -= surplus
}
```

**Use Case**: If price increases or height decreases, effective stake may be less than potential, allowing withdrawal of the difference.

#### migrateStake()
Emergency withdrawal when contract is paused.

**Requirements**:
- Contract must be paused
- Withdraws entire potential stake

**Use Case**: For upgrading to new staking contracts.

### Redistributor Functions

#### freezeDeposit()
Freezes a node's stake for a specified time (penalty).

**Parameters**:
- `_owner`: Node address to freeze
- `_time`: Duration in blocks

**Requirements**:
- Only `REDISTRIBUTOR_ROLE` can call

**Logic**:
```solidity
stakes[_owner].lastUpdatedBlockNumber = block.number + _time
```

While frozen: `stakes[_owner].lastUpdatedBlockNumber > block.number`

**Effects**:
- Node cannot call `manageStake()` while frozen
- `nodeEffectiveStake()` returns 0 while frozen
- After freeze expires, can resume normal operations

#### slashDeposit()
Slashes (removes) a specified amount from a node's stake.

**Parameters**:
- `_owner`: Node address to slash
- `_amount`: BZZ amount to remove

**Requirements**:
- Only `REDISTRIBUTOR_ROLE` can call

**Logic**:
```solidity
if (potentialStake > _amount) {
    potentialStake -= _amount
    lastUpdatedBlockNumber = block.number
} else {
    delete stakes[_owner]  // Remove entire stake
}
```

**Use Cases**:
- Severe protocol violations
- Currently not actively used (freezing is preferred)

### Admin Functions

#### changeNetworkId()
Changes the Swarm network ID.

**Parameters**:
- `_NetworkId`: New network ID

**Requirements**:
- Only `DEFAULT_ADMIN_ROLE` can call

**Effects**:
- New overlays will use new network ID
- Existing overlays remain valid

#### pause() / unPause()
Pauses or unpauses the contract.

**Requirements**:
- Only `DEFAULT_ADMIN_ROLE` can call

**Effects**:
- Prevents `manageStake()` calls
- Allows `migrateStake()` calls

### View Functions

#### nodeEffectiveStake(address)
Returns the effective stake used in redistribution game.

```solidity
if (addressNotFrozen(address)) {
    return calculateEffectiveStake(
        committedStake,
        potentialStake,
        height
    )
} else {
    return 0
}
```

#### withdrawableStake()
Returns the amount of surplus stake that can be withdrawn.

#### lastUpdatedBlockNumberOfAddress(address)
Returns when stake was last updated (used to check if frozen).

#### overlayOfAddress(address)
Returns the current overlay for a node.

#### heightOfAddress(address)
Returns the height multiplier for a node.

### Internal Functions

#### calculateEffectiveStake()
Calculates effective stake based on committed stake and height.

```solidity
committedStakeBzz = (2^height) * committedStake * oracle.currentPrice()
return min(committedStakeBzz, potentialStake)
```

#### addressNotFrozen()
Checks if a node is frozen:
```solidity
return stakes[_owner].lastUpdatedBlockNumber < block.number
```

#### reverse()
Byte-reverses a uint64 (for network ID in overlay calculation).

## Stake Structure

```solidity
struct Stake {
    bytes32 overlay;                    // Node's overlay address
    uint256 committedStake;             // Chunks pledged
    uint256 potentialStake;            // BZZ tokens staked
    uint256 lastUpdatedBlockNumber;    // Update timestamp / freeze flag
    uint8 height;                      // Reserve height multiplier
}
```

## Events

```solidity
event StakeUpdated(
    address indexed owner,
    uint256 committedStake,
    uint256 potentialStake,
    bytes32 overlay,
    uint256 lastUpdatedBlock,
    uint8 height
);

event OverlayChanged(address owner, bytes32 overlay);

event StakeSlashed(address slashed, bytes32 overlay, uint256 amount);

event StakeFrozen(address frozen, bytes32 overlay, uint256 time);

event StakeWithdrawn(address node, uint256 amount);
```

## Roles

- **DEFAULT_ADMIN_ROLE**: Change network ID, pause/unpause
- **REDISTRIBUTOR_ROLE**: Freeze and slash stakes (typically Redistribution contract)

## Deployment Configuration

```typescript
constructor(address _bzzToken, uint64 _NetworkId, address _oracleContract)
```

- `_bzzToken`: ERC20 token address for staking
- `_NetworkId`: Swarm network ID (1 for mainnet, 10 for testnet)
- `_oracleContract`: PriceOracle address for price queries

## Constants

```solidity
uint64 private constant MIN_STAKE = 100000000000000000;  // 0.1 BZZ
```

## Stake Lifecycle

### 1. Initial Stake

```solidity
// Node calls with initial deposit
manageStake(nonce, 1000000000000000000, 1)
// Deposits 1 BZZ, sets height to 1

// At price 1000 chunks/BZZ, height 1:
// committedStake = 1000000000000000000 / (1000 * 2^1) = 500000 chunks
// effectiveStake = min(500000 * 1000 * 2, 1000000000000000000) = 1000000000000000000
```

### 2. Stake Update

```solidity
// Add more tokens
manageStake(nonce, 500000000000000000, 1)
// Deposits 0.5 BZZ more

// Recalculate:
// potentialStake = 1500000000000000000
// committedStake = 1500000000000000000 / (1000 * 2^1) = 750000 chunks
// effectiveStake = min(750000 * 1000 * 2, 1500000000000000000) = 1500000000000000000
```

### 3. Surplus Withdrawal

```solidity
// Price increased from 1000 to 1200 chunks/BZZ
// committedStake = 750000 chunks
// effectiveStake = min(750000 * 1200 * 2, 1500000000000000000) = 1800000000000000000
// But actual potentialStake = 1500000000000000000
// Can withdraw: 0 (effective = potential)

// OR height decreased from 1 to 0
// effectiveStake = min(750000 * 1200 * 1, 1500000000000000000) = 900000000000000000
// Can withdraw: 1500000000000000000 - 900000000000000000 = 600000000000000000
```

### 4. Penalty Freeze

```solidity
// Redistribution calls after node violates protocol
freezeDeposit(nodeAddress, 1000 blocks)

// While frozen:
// nodeEffectiveStake() returns 0
// manageStake() reverts with Frozen()
```

## Integration with Redistribution

The `nodeEffectiveStake()` value is used in the redistribution game to:
1. Weight commit selection during truth consensus
2. Calculate stake density for winner selection
3. Determine eligibility for participation

## Examples

### Creating a Stake

```solidity
// Approve tokens first
ERC20(bzzToken).approve(stakeRegistry, 2000000000000000000);

// Create stake
StakeRegistry(stakeRegistry).manageStake(
    keccak256("my-nonce"),   // nonce
    2000000000000000000,     // 2 BZZ
    2                         // height = 2 (4x capacity)
);
```

### Checking Stake Status

```solidity
uint256 effective = StakeRegistry(stakeRegistry).nodeEffectiveStake(myAddress);
bytes32 overlay = StakeRegistry(stakeRegistry).overlayOfAddress(myAddress);
uint8 height = StakeRegistry(stakeRegistry).heightOfAddress(myAddress);
bool isFrozen = StakeRegistry(stakeRegistry).lastUpdatedBlockNumberOfAddress(myAddress) > block.number;
```

### Withdrawing Surplus

```solidity
uint256 surplus = StakeRegistry(stakeRegistry).withdrawableStake();
if (surplus > 0) {
    StakeRegistry(stakeRegistry).withdrawFromStake();
}
```

### Changing Overlay

```solidity
// Change overlay without depositing
StakeRegistry(stakeRegistry).manageStake(
    keccak256("new-nonce"),  // new nonce
    0,                        // no additional deposit
    2                         // keep same height
);
```

## Error Codes

```solidity
error TransferFailed();              // Token transfer failed
error Frozen();                      // Node is frozen
error Unauthorized();                // Only admin
error OnlyRedistributor();          // Only redistributor role
error OnlyPauser();                  // Only pauser role
error BelowMinimumStake();          // First deposit below minimum
error DecreasedCommitment();         // Committed stake cannot decrease
```

## Security Considerations

1. **Minimum Stake**: Prevents dust attacks
2. **Non-Decreasing Commitment**: Prevents gaming the system
3. **Freeze Mechanism**: Temporary penalty without full slash
4. **Pausability**: Emergency stop with migration path
5. **Frozen Check**: Prevents stake modifications during penalty

## Overlay Calculation

The `reverse()` function byte-reverses the network ID for the overlay calculation. This is done for endianness consistency between different systems that calculate overlays.

```solidity
function reverse(uint64 input) internal pure returns (uint64 v) {
    v = input;
    // swap bytes
    v = ((v & 0xFF00FF00FF00FF00) >> 8) | ((v & 0x00FF00FF00FF00FF) << 8);
    // swap 2-byte long pairs
    v = ((v & 0xFFFF0000FFFF0000) >> 16) | ((v & 0x0000FFFF0000FFFF) << 16);
    // swap 4-byte long pairs
    v = (v >> 32) | (v << 32);
}
```

## Related Contracts

- **Token**: ERC20 token used for staking
- **PriceOracle**: Provides current price for calculations
- **Redistribution**: Uses effective stake for game participation

