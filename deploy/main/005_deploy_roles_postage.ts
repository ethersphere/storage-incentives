import { DeployFunction } from 'hardhat-deploy/types';
import { ethers } from 'hardhat';

const func: DeployFunction = async function ({ deployments, getNamedAccounts }) {
  const { get, execute, log, read } = deployments;
  const { deployer } = await getNamedAccounts();

  log('Setting PostageStamp roles');

  const adminRole = '0x0000000000000000000000000000000000000000000000000000000000000000';

  if (await read('PostageStamp', 'hasRole', adminRole, deployer)) {
    const priceOracleRole = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('PRICE_ORACLE_ROLE'));
    await execute('PostageStamp', { from: deployer }, 'grantRole', priceOracleRole, (await get('PriceOracle')).address);

    const redisRole = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('REDISTRIBUTOR_ROLE'));
    const redisAddress = (await get('Redistribution')).address;
    await execute('PostageStamp', { from: deployer }, 'grantRole', redisRole, redisAddress);
  } else {
    log('DEPLOYER NEEDS TO HAVE ADMIN ROLE TO ASSIGN ROLES, PLEASE GRANT ROLE MANUALLY');
  }

  log('----------------------------------------------------');
};

export default func;
func.tags = ['postageStamp_roles', 'roles'];
