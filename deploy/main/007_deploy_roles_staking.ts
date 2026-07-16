import { DeployFunction } from 'hardhat-deploy/types';
import { ethers } from 'hardhat';

const func: DeployFunction = async function ({ deployments, getNamedAccounts }) {
  const { get, execute, log, read } = deployments;
  const { deployer } = await getNamedAccounts();

  log('Setting Staking roles');

  const adminRole = '0x0000000000000000000000000000000000000000000000000000000000000000';

  if (await read('StakeRegistry', 'hasRole', adminRole, deployer)) {
    const redisRole = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('REDISTRIBUTOR_ROLE'));
    const redisAddress = (await get('Redistribution')).address;
    await execute('StakeRegistry', { from: deployer }, 'grantRole', redisRole, redisAddress);
  } else {
    log('DEPLOYER NEEDS TO HAVE ADMIN ROLE TO ASSIGN ROLES, PLEASE GRANT ROLE MANUALLY');
  }

  log('----------------------------------------------------');
};

export default func;
func.tags = ['staking_roles', 'roles'];
