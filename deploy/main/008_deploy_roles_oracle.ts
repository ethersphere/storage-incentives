import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function ({ deployments, getNamedAccounts }) {
  const { get, read, execute, log } = deployments;
  const { deployer } = await getNamedAccounts();

  log('Setting Oracles roles');

  const adminRole = await read('StakeRegistry', 'DEFAULT_ADMIN_ROLE');

  if (await read('StakeRegistry', { from: deployer }, 'hasRole', adminRole)) {
    const redisAddress = (await get('Redistribution')).address;
    const updaterRole = await read('PriceOracle', 'PRICE_UPDATER_ROLE');
    await execute('PriceOracle', { from: deployer }, 'grantRole', updaterRole, redisAddress);
  } else {
    log('DEPLOYER NEEDS TO HAVE ADMIN ROLE TO ASSIGN THE REDISTRIBUTION ROLE, PLEASE ASSIGN IT OR GRANT ROLE MANUALLY');
  }

  log('----------------------------------------------------');
};

export default func;
func.tags = ['staking_roles', 'roles'];
