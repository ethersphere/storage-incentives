import { DeployFunction } from 'hardhat-deploy/types';
import { networkConfig } from '../../helper-hardhat-config';

const func: DeployFunction = async function ({ deployments, getNamedAccounts, network }) {
  const { deploy, get, read, execute, log, getOrNull } = deployments;
  const { deployer } = await getNamedAccounts();

  const existingOracle = await getOrNull('PriceOracle');
  let oldOraclePrice;
  if (existingOracle) {
    oldOraclePrice = await read('PriceOracle', 'currentPrice');
  }

  const postageStamp = await get('PostageStamp');

  await deploy('PriceOracle', {
    from: deployer,
    proxy: {
      proxyContract: 'TransparentUpgradeableProxy',
      viaAdminContract: 'DefaultProxyAdmin',
      execute: {
        init: {
          methodName: 'initialize',
          args: [postageStamp.address],
        },
      },
    },
    log: true,
    waitConfirmations: networkConfig[network.name]?.blockConfirmations || 6,
  });

  if (existingOracle && oldOraclePrice) {
    await execute('PriceOracle', { from: deployer }, 'setPrice', oldOraclePrice);
  }

  log('----------------------------------------------------');
};

export default func;
func.tags = ['oracle', 'contracts'];
