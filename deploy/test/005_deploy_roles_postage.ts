import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function ({ deployments, getNamedAccounts }) {
  const { get, read, execute, log } = deployments;
  const { deployer } = await getNamedAccounts();

  log('Setting PostageStamps roles');

  const priceOracleRole = await read('PostageStamp', 'PRICE_ORACLE_ROLE');
  await execute('PostageStamp', { from: deployer }, 'grantRole', priceOracleRole, (await get('PriceOracle')).address);

  const redistributorRole = await read('PostageStamp', 'REDISTRIBUTOR_ROLE');
  await execute(
    'PostageStamp',
    { from: deployer },
    'grantRole',
    redistributorRole,
    (
      await get('Redistribution')
    ).address
  );

  // Set default price for postageStamp
  const currentPrice = await read('PriceOracle', 'currentPrice');
  await execute('PriceOracle', { from: deployer }, 'setPrice', currentPrice);

  log('----------------------------------------------------');
};

export default func;
func.tags = ['postageStamp_roles', 'roles'];
