import { DeployFunction } from 'hardhat-deploy/types';
import { ethers } from 'hardhat';

const func: DeployFunction = async function ({ deployments, getNamedAccounts }) {
  const { get, execute, log, read } = deployments;
  const { deployer } = await getNamedAccounts();

  log('Setting Oracle roles');

  const adminRole = '0x0000000000000000000000000000000000000000000000000000000000000000';

  if (await read('PriceOracle', 'hasRole', adminRole, deployer)) {
    const updaterRole = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('PRICE_UPDATER_ROLE'));
    const redisAddress = (await get('Redistribution')).address;
    await execute('PriceOracle', { from: deployer }, 'grantRole', updaterRole, redisAddress);
  } else {
    log('DEPLOYER NEEDS TO HAVE ADMIN ROLE TO ASSIGN ROLES, PLEASE GRANT ROLE MANUALLY');
  }

  log('----------------------------------------------------');
};

export default func;
func.tags = ['oracle_roles', 'roles'];
