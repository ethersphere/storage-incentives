import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function ({ deployments, getNamedAccounts }) {
  const { read, execute, log } = deployments;
  const { deployer, pauser } = await getNamedAccounts();

  log('Setting Staking roles');

  const pauserRole = await read('StakeRegistry', 'PAUSER_ROLE');
  await execute('StakeRegistry', { from: deployer }, 'grantRole', pauserRole, pauser);

  log('----------------------------------------------------');
};

export default func;
func.tags = ['all', 'staking_roles', 'roles'];
