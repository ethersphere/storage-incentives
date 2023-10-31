import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function ({ deployments, getNamedAccounts }) {
  const { get, read, execute, log } = deployments;
  const { deployer } = await getNamedAccounts();

  log('Setting Staking roles');
  // As currently we are reusing staking, and there is multisig wallet as ADMIN
  // we either need to add deployer temporarly as ADMIN or do this manually over multisig
  const redisAddress = (await get('Redistribution')).address;

  // const redisRole = await read('StakeRegistry', 'REDISTRIBUTOR_ROLE');
  // await execute('StakeRegistry', { from: deployer }, 'grantRole', redisRole, redisAddress);
  log('----------------------------------------------------');
};

export default func;
func.tags = ['staking_roles', 'roles'];
