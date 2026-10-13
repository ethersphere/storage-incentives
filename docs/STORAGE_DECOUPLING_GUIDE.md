# PostageStamp Storage Decoupling - Implementation Guide

## Overview

This guide explains the PostageStamp storage decoupling architecture, where storage and logic are separated to enable seamless upgrades without token or data migration.

## Architecture

```
                    ┌─────────────────────────────────────┐
                    │      PostageStampStorage            │
                    │      (deployed once, forever)       │
                    │                                     │
                    │   • Holds all BZZ tokens            │
                    │   • Stores all batch data           │
                    │   • Stores order statistics tree    │
                    │   • Stores global state             │
                    │                                     │
                    │   Admin: Multisig (set in constructor)
                    │                                     │
                    │   WRITER_ROLE granted to:           │
                    │   ├── PostageStamp v1.0 ✓          │
                    │   ├── PostageStamp v1.1 ✓          │
                    │   └── PostageStamp v2.0 ✓          │
                    └─────────────────────────────────────┘
                              ▲       ▲       ▲
                              │       │       │
                 ┌────────────┘       │       └────────────┐
                 │                    │                    │
        ┌────────┴────────┐  ┌───────┴───────┐  ┌────────┴────────┐
        │ PostageStamp    │  │ PostageStamp  │  │ PostageStamp    │
        │ v1.0 (logic)    │  │ v1.1 (logic)  │  │ v2.0 (logic)    │
        │                 │  │               │  │                 │
        │ storageContract │  │storageContract│  │ storageContract │
        │ = 0xStorage     │  │= 0xStorage    │  │ = 0xStorage     │
        └────────┬────────┘  └───────┬───────┘  └────────┬────────┘
                 │                   │                    │
                 ▼                   ▼                    ▼
        ┌────────────────┐  ┌───────────────┐  ┌────────────────┐
        │  Bee v1.0.0    │  │  Bee v1.1.0   │  │  Bee v2.0.0    │
        │ (hardcoded to  │  │ (hardcoded to │  │ (hardcoded to  │
        │  v1.0 logic)   │  │  v1.1 logic)  │  │  v2.0 logic)   │
        └────────────────┘  └───────────────┘  └────────────────┘
```

### PostageStampStorage (Immutable)
- Deployed once with multisig as permanent admin
- Holds all BZZ tokens and batch data
- Uses role-based access control (WRITER_ROLE)
- Multiple logic contracts can have write access simultaneously
- **Never needs code changes** - only role management

### PostageStamp Logic Contracts (Versioned)
- Contains all business logic
- Points to storage contract (immutable reference)
- Each version is a separate deployment
- Bee nodes choose which version to use
- Can be upgraded without affecting storage

## Key Concepts

### Role-Based Access Control

| Role | Holder | Can Do |
|------|--------|--------|
| DEFAULT_ADMIN_ROLE | Multisig | Grant/revoke WRITER_ROLE |
| WRITER_ROLE | PostageStamp logic contracts | Modify storage data |
| EMERGENCY_ROLE | Multisig | Emergency operations |

### Bee Node Versioning

Each Bee node version is hardcoded to use a specific PostageStamp logic contract address:

```go
// In Bee node configuration
const PostageStampAddress = "0x..." // Specific to this Bee version
```

This means:
- **Bee v1.0.0** → uses PostageStamp v1.0 at 0xAAA...
- **Bee v1.1.0** → uses PostageStamp v1.1 at 0xBBB...
- **Bee v2.0.0** → uses PostageStamp v2.0 at 0xCCC...

All versions share the same PostageStampStorage contract.

## Benefits

1. **Zero-Migration Upgrades**: Deploy new logic without moving funds or data
2. **Gradual Network Migration**: Old and new Bee versions coexist during transition
3. **Reduced Risk**: Tokens stay in the same trusted storage contract
4. **Simple Governance**: Only role management needed, no complex upgrades
5. **Version Flexibility**: Can maintain multiple active versions simultaneously
6. **Rollback Capability**: Can revoke new version and keep old one if issues arise

## Deployment

### Initial Deployment (Storage + First Logic)

```bash
# 1. Set environment variables
export BZZ_TOKEN_ADDRESS="0x..."
export MULTISIG_ADDRESS="0x..."  # Permanent admin

# 2. Deploy storage and logic
npx hardhat deploy --tags postageStamp --network <network>
```

**What happens:**
1. PostageStampStorage deploys with multisig as admin
2. PostageStamp (logic v1) deploys pointing to storage
3. Multisig grants WRITER_ROLE to logic contract
4. System is ready to use

### Deploying New Logic Version

When upgrading to a new Bee version:

```bash
# 1. Deploy new logic contract (pointing to existing storage)
npx hardhat deploy --tags postageStampLogic --network <network>

# 2. Multisig grants WRITER_ROLE to new logic
# (via Safe UI or script)
storage.grantRole(WRITER_ROLE, newLogicAddress)

# 3. New Bee version uses the new logic address
# (hardcoded in Bee binary)
```

**No storage changes required!**

### Multisig Operations

The multisig can perform these operations on storage:

```solidity
// Grant write access to new logic contract
storage.grantRole(storage.WRITER_ROLE(), newPostageStampAddress);

// Revoke write access from old logic contract (optional)
storage.revokeRole(storage.WRITER_ROLE(), oldPostageStampAddress);

// Check if an address has write access
storage.isWriter(someAddress);  // returns bool

// Check if an address is admin
storage.isAdmin(someAddress);   // returns bool
```

## Migration from Legacy PostageStamp

For networks with existing (monolithic) PostageStamp contracts:

```bash
# 1. Prepare batch data
npx hardhat run scripts/migration/exportBatchIds.ts --network <network>

# 2. Announce maintenance window (24h notice recommended)

# 3. Run migration
export OLD_POSTAGE_STAMP="0x..."
export BZZ_TOKEN="0x..."
export MULTISIG="0x..."
npx hardhat run scripts/migration/migrateToStorageDecoupling.ts --network <network>

# 4. Verify migration
npx hardhat run scripts/migration/verifyMigration.ts --network <network>

# 5. Update Bee nodes to use new PostageStamp address
```

**Migration steps:**
1. Pause old PostageStamp contract
2. Deploy PostageStampStorage with multisig admin
3. Deploy PostageStamp logic pointing to storage
4. Copy all batch data to storage
5. Transfer all BZZ tokens to storage
6. Grant WRITER_ROLE to logic contract
7. Verify everything works

## Key Functions

### PostageStampStorage

```solidity
// Role Management (multisig only)
function grantRole(bytes32 role, address account) external;
function revokeRole(bytes32 role, address account) external;
function isWriter(address _address) external view returns (bool);
function isAdmin(address _address) external view returns (bool);

// Batch Operations (WRITER_ROLE only)
function storeBatch(bytes32 _batchId, Batch calldata _batch) external;
function getBatch(bytes32 _batchId) external view returns (Batch memory);
function deleteBatch(bytes32 _batchId) external;
function batchExists(bytes32 _batchId) external view returns (bool);

// Tree Operations (WRITER_ROLE only)
function treeInsert(bytes32 _batchId, uint256 _normalisedBalance) external;
function treeRemove(bytes32 _batchId, uint256 _normalisedBalance) external;
function treeFirst() external view returns (uint256);
function treeCount() external view returns (uint256);

// Token Operations (WRITER_ROLE only)
function transferToken(address _token, address _to, uint256 _amount) external;
function transferTokenFrom(address _token, address _from, uint256 _amount) external;
function tokenBalance(address _token) external view returns (uint256);

// Global State (WRITER_ROLE can set, anyone can read)
function setTotalOutPayment(uint256 _totalOutPayment) external;
function getTotalOutPayment() external view returns (uint256);
function setValidChunkCount(uint256 _validChunkCount) external;
function getValidChunkCount() external view returns (uint256);
function setPot(uint256 _pot) external;
function getPot() external view returns (uint256);
// ... etc
```

### PostageStamp (Logic Contract)

```solidity
// User Operations
function createBatch(...) external returns (bytes32);
function topUp(bytes32 _batchId, uint256 _topupAmountPerChunk) external;
function increaseDepth(bytes32 _batchId, uint8 _newDepth) external;

// Oracle Operations (PRICE_ORACLE_ROLE)
function setPrice(uint256 _price) external;

// Redistribution Operations (REDISTRIBUTOR_ROLE)
function withdraw(address beneficiary) external;

// Batch Expiry
function expireLimited(uint256 limit) public;

// View Functions
function remainingBalance(bytes32 _batchId) public view returns (uint256);
function currentTotalOutPayment() public view returns (uint256);
function batches(bytes32 _batchId) public view returns (...);
function bzzToken() public view returns (address);
function storageContract() public view returns (address);
```

## Security Considerations

### Access Control Summary

**PostageStampStorage:**
- DEFAULT_ADMIN_ROLE → Multisig (set once in constructor, forever)
- WRITER_ROLE → PostageStamp logic contracts (granted by multisig)

**PostageStamp (Logic):**
- DEFAULT_ADMIN_ROLE → Can grant/revoke other roles
- PRICE_ORACLE_ROLE → Can update storage price
- REDISTRIBUTOR_ROLE → Can withdraw pot
- PAUSER_ROLE → Can pause operations

### Best Practices

1. **Multisig for Storage Admin**: Always use a multisig (e.g., Gnosis Safe) as the storage admin
2. **Audit New Logic**: Audit every new logic contract before granting WRITER_ROLE
3. **Gradual Rollout**: Grant WRITER_ROLE to new logic, monitor, then optionally revoke old
4. **Keep Old Versions Active**: During migration, keep old logic with WRITER_ROLE until network has transitioned
5. **Monitor Role Changes**: Set up alerts for RoleGranted and RoleRevoked events

### Upgrade Safety

Safe upgrade process:
1. Deploy new logic contract
2. Multisig grants WRITER_ROLE to new logic
3. Release new Bee version pointing to new logic
4. Monitor network during migration
5. (Optional) Revoke WRITER_ROLE from old logic after full migration

**Note:** Multiple logic contracts can have WRITER_ROLE simultaneously. This is intentional to allow gradual migration.

## Troubleshooting

### Issue: New logic contract can't modify storage

**Cause**: Logic contract doesn't have WRITER_ROLE

**Solution**:
```solidity
// Check if logic has write access
storage.isWriter(logicAddress)  // Should return true

// If false, multisig needs to grant role
storage.grantRole(WRITER_ROLE, logicAddress)
```

### Issue: Token transfers failing

**Cause**: User hasn't approved storage contract for token transfers

**Solution**: Users must approve PostageStampStorage (not the logic contract) to spend their BZZ tokens.

### Issue: Batches not showing after migration

**Cause**: Tree not properly rebuilt during migration

**Solution**:
1. Verify batches are stored: storage.getBatch(batchId)
2. Verify tree is populated: storage.treeCount()
3. Re-run tree insertion for missing batches

## FAQ

**Q: Can multiple logic contracts write to storage simultaneously?**

A: Yes! This is by design. Multiple PostageStamp versions can have WRITER_ROLE at the same time, allowing gradual network migration between Bee versions.

**Q: What if we need to revoke a malicious logic contract?**

A: The multisig can call storage.revokeRole(WRITER_ROLE, maliciousAddress) to immediately revoke write access.

**Q: How do I check which logic contracts have write access?**

A: Call storage.isWriter(address) for specific addresses, or monitor RoleGranted events for WRITER_ROLE.

**Q: Can the multisig be changed?**

A: The multisig has DEFAULT_ADMIN_ROLE which means it can grant DEFAULT_ADMIN_ROLE to a new multisig and revoke it from itself. However, this should be done carefully.

**Q: What happens to old logic contracts?**

A: They remain on-chain. You can:
- Keep their WRITER_ROLE active (safe if no Bee nodes use them)
- Revoke their WRITER_ROLE after migration is complete
- They can still be used for read-only queries

**Q: How much does an upgrade cost?**

A: Only the gas to:
1. Deploy new logic contract (~2M gas)
2. Multisig calls grantRole() (~50K gas)

No token transfers or data migration needed!

**Q: What if the storage contract has a bug?**

A: The storage contract is intentionally simple to minimize bug risk. If a critical bug is found, a new storage contract would need to be deployed with data migration (similar to initial migration from legacy).

## Testing

### Unit Tests

```bash
npx hardhat test test/PostageStamp.test.ts
```

### Full Test Suite

```bash
npx hardhat test
```

## References

- SWIP Document: [SWIP-storage-decoupling.md](../SWIP-storage-decoupling.md)
- Storage Contract: [src/PostageStampStorage.sol](../src/PostageStampStorage.sol)
- Logic Contract: [src/PostageStamp.sol](../src/PostageStamp.sol)
- Interface: [src/interface/IPostageStampStorage.sol](../src/interface/IPostageStampStorage.sol)
- Migration Script: [scripts/migration/migrateToStorageDecoupling.ts](../scripts/migration/migrateToStorageDecoupling.ts)
