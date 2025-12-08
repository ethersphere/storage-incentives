# PostageStamp Storage Decoupling - Implementation Guide

## Overview

This guide explains the PostageStamp storage decoupling architecture and how to deploy, migrate, and upgrade the system.

## Architecture

The new architecture separates storage from logic into two contracts:

### PostageStampStorage (Immutable)
- Holds all BZZ tokens
- Stores all batch data and the order statistics tree
- Stores global state variables
- **Never needs to be upgraded or replaced**
- Only the authorized logic contract can modify data

### PostageStamp (Upgradeable)
- Contains all business logic
- Stateless (except configuration)
- Can be upgraded by deploying a new version (tracked via git tags)
- **Upgrading requires NO token or data migration**

## Benefits

1. **Zero-Migration Upgrades**: Deploy new logic without moving funds or data
2. **Reduced Risk**: Tokens stay in the same trusted, immutable contract
3. **Faster Iteration**: Lower upgrade costs enable more improvements
4. **Simple Updates**: Nodes just update the logic contract address
5. **Backward Compatible**: Old logic can continue in read-only mode

## Deployment Scenarios

### Scenario 1: Fresh Deployment (No Existing PostageStamp)

Use this for new networks or testnets without existing PostageStamp contracts.

```bash
# 1. Set environment variables
export BZZ_TOKEN_ADDRESS="0x..."
export ADMIN_ADDRESS="0x..."
export PRICE_ORACLE_ADDRESS="0x..."
export REDISTRIBUTOR_ADDRESS="0x..."

# 2. Run deployment script
npx hardhat deploy --tags PostageStamp --network <network>

# 3. Tag the deployment
git tag -a v2.0.0 -m "Initial storage decoupling deployment"

# 4. Update Swarm node configurations with the PostageStamp address
```

**What happens:**
1. PostageStampStorage deploys with BZZ token reference
2. PostageStamp (logic contract) deploys pointing to storage
3. Roles are configured
4. Deployment is tagged in git for versioning
5. System is ready to use

### Scenario 2: Migration from Existing PostageStamp

Use this for mainnet or networks with existing PostageStamp contracts.

```bash
# 1. Prepare batch data
# Export all batch IDs from events or indexer
npx hardhat run scripts/migration/exportBatchIds.ts --network <network>

# 2. Announce maintenance window to users
# Recommended: At least 24 hours notice

# 3. Run migration script
export OLD_POSTAGE_STAMP="0x..."
export BZZ_TOKEN="0x..."
npx hardhat run scripts/migration/migrateToStorageDecoupling.ts --network <network>

# 4. Verify migration
npx hardhat run scripts/migration/verifyMigration.ts --network <network>

# 5. Update all Swarm nodes to use new PostageStampV2 address

# 6. Monitor for 24-48 hours
```

**What happens:**
1. Old PostageStamp contract (legacy) is paused
2. New contracts are deployed (PostageStampStorage + PostageStamp logic)
3. All batch data is copied to PostageStampStorage
4. All BZZ tokens are transferred to PostageStampStorage
5. Global state is set in storage
6. Deployment is tagged in git (e.g., v2.0.0)
7. Verification confirms successful migration

## Upgrading the Logic Contract

Once deployed, upgrading to a new version is simple:

```bash
# 1. Checkout new version from git
git checkout v2.1.0

# 2. Deploy updated logic contract
npx hardhat deploy --tags PostageStamp --network <network>

# 3. Update storage to point to new logic
# (Requires ADMIN_ROLE on PostageStampStorage)
npx hardhat run scripts/updateLogicContract.ts --network <network>

# 4. Update Swarm nodes to use new PostageStamp address

# 5. (Optional) Pause old PostageStamp instance to prevent confusion
```

**No token or data migration required!**

Version tracking is handled via git tags (e.g., v2.0.0, v2.1.0, v3.0.0) rather than contract naming.

## Key Functions

### PostageStampStorage

```solidity
// Batch operations
function storeBatch(bytes32 _batchId, Batch calldata _batch) external;
function getBatch(bytes32 _batchId) external view returns (Batch memory);
function deleteBatch(bytes32 _batchId) external;

// Tree operations
function treeInsert(bytes32 _batchId, uint256 _normalisedBalance) external;
function treeRemove(bytes32 _batchId, uint256 _normalisedBalance) external;

// Token operations
function transferToken(address _token, address _to, uint256 _amount) external returns (bool);
function transferTokenFrom(address _token, address _from, uint256 _amount) external returns (bool);

// Admin operations
function updateLogicContract(address _newLogicContract) external; // ADMIN_ROLE only
```

### PostageStamp (Logic Contract)

```solidity
// Same interface as original PostageStamp
function createBatch(...) external returns (bytes32);
function topUp(bytes32 _batchId, uint256 _topupAmountPerChunk) external;
function increaseDepth(bytes32 _batchId, uint8 _newDepth) external;
function setPrice(uint256 _price) external; // PRICE_ORACLE_ROLE
function withdraw(address beneficiary) external; // REDISTRIBUTOR_ROLE
function expireLimited(uint256 limit) public;

// View functions
function remainingBalance(bytes32 _batchId) public view returns (uint256);
function currentTotalOutPayment() public view returns (uint256);
function batches(bytes32 _batchId) public view returns (...);
```

## Security Considerations

### Access Control

**PostageStampStorage:**
- `ADMIN_ROLE`: Can update logic contract address (use multi-sig!)
- `onlyLogicContract` modifier: Only authorized logic can modify storage

**PostageStamp (Logic Contract):**
- `DEFAULT_ADMIN_ROLE`: Can grant/revoke other roles
- `PRICE_ORACLE_ROLE`: Can update storage price
- `REDISTRIBUTOR_ROLE`: Can withdraw pot
- `PAUSER_ROLE`: Can pause operations

### Best Practices

1. **Multi-sig for Admin**: Use a multi-sig wallet for the ADMIN_ROLE on PostageStampStorage
2. **Audit Before Upgrade**: Always audit new logic contracts before upgrading
3. **Gradual Rollout**: Test on testnet, then gradually roll out on mainnet
4. **Monitor After Upgrade**: Watch for unexpected behavior for 24-48 hours
5. **Keep Old Logic**: Don't remove old logic contracts, they provide read-only access

### Upgrade Safety

During an upgrade:
1. **Pause old logic contract** to prevent new writes
2. **Deploy and configure new logic contract**
3. **Update storage pointer atomically**
4. **Update node configurations**
5. **Monitor for issues**

## Testing

### Unit Tests

```bash
npx hardhat test test/PostageStampStorage.test.ts
npx hardhat test test/PostageStamp.test.ts
```

### Integration Tests

```bash
npx hardhat test test/StorageDecoupling.integration.test.ts
```

### Upgrade Simulation

```bash
npx hardhat test test/UpgradeSimulation.test.ts
```

## Troubleshooting

### Issue: Logic contract can't modify storage

**Cause**: Storage contract's `logicContract` address doesn't match

**Solution**:
```bash
# Check current logic address
npx hardhat run scripts/checkLogicAddress.ts

# Update if needed
npx hardhat run scripts/updateLogicContract.ts
```

### Issue: Token transfers failing

**Cause**: Logic contract not approved to move tokens from storage

**Solution**: The storage contract holds tokens and logic contract calls `transferToken()` or `transferTokenFrom()` on storage, which handles the actual ERC20 calls.

### Issue: Batches not showing up after migration

**Cause**: Tree not properly rebuilt during migration

**Solution**:
1. Verify batches are stored: Call `storage.getBatch(batchId)`
2. Verify tree is populated: Call `storage.treeCount()`
3. Re-run tree insertion for missing batches

## FAQ

**Q: What happens to the old PostageStamp contract after migration?**

A: It remains on-chain but should be paused. You can keep it for historical reference and read-only queries.

**Q: Can I downgrade to an older logic contract?**

A: Yes! You can update the storage contract to point back to an older logic contract if needed. This is useful for emergency rollbacks.

**Q: How much does an upgrade cost?**

A: Only the gas to deploy the new logic contract and call `updateLogicContract()`. No token transfers or data migration needed!

**Q: What if the storage contract has a bug?**

A: Since the storage contract is immutable, bugs cannot be fixed in-place. However, the simple storage contract is much easier to audit and less likely to have bugs than complex logic. In an extreme case, you could migrate to a new storage contract using the same process as the initial migration.

**Q: Can multiple logic contracts use the same storage?**

A: No, only one logic contract can be authorized at a time. This prevents conflicts and ensures data consistency.

## Support

For questions or issues:
- Open an issue on GitHub
- Join the Swarm Discord
- Read the SWIP document: `SWIP-storage-decoupling.md`

## References

- SWIP Document: [SWIP-storage-decoupling.md](../SWIP-storage-decoupling.md)
- Deployment Script: [deploy/PostageStamp.deploy.ts](../deploy/PostageStamp.deploy.ts)
- Migration Script: [scripts/migration/migrateToStorageDecoupling.ts](../scripts/migration/migrateToStorageDecoupling.ts)
- Interface: [src/interface/IPostageStampStorage.sol](../src/interface/IPostageStampStorage.sol)
- Storage Contract: [src/PostageStampStorage.sol](../src/PostageStampStorage.sol)
- Logic Contract: [src/PostageStamp.sol](../src/PostageStamp.sol)
