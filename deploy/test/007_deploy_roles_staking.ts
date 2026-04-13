import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function ({ deployments, getNamedAccounts }) {
  const { get, read, execute, log } = deployments;
  const { deployer } = await getNamedAccounts();

  log('Setting Staking roles');

  const redisAddress = (await get('Redistribution')).address;

  const redisRole = await read('StakeRegistry', 'REDISTRIBUTOR_ROLE');
  await execute('StakeRegistry', { from: deployer }, 'grantRole', redisRole, redisAddress);

  // Verify role assignment
  log('Verifying role assignment...');

  // Check REDISTRIBUTOR_ROLE
  const hasRedistributorRole = await read('StakeRegistry', 'hasRole', redisRole, redisAddress);
  if (hasRedistributorRole) {
    log(`✅ REDISTRIBUTOR_ROLE correctly assigned to Redistribution: ${redisAddress}`);
  } else {
    log(`❌ REDISTRIBUTOR_ROLE NOT assigned to Redistribution: ${redisAddress}`);
  }

  log('----------------------------------------------------');
};

export default func;
func.tags = ['staking_roles', 'roles'];
