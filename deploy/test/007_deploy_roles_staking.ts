import { DeployFunction } from 'hardhat-deploy/types';
import { ethers } from 'hardhat';

const func: DeployFunction = async function ({ deployments, getNamedAccounts }) {
  const { get, execute, log } = deployments;
  const { deployer } = await getNamedAccounts();

  log('Setting Staking roles');

  const redisRole = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('REDISTRIBUTOR_ROLE'));
  const redisAddress = (await get('Redistribution')).address;
  await execute('StakeRegistry', { from: deployer }, 'grantRole', redisRole, redisAddress);

  log('----------------------------------------------------');
};

export default func;
func.tags = ['staking_roles', 'roles'];
