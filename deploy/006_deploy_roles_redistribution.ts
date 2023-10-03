import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function ({ deployments, getNamedAccounts }) {
  const { get, read, execute, log } = deployments;
  const { deployer } = await getNamedAccounts();

  log('Setting Redistribution roles');

  const redisAddress = (await get('Redistribution')).address;

  log('----------------------------------------------------');
};

export default func;
func.tags = ['main', 'redistribution_roles', 'roles'];
