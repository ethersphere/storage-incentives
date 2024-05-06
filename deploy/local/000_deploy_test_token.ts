import { DeployFunction } from 'hardhat-deploy/types';
import { networkConfig } from '../../helper-hardhat-config';

const func: DeployFunction = async function ({ deployments, getNamedAccounts, network }) {
  const { deploy, log } = deployments;
  const { deployer } = await getNamedAccounts();

  if ((networkConfig[network.name] ?? '').toLowerCase() !== deployer.toLowerCase()) {
    throw new Error('Multisig is not the same as deployer');
  }

  let token = null;

  const argsToken = ['TEST', 'TST', '1249989122910552325012092'];

  token = await deploy('TestToken', {
    from: deployer,
    args: argsToken,
    log: true,
  });

  log('----------------------------------------------------');
};

export default func;
func.tags = ['testToken', 'contracts'];
