import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function ({ deployments, getNamedAccounts }) {
  const { get, read, execute, log } = deployments;
  const { deployer } = await getNamedAccounts();

  log('Setting PostageStamps roles');
  const adminRole = await read('PostageStamp', 'DEFAULT_ADMIN_ROLE');

  if (await read('PostageStamp', 'hasRole', adminRole, deployer)) {
    const priceOracleRole = await read('PostageStamp', 'PRICE_ORACLE_ROLE');
    await execute('PostageStamp', { from: deployer }, 'grantRole', priceOracleRole, (await get('PriceOracle')).address);

    const redisRole = await read('PostageStamp', 'REDISTRIBUTOR_ROLE');
    const redisAddress = (await get('Redistribution')).address;
    await execute('PostageStamp', { from: deployer }, 'grantRole', redisRole, redisAddress);
  } else {
    log('DEPLOYER NEEDS TO HAVE ADMIN ROLE TO ASSIGN THE REDISTRIBUTION ROLE, PLEASE ASSIGN IT OR GRANT ROLE MANUALLY');
  }

  log('----------------------------------------------------');
};

export default func;
func.tags = ['postageStamp_roles', 'roles'];
