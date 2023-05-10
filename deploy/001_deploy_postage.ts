import { DeployFunction } from 'hardhat-deploy/types';
import { networkConfig } from '../helper-hardhat-config';

const func: DeployFunction = async function ({ deployments, getNamedAccounts, network }) {
  const { deploy, log, get } = deployments;
  const { deployer } = await getNamedAccounts();
  const argsStamp = [(await get('TestToken')).address, 16];

  // This code will deploy UUPS proxy with 0x70058cC8A9e538140007853fE7c553eBE1773C06 contract on first run, after that it will reuse proxy and stamp if they are the same as before
  // if PostageStamp contract has any new change in it, it will recompile, redeploy as implementation to original proxy, just need to keep saveDeployments option
  // as default which is true for all networks other then hardhat network

  await deploy('PostageStamp', {
    from: deployer,
    proxy: {
      proxyContract: 'UUPS',
      execute: {
        init: {
          methodName: 'initialize',
          args: argsStamp,
        },
      },
    },
    log: true,
    waitConfirmations: networkConfig[network.name]?.blockConfirmations || 1,
  });

  log('----------------------------------------------------');
};

export default func;
func.tags = ['main', 'postageStamp', 'contracts'];
