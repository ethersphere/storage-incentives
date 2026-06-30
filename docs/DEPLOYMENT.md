# Deployment Guide

## Overview

This guide covers how to deploy and configure the Swarm Storage Incentive contracts on various networks.

## Prerequisites

- Hardhat development environment
- Node.js and yarn/npm
- Access to network (mainnet requires real ETH)

## Deployment Order

The contracts must be deployed in this specific order due to dependencies:

```
1. Token (external or TestToken for testnets)
2. PostageStamp (depends on Token)
3. PriceOracle (depends on PostageStamp)
4. StakeRegistry (depends on Token and PriceOracle)
5. Redistribution (depends on StakeRegistry, PostageStamp, PriceOracle)
6. Role Setup (connects contracts together)
```

## Network Configuration

### Mainnet

- **Chain ID**: 1
- **Swarm Network ID**: 1
- **Block Confirmations**: 6
- **Token**: Must use deployed BZZ token
- **Multisig**: `0xD5C070FEb5EA883063c183eDFF10BA6836cf9816`

### Testnet (Sepolia)

- **Chain ID**: 11155111
- **Swarm Network ID**: 10
- **Block Confirmations**: 6
- **Token**: Uses TestToken with minting
- **Multisig**: `0xb1C7F17Ed88189Abf269Bf68A3B2Ed83C5276aAe`

### Testnet Light

- **Chain ID**: TBD
- **Swarm Network ID**: 5
- **Block Confirmations**: 6
- **Token**: Uses TestToken
- **Multisig**: `0xb1C7F17Ed88189Abf269Bf68A3B2Ed83C5276aAe`

### Tenderly

- **Swarm Network ID**: 1
- **Block Confirmations**: 1
- **Used for**: Testing deployments

## Deployment Scripts

### Step 1: Token

**File**: `deploy/main/000_deploy_token.ts`

For mainnet:
```bash
# Expects Token to already exist
# Will error if not found
```

For testnets:
```bash
# Deploys TestToken with 16 decimals
# Mints initial supply to deployer
```

### Step 2: PostageStamp

**File**: `deploy/main/001_deploy_postage.ts`

**Constructor**:
```typescript
[token.address, 16]  // minimumBucketDepth = 16
```

**Deployment**:
```bash
npx hardhat deploy --network mainnet --tags postageStamp
```

### Step 3: PriceOracle

**File**: `deploy/main/002_deploy_oracle.ts`

**Constructor**:
```typescript
[postageStamp.address]
```

**Special Handling**:
- If oracle exists, preserves old price
- Re-applies old price after redeployment

**Deployment**:
```bash
npx hardhat deploy --network mainnet --tags oracle
```

### Step 4: StakeRegistry

**File**: `deploy/main/003_deploy_staking.ts`

**Constructor**:
```typescript
[token.address, swarmNetworkId, priceOracle.address]
```

**Network IDs** (from `helper-hardhat-config.ts`):
- Mainnet: 1
- Testnet: 10
- Testnet Light: 5
- Tenderly: 1

**Deployment**:
```bash
npx hardhat deploy --network mainnet --tags staking
```

### Step 5: Redistribution

**File**: `deploy/main/004_deploy_redistribution.ts`

**Constructor**:
```typescript
[stakeRegistry.address, postageStamp.address, priceOracle.address]
```

**Deployment**:
```bash
npx hardhat deploy --network mainnet --tags redistribution
```

### Step 6: Role Configuration

#### PostageStamp Roles

**File**: `deploy/main/005_deploy_roles_postage.ts`

**Grants**:
- `PRICE_ORACLE_ROLE` → PriceOracle contract
- `REDISTRIBUTOR_ROLE` → Redistribution contract

#### Redistribution Roles

**File**: `deploy/main/006_deploy_roles_redistribution.ts`

Currently no roles need to be set (constructor handles it).

#### StakeRegistry Roles

**File**: `deploy/main/007_deploy_roles_staking.ts`

**Grants**:
- `REDISTRIBUTOR_ROLE` → Redistribution contract

#### PriceOracle Roles

**File**: `deploy/main/008_deploy_roles_oracle.ts`

**Grants**:
- `PRICE_UPDATER_ROLE` → Redistribution contract

**Deployment**:
```bash
npx hardhat deploy --network mainnet --tags roles
```

## Full Deployment

Deploy all contracts in order:

```bash
# Deploy all contracts
npx hardhat deploy --network mainnet

# Deploy only contracts (no roles)
npx hardhat deploy --network mainnet --tags contracts

# Deploy only roles
npx hardhat deploy --network mainnet --tags roles
```

## Deployment Status

### Mainnet

**Network**: Ethereum Mainnet  
**Chain ID**: 1  
**Token**: 0x... (BZZ token)  
**PostageStamp**: 0x...  
**PriceOracle**: 0x...  
**StakeRegistry**: 0x...  
**Redistribution**: 0x...  

See `mainnet_deployed.json` for current addresses.

### Testnet (Sepolia)

**Network**: Sepolia Testnet  
**Chain ID**: 11155111  
See `testnet_deployed.json` for current addresses.

## Verification

After deployment, verify contracts using Hardhat:

```bash
npx hardhat verify --network mainnet \
  <CONTRACT_ADDRESS> \
  <CONSTRUCTOR_ARG1> <CONSTRUCTOR_ARG2> ...
```

## Network Configuration

Configuration is stored in `helper-hardhat-config.ts`:

```typescript
export const networkConfig: networkConfigInfo = {
  mainnet: {
    blockConfirmations: 6,
    swarmNetworkId: 1,
    multisig: '0xD5C070FEb5EA883063c183eDFF10BA6836cf9816',
  },
  testnet: {
    blockConfirmations: 6,
    swarmNetworkId: 10,
    multisig: '0xb1C7F17Ed88189Abf269Bf68A3B2Ed83C5276aAe',
  },
  // ... other networks
};
```

## Role Management

### Granting Roles

```bash
# Example: Grant PRICE_ORACLE_ROLE to an address
npx hardhat send-tx --network mainnet \
  --contract PostageStamp \
  --method grantRole \
  --args ROLE_HASH ADDRESS
```

### Renouncing Roles (Making Immutable)

```bash
# Renounce admin roles to make contracts immutable
npx hardhat send-tx --network mainnet \
  --contract PostageStamp \
  --method renounceRole \
  --args ROLE_HASH ADDRESS
```

## Initial Setup

### 1. Set Initial Price

After oracle deployment:

```bash
npx hardhat send-tx --network mainnet \
  --contract PriceOracle \
  --method setPrice \
  --args 24000
```

This sets the initial price to 24000 (downscaled).

### 2. Configure Minimum Validity

Set minimum batch validity (24h default):

```bash
npx hardhat send-tx --network mainnet \
  --contract PostageStamp \
  --method setMinimumValidityBlocks \
  --args 17280  # 24 * 60 * 60 / 5
```

### 3. Batch Migration

If migrating from old contract:

```typescript
const oldBatches = await getOldBatches();
await PostageStamp.copyBatchBulk(oldBatches);
```

## Monitoring

Check contract status:

```bash
npx hardhat status --target mainnet
```

This shows:
- Contract pause status
- Admin roles
- Role assignments
- Connection status

## Troubleshooting

### Deployment Fails: Token Not Found

**Error**: "Token not available"

**Solution**: For mainnet, token must be deployed first. For testnets, ensure TestToken deployment runs.

### Role Assignment Fails

**Error**: "Deployer needs to have admin role"

**Solution**: Grant admin role to deployer or execute transactions manually from admin account.

### Out of Gas

**Error**: Transaction reverted

**Solution**: Use `copyBatchBulk()` for batch migrations (processes 60-90 batches per tx).

### Price Update Failed

**Warning**: `StampPriceUpdateFailed` event

**Cause**: PostageStamp not responding to price update  
**Solution**: Check PostageStamp status, ensure not paused

## Upgrade Path

Since contracts are NOT upgradeable, upgrades require:

1. Deploy new contracts
2. Use `copyBatch()` to migrate batches (admin only)
3. Allow stake migration via `migrateStake()` when paused
4. Transfer admin roles to multisig
5. Renounce old admin/pauser roles

## Security Checklist

- [ ] All admin roles granted to multisig
- [ ] Pauser roles granted to multisig
- [ ] Initial price set on oracle
- [ ] Minimum validity configured
- [ ] All contracts verified on Etherscan
- [ ] Role setup verified
- [ ] Test initial deposit and withdrawal
- [ ] Test pause/unpause functionality

## Production Deployment

### Mainnet Deployment Steps

1. **Deploy Token** (if not exists)
   ```bash
   npx hardhat deploy --network mainnet --tags token
   ```

2. **Deploy Contracts**
   ```bash
   npx hardhat deploy --network mainnet --tags contracts
   ```

3. **Setup Roles**
   ```bash
   npx hardhat deploy --network mainnet --tags roles
   ```

4. **Set Initial Price**
   ```bash
   npx hardhat send-tx --network mainnet \
     --contract PriceOracle \
     --method setPrice \
     --args 24000
   ```

5. **Grant Additional Admins** (e.g., multisig)
   ```bash
   npx hardhat grant-role --network mainnet \
     --contract PostageStamp \
     --role DEFAULT_ADMIN_ROLE \
     --to 0xD5C070FEb5EA883063c183eDFF10BA6836cf9816
   ```

6. **Verify Contracts**
   ```bash
   npx hardhat verify --network mainnet --all
   ```

7. **Check Status**
   ```bash
   npx hardhat status --target mainnet
   ```

8. **Test End-to-End**
   - Create test batch
   - Stake tokens
   - Participate in redistribution game

## Configuration Files

### hardhat.config.ts

Configures:
- Compiler version (Sol ≥ 0.8.19)
- Networks (mainnet, testnet, etc.)
- Etherscan verification
- Gas optimization

### helper-hardhat-config.ts

Defines:
- Network IDs
- Block confirmations
- Multisig addresses
- Swarm network IDs

### deployments/

Stores:
- Deployment artifacts
- Addresses and ABIs
- Constructor arguments
- Verification data

## Common Commands

```bash
# Deploy all
npx hardhat deploy --network mainnet

# Deploy specific tag
npx hardhat deploy --network mainnet --tags postageStamp

# Run scripts
npx hardhat run scripts/cluster/changePrice.ts --network mainnet

# Check status
npx hardhat status --target mainnet

# Verify contracts
npx hardhat verify --network mainnet CONTRACT_ADDRESS ...

# Get contract info
npx hardhat contracts --target main
```

## Testing Deployment

### Local Testing

```bash
# Deploy to local hardhat network
npx hardhat deploy --network localhost

# Run tests
npx hardhat test
```

### Testnet Testing

```bash
# Deploy to testnet
npx hardhat deploy --network testnet

# Verify on Etherscan
npx hardhat verify --network testnet --all
```

### Gas Estimation

```bash
# Estimate deployment gas
npx hardhat deploy --network mainnet --dry-run
```

## Monitoring After Deployment

Use the status task to monitor contract health:

```bash
npx hardhat status --target mainnet
```

Monitor for:
- Contract pause status
- Admin role assignments
- Role configuration
- Connection issues

## Support

For issues or questions:
- Check deployment logs in `deployments/` directory
- Review error messages in transaction receipts
- Check contract status using `status` task
- Verify role setup using events

