import { DeployFunction } from 'hardhat-deploy/types';
import { networkConfig } from '../helper-hardhat-config';

const func: DeployFunction = async function ({ deployments, getNamedAccounts, network }) {
  const { deploy, get, read, execute, log } = deployments;
  const { deployer } = await getNamedAccounts();

  const args = [(await get('PostageStamp')).address];
  await deploy('PriceOracle', {
    from: deployer,
    args: args,
    log: true,
    waitConfirmations: networkConfig[network.name]?.blockConfirmations || 1,
  });

  const priceOracleRole = await read('PostageStamp', 'PRICE_ORACLE_ROLE');
  await execute('PostageStamp', { from: deployer }, 'grantRole', priceOracleRole, (await get('PriceOracle')).address);
  log('----------------------------------------------------');
};

export default func;
func.tags = ['all', 'oracle', 'contracts'];
