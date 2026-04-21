import { DeployFunction } from 'hardhat-deploy/types';
import { ethers } from 'hardhat';

const func: DeployFunction = async function ({ deployments, getNamedAccounts }) {
  const { get, execute, log } = deployments;
  const { deployer } = await getNamedAccounts();

  log('Setting Oracle roles');

  const updaterRole = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('PRICE_UPDATER_ROLE'));
  const redisAddress = (await get('Redistribution')).address;
  await execute('PriceOracle', { from: deployer }, 'grantRole', updaterRole, redisAddress);

  log('----------------------------------------------------');
};

export default func;
func.tags = ['oracle_roles', 'roles'];
