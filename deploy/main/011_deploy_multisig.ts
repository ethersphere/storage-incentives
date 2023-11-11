import { DeployFunction } from 'hardhat-deploy/types';
import { networkConfig } from '../../helper-hardhat-config';

// Used for setting states in contracts according to the currently working environment
const func: DeployFunction = async function ({ deployments, getNamedAccounts, network }) {
  const { execute, log, read } = deployments;
  const { deployer } = await getNamedAccounts();

  if (network.name == 'mainnet') {
    log('Deploy multisig to all contracts, remove deployer');

    // ADD Roles to Multisig
    const adminRole = await read('PostageStamp', 'DEFAULT_ADMIN_ROLE');
    await execute('PostageStamp', { from: deployer }, 'grantRole', adminRole, networkConfig['mainnet'].multisig);
    await execute('PriceOracle', { from: deployer }, 'grantRole', adminRole, networkConfig['mainnet'].multisig);
    await execute('StakeRegistry', { from: deployer }, 'grantRole', adminRole, networkConfig['mainnet'].multisig);
    await execute('Redistribution', { from: deployer }, 'grantRole', adminRole, networkConfig['mainnet'].multisig);

    // REMOVE Roles from deployer
    await execute('PostageStamp', { from: deployer }, 'renounceRole', adminRole, deployer);
    await execute('PriceOracle', { from: deployer }, 'renounceRole', adminRole, deployer);
    await execute('StakeRegistry', { from: deployer }, 'renounceRole', adminRole, deployer);
    await execute('Redistribution', { from: deployer }, 'renounceRole', adminRole, deployer);

    log('----------------------------------------------------');
  }
};

export default func;
func.tags = ['multisig', 'roles'];
