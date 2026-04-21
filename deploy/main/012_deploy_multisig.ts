import { DeployFunction } from 'hardhat-deploy/types';
import { networkConfig } from '../../helper-hardhat-config';
import { ethers } from 'hardhat';

const func: DeployFunction = async function ({ deployments, getNamedAccounts, network }) {
  const { execute, log } = deployments;
  const { deployer } = await getNamedAccounts();

  if (network.name == 'mainnet') {
    log('Deploy multisig to all contracts');

    const adminRole = '0x0000000000000000000000000000000000000000000000000000000000000000';

    await execute('PriceOracle', { from: deployer }, 'grantRole', adminRole, networkConfig['mainnet'].multisig);
    await execute('StakeRegistry', { from: deployer }, 'grantRole', adminRole, networkConfig['mainnet'].multisig);
    await execute('Redistribution', { from: deployer }, 'grantRole', adminRole, networkConfig['mainnet'].multisig);
    await execute('VersionedRegistryRouter', { from: deployer }, 'grantRole', adminRole, networkConfig['mainnet'].multisig);

    log('----------------------------------------------------');
  }
};

export default func;
func.tags = ['multisig', 'roles'];
