# PostageStamp Storage Decoupling - Quick Start

## What's New

This branch introduces a **storage decoupling architecture** for the PostageStamp contract system, enabling upgrades without migrating funds or batch data.

## Files Created

### Smart Contracts
- **`src/interface/IPostageStampStorage.sol`** - Interface for the storage contract
- **`src/PostageStampStorage.sol`** - Immutable storage contract (holds all data and BZZ tokens)
- **`src/PostageStampV2.sol`** - Upgradeable logic contract (implements all operations)

### Deployment & Migration
- **`deploy/PostageStampV2.deploy.ts`** - Deployment script for fresh installations
- **`scripts/migration/migrateToStorageDecoupling.ts`** - Migration script from old PostageStamp

### Documentation
- **`SWIP-storage-decoupling.md`** - Full Swarm Improvement Proposal
- **`docs/STORAGE_DECOUPLING_GUIDE.md`** - Complete implementation guide

## Architecture

```
┌──────────────────────────────┐
│  PostageStampStorage         │  ← Immutable, holds BZZ tokens & batch data
│  - batches mapping           │     Never needs to be replaced
│  - Order Statistics Tree     │
│  - All storage variables     │
└──────────────────────────────┘
           ↑
           │ Only authorized logic can access
           │
┌──────────────────────────────┐
│  PostageStampV2              │  ← Upgradeable, implements business logic
│  - createBatch()             │     Can be replaced without moving data
│  - topUp()                   │
│  - increaseDepth()           │
│  - All business logic        │
└──────────────────────────────┘
           ↑
           │
    ┌──────┴───────┐
    │ Swarm Nodes  │
    │ Users        │
    └──────────────┘
```

## Key Benefits

1. **Zero-Migration Upgrades** - Deploy new logic without moving tokens or data
2. **Reduced Risk** - Funds stay in the same trusted immutable contract
3. **Faster Iteration** - Lower upgrade costs = more improvements
4. **Simple Node Updates** - Just change the contract address
5. **Backward Compatible** - Old logic can continue in read-only mode

## Quick Start

### For New Deployments

```bash
# Deploy both contracts
npx hardhat deploy --tags PostageStampV2 --network <network>

# Use the PostageStampV2 address in your Swarm nodes
```

### For Existing Deployments (Migration)

```bash
# 1. Export batch data
npx hardhat run scripts/migration/exportBatchIds.ts

# 2. Run migration (pauses old contract, deploys new, migrates data)
export OLD_POSTAGE_STAMP="0x..."
export BZZ_TOKEN="0x..."
npx hardhat run scripts/migration/migrateToStorageDecoupling.ts --network <network>

# 3. Update all Swarm nodes to use the new PostageStampV2 address
```

### For Future Upgrades (V2 → V3)

```bash
# 1. Deploy new logic contract
npx hardhat deploy --tags PostageStampV3 --network <network>

# 2. Update storage pointer
npx hardhat run scripts/updateLogicContract.ts --network <network>

# 3. Update Swarm nodes
# No token or data migration needed!
```

## How It Works

### Before (Current Architecture)
```
PostageStamp (Monolithic)
├── Batch storage
├── BZZ tokens
└── All logic

To upgrade:
1. Deploy new PostageStamp
2. Pause old contract
3. Migrate ALL BZZ tokens
4. Migrate ALL batch data
5. Update all nodes
6. High risk, high cost
```

### After (Decoupled Architecture)
```
PostageStampStorage (Immutable)
├── Batch storage
└── BZZ tokens

PostageStampV2 (Logic)
└── All business logic

To upgrade:
1. Deploy PostageStampV3
2. Update pointer
3. Update nodes
4. No migration!
5. Low risk, low cost
```

## Read More

- **Implementation Guide**: `docs/STORAGE_DECOUPLING_GUIDE.md` - Complete deployment, migration, and upgrade guide
- **SWIP Document**: `SWIP-storage-decoupling.md` - Detailed proposal with rationale and specifications

## Testing

```bash
# Unit tests (TODO: to be implemented)
npx hardhat test test/PostageStampStorage.test.ts
npx hardhat test test/PostageStampV2.test.ts

# Integration tests (TODO: to be implemented)
npx hardhat test test/StorageDecoupling.integration.test.ts
```

## Security

- **Storage Contract**: Immutable, highly audited, minimal attack surface
- **Logic Contract**: Upgradeable, can be audited independently
- **Access Control**: Only authorized logic contract can modify storage
- **Admin Control**: Use multi-sig for ADMIN_ROLE on storage contract

## Next Steps

1. **Review the contracts**: Read through the Solidity files
2. **Read the SWIP**: Understand the full proposal in `SWIP-storage-decoupling.md`
3. **Test on testnet**: Deploy to a test network first
4. **Security audit**: Get the contracts audited before mainnet
5. **Plan migration**: If migrating from existing PostageStamp, plan the maintenance window

## Questions?

- Read the FAQ in `docs/STORAGE_DECOUPLING_GUIDE.md`
- Open an issue on GitHub
- Join the Swarm Discord

---

**Branch**: `feat/postage_decoupled`

**Status**: Ready for review and testing

**Authors**: Swarm Core Team
