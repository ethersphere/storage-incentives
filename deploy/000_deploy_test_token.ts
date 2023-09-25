import { DeployFunction } from 'hardhat-deploy/types';
import { developmentChains, networkConfig } from '../helper-hardhat-config';
import verify from '../utils/verify';

const func: DeployFunction = async function ({ deployments, getNamedAccounts, network }) {
  const { deploy, log } = deployments;
  const { deployer } = await getNamedAccounts();

  let token = null;

  if (developmentChains.includes(network.name)) {
    const argsToken = ['TEST', 'TST', '1249989122910552325012092', deployer];

    token = await deploy('TestToken', {
      from: deployer,
      args: argsToken,
      log: true,
    });
  }

  if (network.name == 'testnet') {
    const argsToken = ['gBZZ', 'gBZZ', '1250000000000000000000000', networkConfig[network.name]?.multisig];
    token = await deploy('TestToken', {
      from: deployer,
      args: argsToken,
      log: true,
      waitConfirmations: networkConfig[network.name]?.blockConfirmations || 1,
    });

    if (process.env.TESTNET_ETHERSCAN_KEY) {
      console.log('Verifying...');
      await verify(token.address, argsToken);
    }
  }

  log('----------------------------------------------------');
};

export default func;
func.tags = ['main', 'testToken', 'contracts'];
