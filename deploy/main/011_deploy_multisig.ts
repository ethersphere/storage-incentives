import { DeployFunction } from 'hardhat-deploy/types';
import { networkConfig } from '../../helper-hardhat-config';

// Used for setting states in contracts according to the currently working environment
const func: DeployFunction = async function ({ deployments, getNamedAccounts, network }) {
  const { execute, log, read } = deployments;
  const { deployer } = await getNamedAccounts();

  if (network.name == 'mainnet') {
    log('Deploy multisig to all contracts');

    // ADD Roles to Multisig
    // TODO should uniform roles on contracts, recommend to just use DEFAULT_ADMIN_ROLE also for postagestamp contract
    const adminRole = await read('PostageStamp', 'DEFAULT_ADMIN_ROLE');
    // const pauserRole = await read('PostageStamp', 'PAUSER_ROLE');
    // await execute('PostageStamp', { from: deployer }, 'grantRole', adminRole, networkConfig['mainnet'].multisig);
    // await execute('PostageStamp', { from: deployer }, 'grantRole', pauserRole, networkConfig['mainnet'].multisig);

    await execute('PriceOracle', { from: deployer }, 'grantRole', adminRole, networkConfig['mainnet'].multisig);
    await execute('StakeRegistry', { from: deployer }, 'grantRole', adminRole, networkConfig['mainnet'].multisig);
    await execute('Redistribution', { from: deployer }, 'grantRole', adminRole, networkConfig['mainnet'].multisig);

    // REMOVE Roles from deployer,
    // ATTENTION probably will never use this, rather manaully confirm there is multistig admin role present and then renounce deployer, error would be catastrophic
    // await execute('PostageStamp', { from: deployer }, 'renounceRole', adminRole, deployer);
    // await execute('PostageStamp', { from: deployer }, 'renounceRole', pauserRole, deployer);
    // await execute('StakeRegistry', { from: deployer }, 'renounceRole', adminRole, deployer);
    // await execute('StakeRegistry', { from: deployer }, 'renounceRole', pauserRole, deployer);
    // await execute('PriceOracle', { from: deployer }, 'renounceRole', adminRole, deployer);

    // await execute('Redistribution', { from: deployer }, 'renounceRole', adminRole, deployer);
    // await execute('Redistribution', { from: deployer }, 'renounceRole', pauserRole, deployer);

    log('----------------------------------------------------');
  }
};

export default func;
func.tags = ['multisig', 'roles'];
