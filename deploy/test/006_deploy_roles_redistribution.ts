import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function ({ deployments, getNamedAccounts }) {
  const { get, read, execute, log } = deployments;
  const { deployer } = await getNamedAccounts();

  log('Setting Redistribution roles');

  const redisAddress = (await get('Redistribution')).address;
  // This Role executions are also done in other steps, but tests will fail as currently round numbers are coded with this
  // transactions happening, each transaction mines one block, so some tests fail as they are bounded by mining of this trx/blocks
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
