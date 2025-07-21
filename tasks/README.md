# Hardhat Tasks

This directory contains custom Hardhat tasks for the Swarm project.

## Status Task

The `status` task provides a comprehensive overview of deployed contracts and their current state.

### Usage

```bash
# Check testnet contracts
npx hardhat status --target testnet

# Check mainnet contracts  
npx hardhat status --target mainnet
```

### What it checks

The status task performs the following checks for each deployed contract:

1. **Contract Status**: Whether the contract is paused or active
2. **Admin Roles**: Checks if the following addresses have admin roles:
   - Test Deployer: `0xb1C7F17Ed88189Abf269Bf68A3B2Ed83C5276aAe`
   - Main Deployer: `0x647942035bb69C8e4d7EB17C8313EBC50b0bABFA`
   - Multisig: `0xD5C070FEb5EA883063c183eDFF10BA6836cf9816`

3. **Role Assignments**: For contracts that should have specific roles:
   - **PostageStamp**: Checks `PRICE_ORACLE_ROLE` and `REDISTRIBUTOR_ROLE`
   - **Staking**: Checks `REDISTRIBUTOR_ROLE`

### Output Format

The task provides a clear visual output with:

- 🟢 **Green circle**: Active contracts
- 🔴 **Red circle**: Paused contracts  
- ✅ **Checkmark**: Correct role assignments
- ❌ **X mark**: Missing or incorrect role assignments
- ⚠️ **Warning**: Issues with role checking

### Example Output

```
🚀 Checking mainnet contract statuses...

📊 MAINNET CONTRACT STATUS SUMMARY
==================================================

🟢 postageStamp (0x45a1502382541Cd610CC9068e88727426b696293)
   Status: ACTIVE
   Admin Roles:
     ❌ Test Deployer: 0xb1C7F17Ed88189Abf269Bf68A3B2Ed83C5276aAe
     ✅ Main Deployer: 0x647942035bb69C8e4d7EB17C8313EBC50b0bABFA
     ✅ Multisig: 0xD5C070FEb5EA883063c183eDFF10BA6836cf9816
   Role Assignments:
     ✅ PRICE_ORACLE_ROLE:
       Expected: 0x45a1502382541Cd610CC9068e88727426b696293
       Actual: 0x45a1502382541Cd610CC9068e88727426b696293

📈 SUMMARY:
   Active Contracts: 5/5
   Admin Roles Assigned: 2
   Correct Role Assignments: 1/1
```

### Error Handling

The task includes robust error handling for:
- Contracts without pause functionality
- Contracts without role-based access control
- Network connectivity issues
- Missing deployment files

### Available Tasks

- `status`: Check contract statuses and roles
- `contracts`: Other contract-related tasks
- `deployments`: Deployment management tasks
- `compare`: Contract comparison utilities
- `signatures`: Signature verification tasks
- `copybatch`: Batch copying utilities 