# PriceOracle Contract

## Overview

The `PriceOracle` contract implements a dynamic pricing mechanism for storage on the Swarm network. It automatically adjusts prices based on network redundancy to maintain optimal storage coverage.

## Purpose

The oracle:
- Dynamically adjusts per-chunk storage prices based on actual network redundancy
- Targets a specific redundancy level (default: 4 copies per chunk)
- Updates prices every 152 blocks (~19 minutes on Ethereum)
- Enforces a minimum price floor
- Integrates with PostageStamp to keep prices synchronized

## Key Concepts

### Target Redundancy

The system aims for a target redundancy of 4, meaning on average each chunk should be stored on 4 nodes.

### Price Adjustment Mechanism

Prices adjust based on revealed nodes in the redistribution game:
- **High redundancy** (> target): Price decreases (discourage storage)
- **Low redundancy** (< target): Price increases (encourage storage)
- **Target redundancy**: Price stays stable

### Rounds

The oracle operates in rounds of 152 blocks:
- Roughly 19 minutes on Ethereum (5s blocks)
- Only one price adjustment per round
- Skips rounds accumulate maximum price increase

### Change Rate Table

The contract uses a lookup table for price changes:

```solidity
// [max decrease, ..., stable, ..., max increase]
changeRate = [
    1049417,  // 4+ extra redundancy → +0.08%/round
    1049206,  // 3 extra redundancy → +0.06%
    1048996,  // 2 extra redundancy → +0.04%
    1048786,  // 1 extra redundancy → +0.02%
    1048576,  // Target redundancy → 0%
    1048366,  // 1 below target → -0.02%
    1048156,  // 2 below target → -0.04%
    1047946,  // 3 below target → -0.06%
    1047736   // 4 below target → -0.08%
]
```

The index in this array represents: `redundancy - targetRedundancy + 4`

## Functions

### Admin Functions

#### setPrice()
Manually sets the price (for initialization or emergency).

**Parameters**:
- `_price`: New price value

**Requirements**:
- Only `DEFAULT_ADMIN_ROLE` can call

**Logic**:
```solidity
currentPriceUpScaled = _price << 10  // upscale by 2^10
if (currentPriceUpScaled < minimumPriceUpscaled) {
    currentPriceUpScaled = minimumPriceUpscaled
}
// Update PostageStamp
PostageStamp.setPrice(currentPrice())
emit PriceUpdate(currentPrice())
```

#### adjustPrice()
Automatically adjusts price based on redundancy (called by Redistribution).

**Parameters**:
- `redundancy`: Number of nodes that revealed in the current round

**Requirements**:
- Only `PRICE_UPDATER_ROLE` can call (typically Redistribution contract)
- Contract must not be paused
- Can only be called once per round

**Logic**:
1. Check if already adjusted this round
2. Cap redundancy at `targetRedundancy + maxConsideredExtraRedundancy`
3. Apply change rate based on redundancy - target
4. Apply maximum penalty for skipped rounds
5. Enforce minimum price
6. Update PostageStamp
7. Emit event

**Skipped Rounds Handling**:
```solidity
if (skippedRounds > 0) {
    // Apply maximum increase rate for each skipped round
    for each skipped round {
        currentPriceUpScaled = (changeRate[0] * currentPriceUpScaled) / priceBase
    }
}
```

#### pause() / unPause()
Pauses or unpauses price adjustments.

**Requirements**:
- Only `DEFAULT_ADMIN_ROLE` can call

**Effects**:
- When paused: `adjustPrice()` returns false without doing anything
- Manual `setPrice()` still works

### View Functions

#### currentPrice()
Returns the current price (downscaled by 2^10).

#### minimumPrice()
Returns the minimum price floor.

#### currentRound()
Returns the current round number: `block.number / 152`

### Configuration Parameters

```solidity
uint16 targetRedundancy = 4;           // Target chunks per node
uint16 maxConsideredExtraRedundancy = 4; // Cap on extra redundancy
uint32 minimumPriceUpscaled = 24000 << 10; // ~23.44 (downscaled)
uint32 priceBase = 1048576;            // Base for change rate (2^20)
```

## Events

```solidity
event PriceUpdate(uint256 price);             // Emitted on price changes
event StampPriceUpdateFailed(uint256 attemptedPrice); // If PostageStamp update fails
```

## Roles

- **DEFAULT_ADMIN_ROLE**: Can set price manually, pause/unpause
- **PRICE_UPDATER_ROLE**: Can call adjustPrice() (granted to Redistribution)

## Deployment Configuration

```typescript
constructor(address _postageStamp)
```

- `_postageStamp`: Address of PostageStamp contract

**Initialization**:
- Sets up admin role
- Links to PostageStamp
- Sets `lastAdjustedRound = currentRound()`
- Emits initial price

## Price Calculation Details

### Upscaling

Prices are stored upscaled by 2^10 (1024) to avoid rounding errors in integer arithmetic:
- **Stored**: `24000 << 10 = 24576000`
- **Displayed**: `24576000 >> 10 = 24000`
- Allows for fractional change rates without floating point

### Change Rate Calculation

The change rate is applied multiplicatively:
```solidity
newPrice = (changeRate * oldPrice) / priceBase
```

For example, with changeRate = 1049417:
```
newPrice = (1049417 * 1000000) / 1048576 = 1000800
// Increase of ~0.08%
```

### Minimum Price Enforcement

Prices are bounded from below:
```solidity
if (currentPriceUpScaled < minimumPriceUpscaled) {
    currentPriceUpScaled = minimumPriceUpscaled
}
```

This prevents prices from becoming too low and disincentivizing storage.

## Integration with Other Contracts

### PostageStamp Integration

After every price change, the oracle updates PostageStamp:
```solidity
(bool success, ) = address(postageStamp).call(
    abi.encodeWithSignature("setPrice(uint256)", uint256(currentPrice()))
);
```

If the update fails, an event is emitted but the adjustment continues.

### Redistribution Integration

Redistribution calls `adjustPrice(redundancyCount)` after each reveal phase, using the count of valid reveals as the redundancy metric.

## Round Schedule

```
Round N:
  Block 0    - Round starts (adjustPrice can be called)
  Block 1-38  - Reveal phase (Redistribution collects reveals)
  Block 38    - adjustPrice called with redundancy count
  Block 152   - Round ends, new round starts
```

## Examples

### Manual Price Update

```solidity
// Admin manually sets price to 50000
PriceOracle(oracle).setPrice(50000);
```

### Automatic Adjustment

```solidity
// Redistribution calls after reveal phase
// If 6 nodes revealed and target is 4:
// redundancy - target = 6 - 4 = 2 → index 2 + 4 = 6
// changeRate[6] = 1048996 → price increases by ~0.04%

PriceOracle(oracle).adjustPrice(6);
```

### Checking Current Price

```solidity
uint32 price = PriceOracle(oracle).currentPrice();
uint32 min = PriceOracle(oracle).minimumPrice();
uint64 round = PriceOracle(oracle).currentRound();
```

## Error Codes

```solidity
error CallerNotAdmin();         // Only admin can call
error CallerNotPriceUpdater();  // Only price updater can call
error PriceAlreadyAdjusted();   // Already adjusted this round
error UnexpectedZero();         // Redundancy must be > 0
```

## Security Considerations

1. Minimum price floor prevents race-to-bottom pricing
2. Maximum extra redundancy cap prevents excessive price increases
3. One adjustment per round prevents manipulation
4. Pausable for emergency stops
5. Failed PostageStamp updates don't prevent oracle updates

## Pause Mechanism

When paused:
- `adjustPrice()` returns `false` without making changes
- `setPrice()` still works for manual intervention
- Can be made immutable by renouncing roles after pausing

## Price Adjustment Algorithm

```
function adjustPrice(redundancy):
    if (contract is paused):
        return false
    
    usedRedundancy = min(redundancy, targetRedundancy + maxConsideredExtraRedundancy)
    currentRoundNum = currentRound()
    
    // Enforce once-per-round
    if (currentRoundNum <= lastAdjustedRound):
        revert PriceAlreadyAdjusted()
    
    skippedRounds = currentRoundNum - lastAdjustedRound - 1
    
    // Apply change rate based on redundancy
    changeRateIndex = usedRedundancy
    newPrice = (changeRate[changeRateIndex] * currentPriceUpScaled) / priceBase
    
    // Apply maximum rate for skipped rounds
    for each skipped round:
        newPrice = (changeRate[0] * newPrice) / priceBase
    
    // Enforce minimum
    if (newPrice < minimumPriceUpscaled):
        newPrice = minimumPriceUpscaled
    
    currentPriceUpScaled = newPrice
    lastAdjustedRound = currentRoundNum
    
    // Update PostageStamp
    update PostageStamp price
    emit PriceUpdate(currentPrice())
    return true
```

## Network Effects

The price oracle creates a self-balancing system:

1. **High redundancy** → Price decreases → Less new storage → Redundancy normalizes
2. **Low redundancy** → Price increases → More new storage → Redundancy normalizes
3. **Target redundancy** → Stable prices → Sustainable equilibrium

This mechanism ensures the network maintains adequate data redundancy without manual intervention.

