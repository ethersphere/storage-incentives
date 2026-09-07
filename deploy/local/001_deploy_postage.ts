import { DeployFunction } from 'hardhat-deploy/types';
import { networkConfig } from '../../helper-hardhat-config';

const func: DeployFunction = async function ({ deployments, getNamedAccounts, network }) {
  const { deploy, log, get } = deployments;
  const { deployer } = await getNamedAccounts();

  log('----------------------------------------------------');
  log('Deployer address at ', deployer);
  log('----------------------------------------------------');

  const token = await get('TestToken');

  await deploy('PostageStamp', {
    from: deployer,
    proxy: {
      proxyContract: 'TransparentUpgradeableProxy',
      viaAdminContract: 'DefaultProxyAdmin',
      execute: {
        init: {
          methodName: 'initialize',
          args: [token.address, 16],
        },
      },
    },
    log: true,
    waitConfirmations: networkConfig[network.name]?.blockConfirmations || 1,
  });

  log('----------------------------------------------------');
};

export default func;
func.tags = ['postageStamp', 'contracts'];
