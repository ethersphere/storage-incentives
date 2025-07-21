import { task } from 'hardhat/config';
import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';

interface ContractInfo {
  address: string;
  abi: any[];
  bytecode: string;
  block: number;
  url: string;
}

interface DeploymentInfo {
  chainId: number;
  swarmNetworkId: number;
  contracts: {
    [key: string]: ContractInfo;
  };
}

interface StatusResult {
  contract: string;
  address: string;
  paused: boolean;
  adminRoles: {
    [address: string]: boolean;
  };
  expectedRoles: {
    [role: string]: {
      expected: string;
      actual: string;
      status: '✅' | '❌' | '⚠️';
    };
  };
  roleMembers: {
    [role: string]: string[];
  };
  hasRoleEnumeration: boolean;
  roleVerifications?: {
    [role: string]: {
      expectedAddress: string;
      hasRole: boolean;
      status: '✅' | '❌';
    };
  };
}

const ADMIN_ADDRESSES = {
  testnet: '0xb1C7F17Ed88189Abf269Bf68A3B2Ed83C5276aAe',
  mainnet: '0x647942035bb69C8e4d7EB17C8313EBC50b0bABFA',
  multisig: '0xD5C070FEb5EA883063c183eDFF10BA6836cf9816'
};

const EXPECTED_ROLES = {
  PostageStamp: {
    '0x1337d7d57528a8879766fdf2d0456253114c66c4fc263c97168bfdb007c64c66': 'PRICE_ORACLE_ROLE',
    '0x3e35b14a9f4fef84b59f9bdcd3044fc28783144b7e42bfb2cd075e6a02cb0828': 'REDISTRIBUTOR_ROLE'
  },
  Staking: {
    '0x3e35b14a9f4fef84b59f9bdcd3044fc28783144b7e42bfb2cd075e6a02cb0828': 'REDISTRIBUTOR_ROLE'
  }
};

async function getDeploymentInfo(network: string): Promise<DeploymentInfo> {
  const filePath = path.join(process.cwd(), `${network}_deployed.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Deployment file not found: ${filePath}`);
  }
  
  const content = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(content);
}

async function checkContractStatus(
  contractName: string,
  contractAddress: string,
  abi: any[],
  provider: ethers.providers.Provider,
  deploymentInfo: DeploymentInfo
): Promise<StatusResult> {
  const contract = new ethers.Contract(contractAddress, abi, provider);
  
  // Check if contract is paused
  let paused = false;
  try {
    if (abi.some(item => item.name === 'paused')) {
      paused = await contract.paused();
    }
  } catch (error) {
    // Contract doesn't have pause functionality
  }

  // Check admin roles for specified addresses
  const adminRoles: { [address: string]: boolean } = {};
  const adminAddresses = Object.values(ADMIN_ADDRESSES);
  
  for (const address of adminAddresses) {
    try {
      if (abi.some(item => item.name === 'hasRole')) {
        // Get the DEFAULT_ADMIN_ROLE value from the contract
        let defaultAdminRole;
        try {
          defaultAdminRole = await contract.DEFAULT_ADMIN_ROLE();
        } catch (error) {
          // Fallback to the standard OpenZeppelin value
          defaultAdminRole = '0x0000000000000000000000000000000000000000000000000000000000000000';
        }
        adminRoles[address] = await contract.hasRole(defaultAdminRole, address);
      } else {
        adminRoles[address] = false;
      }
    } catch (error) {
      adminRoles[address] = false;
    }
  }

  // Check if contract has role enumeration functions
  const hasRoleEnumeration = abi.some(item => item.name === 'getRoleMemberCount');

  // Check expected roles
  const expectedRoles: { [role: string]: { expected: string; actual: string; status: '✅' | '❌' | '⚠️' } } = {};
  const roleMembers: { [role: string]: string[] } = {};
  
  const contractExpectedRoles = EXPECTED_ROLES[contractName as keyof typeof EXPECTED_ROLES];
  if (contractExpectedRoles) {
    for (const [roleHash, roleName] of Object.entries(contractExpectedRoles)) {
      try {
        if (abi.some(item => item.name === 'getRoleAdmin')) {
          const actualRoleAdmin = await contract.getRoleAdmin(roleHash);
          const expectedRoleAdmin = contractAddress; // Role admin should be the contract itself
          
          expectedRoles[roleName] = {
            expected: expectedRoleAdmin,
            actual: actualRoleAdmin,
            status: actualRoleAdmin.toLowerCase() === expectedRoleAdmin.toLowerCase() ? '✅' : '❌'
          };
          
          // Try to get role members if the function exists
          try {
            if (hasRoleEnumeration) {
              const memberCount = await contract.getRoleMemberCount(roleHash);
              const members: string[] = [];
              
              for (let i = 0; i < memberCount.toNumber(); i++) {
                try {
                  const member = await contract.getRoleMember(roleHash, i);
                  members.push(member);
                } catch (error) {
                  // Skip if we can't get this member
                }
              }
              
              roleMembers[roleName] = members;
            } else {
              roleMembers[roleName] = [];
            }
          } catch (error) {
            // Function doesn't exist or failed
            roleMembers[roleName] = [];
          }
        } else {
          expectedRoles[roleName] = {
            expected: contractAddress,
            actual: 'N/A',
            status: '⚠️'
          };
          roleMembers[roleName] = [];
        }
      } catch (error) {
        expectedRoles[roleName] = {
          expected: contractAddress,
          actual: 'Error',
          status: '⚠️'
        };
        roleMembers[roleName] = [];
      }
    }
  }

  // Special verification for PostageStamp role assignments
  let roleVerifications: { [role: string]: { expectedAddress: string; hasRole: boolean; status: '✅' | '❌' } } | undefined;
  if (contractName === 'postageStamp') {
    roleVerifications = {};
    
    try {
      // Check PRICE_ORACLE_ROLE assignment
      const priceOracleRole = '0x1337d7d57528a8879766fdf2d0456253114c66c4fc263c97168bfdb007c64c66';
      const priceOracleAddress = deploymentInfo.contracts.priceOracle?.address;
      
      if (priceOracleAddress) {
        const hasPriceOracleRole = await contract.hasRole(priceOracleRole, priceOracleAddress);
        roleVerifications['PRICE_ORACLE_ROLE'] = {
          expectedAddress: priceOracleAddress,
          hasRole: hasPriceOracleRole,
          status: hasPriceOracleRole ? '✅' : '❌'
        };
      }

      // Check REDISTRIBUTOR_ROLE assignment
      const redistributorRole = '0x3e35b14a9f4fef84b59f9bdcd3044fc28783144b7e42bfb2cd075e6a02cb0828';
      const redistributionAddress = deploymentInfo.contracts.redistribution?.address;
      
      if (redistributionAddress) {
        const hasRedistributorRole = await contract.hasRole(redistributorRole, redistributionAddress);
        roleVerifications['REDISTRIBUTOR_ROLE'] = {
          expectedAddress: redistributionAddress,
          hasRole: hasRedistributorRole,
          status: hasRedistributorRole ? '✅' : '❌'
        };
      }

      // Check PAUSER_ROLE assignment for admin addresses
      const pauserRole = '0x65d7a28e3265b37a6474929f336521b332c1681b933f6cb9f3376673440d862a'; // keccak256("PAUSER_ROLE")
      const adminAddresses = Object.values(ADMIN_ADDRESSES);
      let hasPauserRole = false;
      let pauserAddress = '';

      for (const address of adminAddresses) {
        try {
          const hasRole = await contract.hasRole(pauserRole, address);
          if (hasRole) {
            hasPauserRole = true;
            pauserAddress = address;
            break;
          }
        } catch (error) {
          // Continue checking other addresses
        }
      }

      roleVerifications['PAUSER_ROLE'] = {
        expectedAddress: hasPauserRole ? pauserAddress : 'None of admin addresses',
        hasRole: hasPauserRole,
        status: hasPauserRole ? '✅' : '❌'
      };
    } catch (error) {
      console.log(`⚠️  Error checking PostageStamp role assignments: ${error}`);
    }
  }

  // Special verification for StakeRegistry role assignments
  if (contractName === 'staking') {
    roleVerifications = {};
    
    try {
      // Check REDISTRIBUTOR_ROLE assignment
      const redistributorRole = '0x3e35b14a9f4fef84b59f9bdcd3044fc28783144b7e42bfb2cd075e6a02cb0828';
      const redistributionAddress = deploymentInfo.contracts.redistribution?.address;
      
      if (redistributionAddress) {
        const hasRedistributorRole = await contract.hasRole(redistributorRole, redistributionAddress);
        roleVerifications['REDISTRIBUTOR_ROLE'] = {
          expectedAddress: redistributionAddress,
          hasRole: hasRedistributorRole,
          status: hasRedistributorRole ? '✅' : '❌'
        };
      }
    } catch (error) {
      console.log(`⚠️  Error checking StakeRegistry role assignments: ${error}`);
    }
  }

  // Special verification for PriceOracle role assignments
  if (contractName === 'priceOracle') {
    roleVerifications = {};
    
    try {
      // Check PRICE_UPDATER_ROLE assignment
      // PRICE_UPDATER_ROLE = keccak256("PRICE_UPDATER_ROLE")
      const priceUpdaterRole = '0xd96ba01d6560c2ab35f2940dd8d70c5f5fe06236c72674237120515918198fb0';
      const redistributionAddress = deploymentInfo.contracts.redistribution?.address;
      
      if (redistributionAddress) {
        const hasPriceUpdaterRole = await contract.hasRole(priceUpdaterRole, redistributionAddress);
        roleVerifications['PRICE_UPDATER_ROLE'] = {
          expectedAddress: redistributionAddress,
          hasRole: hasPriceUpdaterRole,
          status: hasPriceUpdaterRole ? '✅' : '❌'
        };
      }
    } catch (error) {
      console.log(`⚠️  Error checking PriceOracle role assignments: ${error}`);
    }
  }

  return {
    contract: contractName,
    address: contractAddress,
    paused,
    adminRoles,
    expectedRoles,
    roleMembers,
    hasRoleEnumeration,
    roleVerifications
  };
}

function displayStatus(result: StatusResult, network: string) {
  const statusIcon = result.paused ? '🔴' : '🟢';
  const statusText = result.paused ? 'PAUSED' : 'ACTIVE';
  
  console.log(`\n${statusIcon} ${result.contract} (${result.address})`);
  console.log(`   Status: ${statusText}`);
  
  // Display admin roles
  console.log(`   Admin Roles:`);
  for (const [address, hasRole] of Object.entries(result.adminRoles)) {
    const icon = hasRole ? '✅' : '❌';
    const label = address === ADMIN_ADDRESSES.testnet ? 'Test Deployer' :
                  address === ADMIN_ADDRESSES.mainnet ? 'Main Deployer' :
                  address === ADMIN_ADDRESSES.multisig ? 'Multisig' : 'Unknown';
    console.log(`     ${icon} ${label}: ${address}`);
  }
  
  // Display role verifications for PostageStamp
  if (result.roleVerifications) {
    console.log(`   Role Verifications:`);
    for (const [roleName, verification] of Object.entries(result.roleVerifications)) {
      console.log(`     ${verification.status} ${roleName}:`);
      console.log(`       Expected: ${verification.expectedAddress}`);
      console.log(`       Has Role: ${verification.hasRole ? 'Yes' : 'No'}`);
    }
  }
  
  // Display expected roles
  if (Object.keys(result.expectedRoles).length > 0) {
    console.log(`   Role Assignments:`);
    for (const [roleName, roleInfo] of Object.entries(result.expectedRoles)) {
      console.log(`     ${roleInfo.status} ${roleName}:`);
      console.log(`       Expected: ${roleInfo.expected}`);
      console.log(`       Actual: ${roleInfo.actual}`);
      
      if (result.roleMembers[roleName] && result.roleMembers[roleName].length > 0) {
        console.log(`       Members: ${result.roleMembers[roleName].join(', ')}`);
      }
    }
  }
}

task('status', 'Check status of deployed contracts and their roles')
  .addParam('target', 'Network to check (testnet or mainnet)', 'testnet')
  .setAction(async (taskArgs, hre) => {
    const { target } = taskArgs;
    
    if (!['testnet', 'mainnet'].includes(target)) {
      throw new Error('Target must be either "testnet" or "mainnet"');
    }

    console.log(`\n🚀 Checking ${target} contract statuses...\n`);

    try {
      // Get deployment info
      const deploymentInfo = await getDeploymentInfo(target);
      
      // Setup provider based on network
      let provider;
      if (target === 'testnet') {
        provider = new ethers.providers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL || 'https://sepolia.infura.io/v3/your-project-id');
      } else {
        provider = new ethers.providers.JsonRpcProvider(process.env.GNOSIS_RPC_URL || 'https://rpc.gnosischain.com');
      }

      const results: StatusResult[] = [];
      
      // Check each contract
      for (const [contractName, contractInfo] of Object.entries(deploymentInfo.contracts)) {
        console.log(`🔍 Checking ${contractName}...`);
        
        try {
          const result = await checkContractStatus(contractName, contractInfo.address, contractInfo.abi, provider, deploymentInfo);
          results.push(result);
        } catch (error) {
          console.log(`❌ Error checking ${contractName}: ${error}`);
        }
      }

      // Display results
      console.log(`\n📊 ${target.toUpperCase()} CONTRACT STATUS SUMMARY`);
      console.log('='.repeat(50));
      
      for (const result of results) {
        displayStatus(result, target);
      }

      // Summary
      const activeContracts = results.filter(r => !r.paused).length;
      const totalContracts = results.length;
      const adminRolesCount = results.reduce((sum, r) => 
        sum + Object.values(r.adminRoles).filter(hasRole => hasRole).length, 0
      );
      const correctRolesCount = results.reduce((sum, r) => 
        sum + Object.values(r.expectedRoles).filter(role => role.status === '✅').length, 0
      );
      const totalExpectedRoles = results.reduce((sum, r) => 
        sum + Object.keys(r.expectedRoles).length, 0
      );

      // Count role verifications
      const roleVerificationsCount = results.reduce((sum, r) => {
        if (r.roleVerifications) {
          return sum + Object.values(r.roleVerifications).filter(v => v.hasRole).length;
        }
        return sum;
      }, 0);
      const totalRoleVerifications = results.reduce((sum, r) => {
        if (r.roleVerifications) {
          return sum + Object.keys(r.roleVerifications).length;
        }
        return sum;
      }, 0);

      console.log(`\n📈 SUMMARY:`);
      console.log(`   Active Contracts: ${activeContracts}/${totalContracts}`);
      console.log(`   Admin Roles Assigned: ${adminRolesCount}`);
      console.log(`   Correct Role Assignments: ${correctRolesCount}/${totalExpectedRoles}`);
      if (totalRoleVerifications > 0) {
        console.log(`   Role Verifications: ${roleVerificationsCount}/${totalRoleVerifications}`);
      }

    } catch (error) {
      console.error(`❌ Error: ${error}`);
      process.exit(1);
    }
  }); 