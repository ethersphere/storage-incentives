import { DeployFunction } from 'hardhat-deploy/types';
import { networkConfig } from '../../helper-hardhat-config';

const func: DeployFunction = async function ({ deployments, getNamedAccounts, network }) {
  const { deploy, get, read, execute, log, getOrNull } = deployments;
  const { deployer } = await getNamedAccounts();

  // Check if PriceOracle already exists to preserve its price
  const existingOracle = await getOrNull('PriceOracle');
  let oldOraclePrice;
  if (existingOracle) {
    oldOraclePrice = await read('PriceOracle', 'currentPrice');
  }

  const args = [(await get('PostageStamp')).address];
  await deploy('PriceOracle', {
    from: deployer,
    args: args,
    log: true,
    waitConfirmations: networkConfig[network.name]?.blockConfirmations || 6,
  });

  // Only set the old price if there was an existing deployment
  if (existingOracle && oldOraclePrice) {
    await execute('PriceOracle', { from: deployer }, 'setPrice', oldOraclePrice);
  }

  log('----------------------------------------------------');
};

export default func;
func.tags = ['oracle', 'contracts'];
