import { DeployFunction } from 'hardhat-deploy/types';
import { networkConfig } from '../helper-hardhat-config';

const func: DeployFunction = async function ({ deployments, getNamedAccounts, network }) {
  const { deploy, log, get } = deployments;
  const { deployer } = await getNamedAccounts();
  const argsStamp = [(await get('TestToken')).address, 16];

  // This code will deploy UUPS proxy contract on first run, after that it will reuse proxy
  // If PostageStamp contract has any changes,hardhat will recompile it and redeploy as implementation to original proxy
  // What to watch out when using UUPS is listed here https://docs.openzeppelin.com/upgrades-plugins/1.x/writing-upgradeable#modifying-your-contracts.adoc

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
