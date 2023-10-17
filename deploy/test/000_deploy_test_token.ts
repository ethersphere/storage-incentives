import { DeployFunction } from 'hardhat-deploy/types';
import { networkConfig } from '../../helper-hardhat-config';
import verify from '../../utils/verify';

const func: DeployFunction = async function ({ deployments, getNamedAccounts, network, ethers }) {
  const { deploy, log, getOrNull, getDeploymentsFromAddress } = deployments;
  const { deployer } = await getNamedAccounts();

  let token = null;

  if (network.name == 'testnet') {
    // We deploy new token if there is no token
    if (!(token = await getOrNull('TestToken'))) {
      const argsToken = ['gBZZ', 'gBZZ', '1250000000000000000000000', networkConfig[network.name]?.multisig];
      token = await deploy('TestToken', {
        from: deployer,
        args: argsToken,
        log: true,
        waitConfirmations: networkConfig[network.name]?.blockConfirmations || 6,
      });
    } else {
      log('Using already deployed token at', token.address);
    }
  }

  log('----------------------------------------------------');
};

export default func;
func.tags = ['testToken', 'contracts'];
