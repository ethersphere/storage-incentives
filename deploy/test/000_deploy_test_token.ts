import { DeployFunction } from 'hardhat-deploy/types';
import { networkConfig } from '../../helper-hardhat-config';

const func: DeployFunction = async function ({ deployments, getNamedAccounts, network }) {
  const { deploy, log, getOrNull } = deployments;
  const { deployer } = await getNamedAccounts();

  let token = null;

  // We deploy new token if there is no token
  if (!(token = await getOrNull('TestToken'))) {
    const argsToken = ['gBZZ', 'gBZZ', '1250000000000000000000000'];
    token = await deploy('TestToken', {
      from: deployer,
      args: argsToken,
      log: true,
      waitConfirmations: networkConfig[network.name]?.blockConfirmations || 6,
    });
  } else {
    log('Using already deployed token at', token.address);
  }

  log('----------------------------------------------------');
};

export default func;
func.tags = ['testToken', 'contracts'];
