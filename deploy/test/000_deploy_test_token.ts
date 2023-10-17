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

      if (process.env.TESTNET_ETHERSCAN_KEY) {
        log('Verifying...');
        await verify(token.address, argsToken);
      }
    } else {
      log('Using already deployed token at', token.address);
    }
  }

  // if (network.name == 'testnet') {
  //   // We use gBZZ token deployed long time ago
  //   const token = await ethers.getContractAt('TestToken', '0x2aC3c1d3e24b45c6C310534Bc2Dd84B5ed576335');
  //   log('Using already deployed token at', token.address);
  // }

  log('----------------------------------------------------');
};

export default func;
func.tags = ['testToken', 'contracts'];
