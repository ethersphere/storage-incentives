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

### Contracts Task

The `contracts` task displays contract deployment information for a specific network.

#### Usage

```bash
# Show mainnet contracts
npx hardhat contracts --target main

# Show testnet contracts
npx hardhat contracts --target test

# Show local contracts
npx hardhat contracts --target local

# Show pretestnet contracts
npx hardhat contracts --target pretestnet

# Show tenderly contracts
npx hardhat contracts --target tenderly
```

#### What it displays

- Contract addresses for the specified network
- Explorer URLs for each contract
- Formatted output for easy copying

---

### Deployments Task

The `deployments` task displays all deployed contracts in a copy-paste friendly format.

#### Usage

```bash
npx hardhat deployments
```

#### What it displays

- All deployed contracts for both mainnet and testnet
- Contract addresses with Etherscan explorer links
- Clean, copy-paste friendly format
- Automatically reads from `mainnet_deployed.json` and `testnet_deployed.json`

---

### Compare Task

The `compare` task compares bytecodes between two deployments to verify consistency.

#### Usage

```bash
# Compare mainnet vs testnet
npx hardhat compare --source mainnet --target testnet

# Compare testnet vs local
npx hardhat compare --source testnet --target local

# Compare mainnet vs tenderly
npx hardhat compare --source mainnet --target tenderly
```

#### What it does

- Compares bytecodes between deployments on different networks
- Shows which contracts are identical vs different
- Identifies missing contracts in either deployment
- Useful for verifying consistent deployments across networks
- Color-coded output: ✅ identical, ❌ different, ⚠️ missing

---

### Signatures Task

The `sigs` task generates ABI signatures for errors and functions.

#### Usage

```bash
# Generate signatures for PostageStamp contract
npx hardhat sigs --c PostageStamp

# Use custom Solidity file name
npx hardhat sigs --c PostageStamp --f MyFile
```

#### Parameters

- `--c`: Contract name (required)
- `--f`: Solidity file name (optional, defaults to contract name)

#### What it does

- Loads contract ABI from artifacts
- Generates error signatures with selectors
- Shows function selectors for debugging
- Useful for error handling and contract interaction

---

### Copy Task

The `copy` task uses the `copyBatch` function from the PostageStamp contract.

#### Usage

```bash
npx hardhat copy \
  --owner 0x1234... \
  --initialbalance 1000000000000000000 \
  --depth 20 \
  --bucketdepth 16 \
  --batchid 0xabcd... \
  --immutable false \
  --contract 0x5678...
```

#### Parameters

- `--owner`: The account's address
- `--initialbalance`: Initial balance for the batch
- `--depth`: Batch depth
- `--bucketdepth`: Bucket depth
- `--batchid`: Batch ID
- `--immutable`: Whether batch is immutable (true/false)
- `--contract`: PostageStamp contract address

#### What it does

- Estimates gas for the copyBatch transaction
- Adds 20% buffer to estimated gas
- Executes copyBatch with optimized gas settings

---

## Available Tasks Summary

- `status`: Check contract statuses and roles
- `contracts`: Display contract deployment information
- `deployments`: Show all deployed contracts in copy-paste friendly format
- `compare`: Compare bytecodes between deployments
- `signatures`: Generate ABI signatures for errors and functions
- `copy`: Use copyBatch function from PostageStamp contract 