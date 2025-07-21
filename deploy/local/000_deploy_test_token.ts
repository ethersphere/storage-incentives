import { DeployFunction } from 'hardhat-deploy/types';
import { networkConfig } from '../../helper-hardhat-config';

const func: DeployFunction = async function ({ deployments, getNamedAccounts, network, ethers }) {
  const { deploy, log } = deployments;
  const { deployer } = await getNamedAccounts();

  const multisig = networkConfig[network.name];
  if (typeof multisig === 'string' && ethers.utils.getAddress(multisig) !== ethers.utils.getAddress(deployer)) {
    throw new Error('Multisig is not the same as deployer');
  }

  const argsToken = ['TEST', 'TST', '1249989122910552325012092'];

  await deploy('TestToken', {
    from: deployer,
    args: argsToken,
    log: true,
  });

  log('----------------------------------------------------');
};

export default func;
func.tags = ['testToken', 'contracts'];
