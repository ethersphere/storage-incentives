import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function ({ deployments, getNamedAccounts }) {
  const { get, read, execute, log } = deployments;
  const { deployer } = await getNamedAccounts();

  log('Setting Staking roles');
  // As currently we are reusing staking, and there is multisig wallet as ADMIN
  // we either need to add deployer temporarly as ADMIN or do this manually over multisig

  const adminRole = await read('StakeRegistry', 'DEFAULT_ADMIN_ROLE');

  if (await read('StakeRegistry', { from: deployer }, 'hasRole', adminRole)) {
    const redisRole = await read('StakeRegistry', 'REDISTRIBUTOR_ROLE');
    const redisAddress = (await get('Redistribution')).address;
    await execute('StakeRegistry', { from: deployer }, 'grantRole', redisRole, redisAddress);
  } else {
    log('DEPLOYER NEEDS TO HAVE ADMIN ROLE TO ASSIGN THE REDISTRIBUTION ROLE, PLEASE ASSIGN IT OR GRANT ROLE MANUALLY');
  }

  log('----------------------------------------------------');
};

export default func;
func.tags = ['staking_roles', 'roles'];
