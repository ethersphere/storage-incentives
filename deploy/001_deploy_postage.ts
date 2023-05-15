import { DeployFunction } from 'hardhat-deploy/types';
import { networkConfig } from '../helper-hardhat-config';

const func: DeployFunction = async function ({ deployments, getNamedAccounts, network }) {
  const { deploy, log, get } = deployments;
  const { deployer } = await getNamedAccounts();
  const argsStamp = [(await get('TestToken')).address, 16, networkConfig[network.name]?.multisig];

  await deploy('PostageStamp', {
    from: deployer,
    args: argsStamp,
    log: true,
    waitConfirmations: networkConfig[network.name]?.blockConfirmations || 1,
  });

  log('----------------------------------------------------');
};

export default func;
func.tags = ['main', 'postageStamp', 'contracts'];
