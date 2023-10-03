import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function ({ deployments, getNamedAccounts }) {
  const { get, read, execute, log } = deployments;
  const { deployer } = await getNamedAccounts();

  log('Setting Redistribution roles');

  const redisAddress = (await get('Redistribution')).address;
  // This Role executions are also done in other steps for, but tests will fail if this is not used unless they are changed
  const redistributorRoleStakeRegistry = await read('StakeRegistry', 'REDISTRIBUTOR_ROLE');
  await execute('StakeRegistry', { from: deployer }, 'grantRole', redistributorRoleStakeRegistry, redisAddress);

  const redistributorRolePostageStamp = await read('PostageStamp', 'REDISTRIBUTOR_ROLE');
  await execute('PostageStamp', { from: deployer }, 'grantRole', redistributorRolePostageStamp, redisAddress);

  const priceUpdaterRoleOracle = await read('PriceOracle', 'PRICE_UPDATER_ROLE');
  await execute('PriceOracle', { from: deployer }, 'grantRole', priceUpdaterRoleOracle, redisAddress);

  log('----------------------------------------------------');
};

export default func;
func.tags = ['main', 'redistribution_roles', 'roles'];
