import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function ({ deployments, getNamedAccounts }) {
  const { get, read, execute, log } = deployments;
  const { deployer } = await getNamedAccounts();

  log('Setting Staking roles');

  const redisAddress = (await get('Redistribution')).address;

  const redisRole = await read('StakeRegistry', 'REDISTRIBUTOR_ROLE');
  await execute('StakeRegistry', { from: deployer }, 'grantRole', redisRole, redisAddress);
  log('----------------------------------------------------');
};

export default func;
func.tags = ['staking_roles', 'roles'];
