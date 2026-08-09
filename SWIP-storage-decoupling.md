# SWIP: Postage Stamp Storage Decoupling

## Author
Swarm Core Team

## Status
Draft

## Created
2025-12-08

## Summary

This proposal introduces a storage decoupling architecture for the PostageStamp smart contract system, separating the storage layer from the business logic layer. This enables upgrading the PostageStamp logic without requiring migration of BZZ tokens or postage stamp batch data.

## Abstract

Currently, the PostageStamp contract is monolithic, containing both storage and logic in a single immutable contract. When upgrades are needed, the entire contract must be redeployed, requiring:
1. Migration of all BZZ tokens to the new contract
2. Migration or recreation of all postage stamp batch data
3. Coordination with all Swarm node operators to update contract addresses
4. Risk of data loss or inconsistency during migration

This proposal introduces a two-contract architecture:
- **PostageStampStorage**: An immutable contract that holds all batch data, the order statistics tree, and BZZ tokens
- **PostageStamp**: An upgradeable logic contract that implements all postage stamp operations

This separation allows the logic contract to be upgraded independently while the storage contract remains unchanged, eliminating the need for token and data migration. Contract versions are tracked via git tags rather than in contract names.

## Motivation

### Current Problems

1. **Expensive Upgrades**: Each upgrade requires migrating potentially millions of BZZ tokens and thousands of batch records
2. **Downtime Risk**: Migration windows create periods where the system may be unavailable
3. **Coordination Overhead**: All node operators must simultaneously update to point to the new contract
4. **Migration Risk**: Token transfers and data migration introduce risk of loss or corruption
5. **Innovation Friction**: The high cost of upgrades discourages iterative improvements

### Benefits of Storage Decoupling

1. **Zero-Migration Upgrades**: Logic can be upgraded without touching stored data or tokens
2. **Reduced Risk**: Funds and batch data remain in the same trusted, immutable contract
3. **Faster Iteration**: Lower upgrade costs enable more frequent improvements
4. **Simpler Node Updates**: Nodes only need to update the logic contract address
5. **Backward Compatibility**: Old logic contracts can continue operating in read-only mode

## Specification

### Architecture Overview

```
┌─────────────────────────────────────┐
│   PostageStampStorage (Immutable)   │
│                                     │
│  - batches mapping                  │
│  - Order Statistics Tree            │
│  - BZZ Token holdings               │
│  - Global state variables           │
│                                     │
│  Access Control:                    │
│  - Only authorized logic contract   │
│    can modify storage               │
│  - Admin can update logic address   │
└─────────────────────────────────────┘
                 ▲
                 │ Storage Access
                 │
┌─────────────────────────────────────┐
│   PostageStamp (Upgradeable)        │
│                                     │
│  - createBatch()                    │
│  - topUp()                          │
│  - increaseDepth()                  │
│  - setPrice()                       │
│  - withdraw()                       │
│  - All business logic               │
│                                     │
│  Version tracked by git tags        │
└─────────────────────────────────────┘
                 ▲
                 │
                 │
         ┌───────┴────────┐
         │  Swarm Nodes   │
         │  Users         │
         └────────────────┘
```

### Contract Specifications

#### 1. IPostageStampStorage Interface

Defines the storage contract interface with operations for:
- **Batch Operations**: `storeBatch()`, `deleteBatch()`, `getBatch()`, `batchExists()`
- **Tree Operations**: `treeInsert()`, `treeRemove()`, `treeFirst()`, `treeCount()`, `treeValueKeyAtIndex()`
- **State Management**: Getters and setters for global state variables (totalOutPayment, validChunkCount, pot, etc.)
- **Token Operations**: `transferToken()`, `transferTokenFrom()`, `tokenBalance()`
- **Access Control**: `updateLogicContract()`, `logicContract()`

#### 2. PostageStampStorage Contract

**Key Properties**:
- Immutable after deployment
- Holds all BZZ tokens
- Stores all batch data and the order statistics tree
- Restricts write access to the authorized logic contract only
- Admin role can update the authorized logic contract address

**State Variables**:
```solidity
address public immutable bzzToken;
address public logicContract;
mapping(bytes32 => Batch) private batches;
HitchensOrderStatisticsTreeLib.Tree private tree;
uint256 private totalOutPayment;
uint256 private validChunkCount;
uint256 private pot;
uint256 private lastExpiryBalance;
uint64 private lastPrice;
uint64 private lastUpdatedBlock;
```

**Access Control**:
- `onlyLogicContract` modifier: Restricts write operations to the authorized logic contract
- `ADMIN_ROLE`: Can update the logic contract address
- `DEFAULT_ADMIN_ROLE`: Top-level admin

#### 3. PostageStamp Contract (Logic)

**Key Properties**:
- Contains all business logic from the original PostageStamp contract
- Stateless (except for configuration parameters)
- References the immutable storage contract
- Can be upgraded by deploying a new version and updating the storage contract's logic address
- Version tracking is handled via git tags, not contract naming

**Core Functions** (unchanged interface):
- `createBatch()`: Create new postage stamp batches
- `topUp()`: Add funds to existing batches
- `increaseDepth()`: Increase batch depth
- `setPrice()`: Update storage pricing (oracle role)
- `expireLimited()`: Process expired batches
- `withdraw()`: Withdraw accumulated pot (redistributor role)
- View functions: `remainingBalance()`, `currentTotalOutPayment()`, etc.

**Constructor**:
```solidity
constructor(
    address _storageContract,
    uint8 _minimumBucketDepth,
    uint64 _minimumValidityBlocks
)
```

### Deployment Process

1. **Initial Deployment**:
   ```
   1. Deploy PostageStampStorage(bzzToken, initialLogicAddress, adminAddress)
   2. Deploy PostageStamp(storageContract, minimumBucketDepth, minimumValidityBlocks)
   3. If initialLogicAddress was temporary, call storage.updateLogicContract(PostageStampAddress)
   4. Grant roles to PostageStamp (PRICE_ORACLE_ROLE, REDISTRIBUTOR_ROLE, etc.)
   5. Tag the deployment in git (e.g., v2.0.0)
   ```

2. **Upgrade Process**:
   ```
   1. Checkout new version from git (e.g., v2.1.0)
   2. Deploy new PostageStamp(storageContract, updatedParameters)
   3. Configure roles on new PostageStamp
   4. Call storage.updateLogicContract(newPostageStampAddress)
   5. Update Swarm node configurations to use new PostageStamp address
   6. (Optional) Pause old PostageStamp to prevent confusion
   ```

### Migration from Existing Contract

For existing deployments, a one-time migration is required:

1. Deploy PostageStampStorage contract
2. Pause the old PostageStamp contract (legacy version)
3. Run migration script to:
   - Transfer all BZZ tokens from old contract to storage contract
   - Copy all batch data to storage contract
   - Rebuild the order statistics tree in storage contract
   - Copy global state variables
4. Deploy new PostageStamp (logic contract) pointing to the storage contract
5. Tag the deployment in git (e.g., v2.0.0)
6. Update node configurations
7. Unpause and begin operations

After this one-time migration, all future upgrades require no data or token migration.

## Rationale

### Design Decisions

#### Why Not Use Proxy Patterns (EIP-1967)?

Proxy patterns like UUPS or Transparent Proxy were considered but rejected because:
- They introduce complexity and potential security vulnerabilities
- Storage layout must remain compatible across upgrades
- Delegate calls are harder to audit and reason about
- This proposal offers better separation of concerns with explicit interfaces

#### Why Not Use Diamond Pattern (EIP-2535)?

The Diamond pattern was considered but adds unnecessary complexity for this use case:
- PostageStamp logic is cohesive and doesn't benefit from multiple facets
- The simpler two-contract pattern is easier to understand and audit
- Diamonds add gas overhead that isn't justified here

#### Why Immutable Storage Contract?

Making the storage contract immutable provides:
- Maximum trust and security for stored funds
- Clear guarantee that storage layout will never change
- Simplified auditing (storage contract audited once, logic contracts audited independently)

### Security Considerations

1. **Logic Contract Authorization**: Only the authorized logic contract can modify storage, preventing unauthorized access

2. **Admin Key Security**: The admin key that can update the logic contract address must be secured with multi-sig or governance

3. **Upgrade Window Risk**: During the window between deploying a new logic contract and updating the storage pointer, the system should be paused or carefully monitored

4. **Backward Compatibility**: Old logic contracts lose write access after upgrade but can continue serving read-only queries

5. **Token Safety**: BZZ tokens remain in the storage contract throughout all upgrades, never at risk during logic upgrades

## Backward Compatibility

### Breaking Changes

- Existing PostageStamp deployments require a one-time migration
- Node operators must update contract addresses in their configuration
- Events are emitted from PostageStampV2 instead of storage, so event listeners may need updates

### Maintaining Compatibility

- The new PostageStamp contract maintains the same external interface as the legacy version (except constructor)
- Function signatures remain unchanged
- Return values and events are identical
- Existing batch IDs remain valid after migration

### Transition Plan

1. **Phase 1 - Testing** (Weeks 1-4):
   - Deploy to testnet
   - Migrate existing testnet data
   - Community testing period

2. **Phase 2 - Mainnet Preparation** (Weeks 5-6):
   - Security audits of new contracts
   - Prepare migration scripts
   - Node operator communication

3. **Phase 3 - Migration** (Week 7):
   - Announce maintenance window
   - Pause old contract
   - Execute migration
   - Deploy and configure new contracts
   - Update official documentation

4. **Phase 4 - Rollout** (Week 8+):
   - Node operators update configurations
   - Monitor system health
   - Gradual resumption of operations

## Implementation

### Reference Implementation

The reference implementation is available in [PR #300](https://github.com/ethersphere/storage-incentives/pull/300) and consists of three files:

1. **`src/interface/IPostageStampStorage.sol`**: Interface defining all storage operations
2. **`src/PostageStampStorage.sol`**: Immutable storage contract implementation
3. **`src/PostageStamp.sol`**: Upgradeable logic contract implementation (versioned via git tags)

### Testing Plan

1. **Unit Tests**:
   - Test all storage contract functions
   - Test all logic contract functions
   - Test access control mechanisms

2. **Integration Tests**:
   - Test complete user workflows (create, topup, increase depth)
   - Test batch expiry and pot withdrawal
   - Test price oracle updates

3. **Upgrade Tests**:
   - Deploy initial version, create batches
   - Deploy updated version (from new git tag), update storage pointer
   - Verify new version can read existing batches
   - Verify old version can no longer modify storage

4. **Migration Tests**:
   - Create batches in old contract
   - Run migration script
   - Verify all data correctly migrated
   - Verify token balances match

## Security Considerations

### Threat Model

1. **Compromised Logic Contract**: If a logic contract is compromised, the admin can update to a new contract. Only the authorized logic contract has write access.

2. **Compromised Admin Key**: If the admin key is compromised, an attacker could point to a malicious logic contract. Mitigation: Use multi-sig for admin role.

3. **Upgrade Timing Attack**: During upgrade, if both old and new logic contracts are authorized, double-spending may be possible. Mitigation: Atomic upgrade or pause old contract first.

4. **Storage Contract Bug**: Since storage is immutable, any bugs are permanent. Mitigation: Extensive audits before deployment, comprehensive test coverage.

### Audit Recommendations

1. Formal verification of access control mechanisms
2. Audit of storage contract state transitions
3. Review of token transfer safety
4. Analysis of upgrade process security
5. Gas optimization review

## References

- [Original PostageStamp Contract](https://github.com/ethersphere/storage-incentives)
- [EIP-1967: Proxy Storage Slots](https://eips.ethereum.org/EIPS/eip-1967)
- [EIP-2535: Diamond Standard](https://eips.ethereum.org/EIPS/eip-2535)
- [OpenZeppelin Upgradeable Contracts](https://docs.openzeppelin.com/contracts/4.x/upgradeable)

## Copyright

Copyright and related rights waived via [CC0](https://creativecommons.org/publicdomain/zero/1.0/).
