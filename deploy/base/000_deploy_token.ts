import { DeployFunction } from 'hardhat-deploy/types';
import { networkConfig } from '../../helper-hardhat-config';

const func: DeployFunction = async function ({ deployments, getNamedAccounts, network }) {
  const { deploy, log } = deployments;
  const { deployer } = await getNamedAccounts();

  log('----------------------------------------------------');
  log('Deployer address at ', deployer);
  log('----------------------------------------------------');

  // Deploy new TestToken for Base (similar to testnet)
  const args = ['Test BZZ Token', 'tBZZ', '1250000000000000000000000'];

  const token = await deploy('TestToken', {
    from: deployer,
    args: args,
    log: true,
    waitConfirmations: networkConfig[network.name]?.blockConfirmations || 6,
  });

  log('TestToken deployed at:', token.address);
  log('----------------------------------------------------');
};

export default func;
func.tags = ['token', 'contracts'];
