import { DeployFunction } from 'hardhat-deploy/types';
import { networkConfig } from '../../helper-hardhat-config';

const func: DeployFunction = async function ({ deployments, getNamedAccounts, network }) {
  const { deploy, get, read, execute, log } = deployments;
  const { deployer } = await getNamedAccounts();

  const oldOraclePrice = await read('PriceOracle', 'currentPrice');

  const args = [(await get('PostageStamp')).address];
  await deploy('PriceOracle', {
    from: deployer,
    args: args,
    log: true,
    waitConfirmations: networkConfig[network.name]?.blockConfirmations || 6,
  });

  await execute('PriceOracle', { from: deployer }, 'setPrice', oldOraclePrice);

  log('----------------------------------------------------');
};

export default func;
func.tags = ['oracle', 'contracts'];
