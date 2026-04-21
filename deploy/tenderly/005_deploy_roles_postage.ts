import { DeployFunction } from 'hardhat-deploy/types';
import { ethers } from 'hardhat';

const func: DeployFunction = async function ({ deployments, getNamedAccounts }) {
  const { get, execute, log } = deployments;
  const { deployer } = await getNamedAccounts();

  log('Setting PostageStamp roles');

  const priceOracleRole = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('PRICE_ORACLE_ROLE'));
  await execute('PostageStamp', { from: deployer }, 'grantRole', priceOracleRole, (await get('PriceOracle')).address);

  const redistributorRole = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('REDISTRIBUTOR_ROLE'));
  await execute(
    'PostageStamp',
    { from: deployer },
    'grantRole',
    redistributorRole,
    (
      await get('Redistribution')
    ).address
  );

  log('----------------------------------------------------');
};

export default func;
func.tags = ['postageStamp_roles', 'roles'];
