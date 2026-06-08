# Swarm Storage Incentive System - Overview

## Introduction

The Swarm Storage Incentive (SI) system is a decentralized mechanism that rewards nodes for storing data on the Swarm network. The system consists of four main smart contracts that work together to manage postage stamps, dynamic pricing, staking, and redistribution rewards.

## System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Smart Contracts System                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │   Token      │───▶│ PostageStamp │◀───│ PriceOracle  │      │
│  │  (ERC20)     │    │              │    │              │      │
│  └──────┬───────┘    └──────┬───────┘    └──────┬───────┘      │
│         │                   │                   │              │
│         │                   │                   │              │
│         ▼                   ▼                   │              │
│  ┌──────────────┐    ┌──────────────┐          │              │
│  │   Staking    │◀───│ Redistribution│──────┘                 │
│  │  Registry    │    │              │                          │
│  └──────────────┘    └──────────────┘                          │
└─────────────────────────────────────────────────────────────────┘
```

## System Flow

### 1. Postage Stamp Creation

Users purchase postage stamps to store data on Swarm:

```
User → PostageStamp.createBatch()
  ├─ Calculate initial balance per chunk
  ├─ Normalize balance with current price
  ├─ Store batch in order statistics tree
  └─ Track valid chunk capacity
```

**Key Concept**: Normalized balance represents the balance as if the batch existed since contract inception, accounting for all historical price changes.

### 2. Staking for Node Operators

Node operators stake BZZ to participate in the redistribution game:

```
Node Operator → StakeRegistry (queued updates)
  ├─ createDeposit / addTokens / increaseHeight / changeOverlay
  ├─ overlay = keccak256(owner, networkId, nonce)
  ├─ applyUpdates after round delays
  └─ withdraw / exit (with WAIT_WITHDRAWAL)
```

**Key Concept**: Height sets the minimum stake (`MIN_STAKE * 2^height`). Effective stake for the game is the previewed BZZ balance while not frozen (no oracle in staking).

### 3. Redistribution Game Phases

The redistribution game runs in continuous rounds with three distinct phases:

#### Phase 1: Commit (25% of round = 38 blocks ≈ 3 minutes)
- Nodes calculate reserve commitment hash from stored chunks
- Create obfuscated commit with random nonce
- Submit hash commitment

#### Phase 2: Reveal (25% of round = 38 blocks ≈ 3 minutes)
- Nodes reveal the actual values used to create commit
- Randomness is updated after each reveal
- Anchor is set for proximity calculations
- Only revealed commits in proximity are valid

#### Phase 3: Claim (50% of round = 76 blocks ≈ 6 minutes)
- Select truth-teller based on stake density
- Randomly select winner from truth-tellers
- Verify proof of chunk inclusion in reserve
- Transfer pot from PostageStamp to winner

### 4. Price Adjustment

```
Redistribution → PriceOracle.adjustPrice(redundancy)
  ├─ Calculate redundancy count from reveals
  ├─ Adjust price based on target vs actual
  ├─ Update PostageStamp price
  └─ Pot accumulates from expired batches
```

**Key Mechanism**: Price increases when redundancy < target, decreases when redundancy > target.

## Economic Model

### Postage Stamp Economics

- **Initial Balance**: Paid upfront when creating batch
- **Normalized Balance**: Per-chunk storage cost accumulated over time
- **Valid Chunk Count**: Current capacity of valid batches
- **Pot**: Accumulated funds from expired batches

**Expiration Formula**:
```
Batch expires when: remainingBalance(batchId) <= 0
remainingBalance = normalisedBalance - currentTotalOutPayment()
```

### Staking Economics

- **Balance**: BZZ locked in `StakeRegistry` for the node
- **Height**: Minimum balance scale (`MIN_STAKE * 2^height`); used with reported depth in redistribution
- **Effective Stake**: Previewed balance when overlay is set and account is not frozen

**Example**:
- Node deposits 1 BZZ at height 2 (minimum 0.1 * 4 = 0.4 BZZ)
- `nodeEffectiveStake` returns 1 BZZ (or 0 while frozen)

### Redistribution Economics

- **Round Length**: 152 blocks (~12.7 minutes at 5s/block)
- **Pot Source**: Expired batches accumulate funds
- **Winner Selection**: Stochastic selection weighted by stake density
- **Truth Selection**: Median reveal (by stake density) for consensus

## Security Model

### Role-Based Access Control

Each contract defines specific roles:

**PostageStamp**:
- `DEFAULT_ADMIN_ROLE`: Full admin control
- `PRICE_ORACLE_ROLE`: Can update prices (granted to PriceOracle)
- `REDISTRIBUTOR_ROLE`: Can withdraw pot (granted to Redistribution)
- `PAUSER_ROLE`: Can pause/unpause contract

**PriceOracle**:
- `DEFAULT_ADMIN_ROLE`: Can manually set price, pause
- `PRICE_UPDATER_ROLE`: Can adjust price based on redundancy (granted to Redistribution)

**StakeRegistry**:
- `DEFAULT_ADMIN_ROLE`: Pause / unpause
- `REDISTRIBUTOR_ROLE`: Freeze deposits (granted to Redistribution)

**Redistribution**:
- `DEFAULT_ADMIN_ROLE`: Adjust freezing parameters, pause

### Penalties

Nodes that behave dishonestly face penalties:

1. **Non-Reveal Penalty**: 2x rounds frozen if committed but didn't reveal
2. **Disagreement Penalty**: 1x rounds frozen (with random factor) if revealed wrong truth
3. **Depth-Based Penalty**: Freeze duration = base * 2^reported_depth

### Pausability

All contracts (except Token) implement pausable functionality for emergency situations. They can be provably stopped by renouncing the pauser and admin roles after pausing.

## Key Algorithms

### Batch Expiration Algorithm

```solidity
function expireLimited(uint256 limit) {
    for (each batch in ascending balance order) {
        if (batch.balance <= currentTotalOutPayment) {
            // Batch expired
            pot += batchSize * (balance - lastExpiryBalance)
            validChunkCount -= batchSize
            delete batch
        } else {
            break
        }
    }
    pot += validChunkCount * (currentTotalOutPayment - lastExpiryBalance)
}
```

### Truth Selection Algorithm

```solidity
function getCurrentTruth() {
    currentSum = 0
    for (each reveal in commit order) {
        currentSum += reveal.stakeDensity
        if (random < (reveal.stakeDensity / currentSum)) {
            truth = reveal
        }
    }
    return truth.hash, truth.depth
}
```

### Winner Selection Algorithm

```solidity
function winnerSelection() {
    truth = getCurrentTruth()
    currentSum = 0
    for (each reveal matching truth) {
        currentSum += reveal.stakeDensity
        if (random < (reveal.stakeDensity / currentSum)) {
            winner = reveal
        }
    }
}
```

## Gas Optimization

### Batch Import

For large migrations, use `copyBatchBulk()` which can process 60-90 batches per transaction, with automatic error handling for failed imports.

### Limited Expiration

The `expireLimited()` function allows capping gas usage when many batches expire, preventing block gas limit issues.

### State Variables

- Uses `unchecked` blocks for safe arithmetic
- Leverages order statistics tree for O(log n) batch management
- Minimal storage writes in hot paths

## Upgrade Path

Currently, contracts are NOT upgradeable. For major updates:
1. Deploy new contracts
2. Migrate batches using `copyBatch()` (admin only)
3. Allow users to migrate stakes when paused
4. Transfer admin roles to multisig

## Network IDs

Swarm uses different network IDs for different deployments:
- Mainnet: ID 1
- Testnet (Sepolia): ID 10
- Testnet Light: ID 5

This ensures network isolation and prevents overlay conflicts.

## Further Reading

- [PostageStamp Details](./POSTAGE_STAMP.md)
- [PriceOracle Details](./PRICE_ORACLE.md)
- [StakeRegistry Details](./STAKING.md)
- [Redistribution Details](./REDISTRIBUTION.md)
- [Deployment Guide](./DEPLOYMENT.md)

