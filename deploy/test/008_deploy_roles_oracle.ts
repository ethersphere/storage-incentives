import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function ({ deployments, getNamedAccounts }) {
  const { get, read, execute, log } = deployments;
  const { deployer } = await getNamedAccounts();

  log('Setting Oracles roles');

  const redisAddress = (await get('Redistribution')).address;

  const updaterRole = await read('PriceOracle', 'PRICE_UPDATER_ROLE');
  await execute('PriceOracle', { from: deployer }, 'grantRole', updaterRole, redisAddress);

  // Verify role assignment
  log('Verifying role assignment...');
  
  // Check PRICE_UPDATER_ROLE
  const hasPriceUpdaterRole = await read('PriceOracle', 'hasRole', updaterRole, redisAddress);
  if (hasPriceUpdaterRole) {
    log(`✅ PRICE_UPDATER_ROLE correctly assigned to Redistribution: ${redisAddress}`);
  } else {
    log(`❌ PRICE_UPDATER_ROLE NOT assigned to Redistribution: ${redisAddress}`);
  }

  log('----------------------------------------------------');
};

export default func;
func.tags = ['staking_roles', 'roles'];
