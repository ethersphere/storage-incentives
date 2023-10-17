import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function ({ deployments, getNamedAccounts }) {
  const { deploy, log } = deployments;
  const { deployer } = await getNamedAccounts();

  let token = null;

  const argsToken = ['TEST', 'TST', '1249989122910552325012092', deployer];

  token = await deploy('TestToken', {
    from: deployer,
    args: argsToken,
    log: true,
  });

  log('----------------------------------------------------');
};

export default func;
func.tags = ['testToken', 'contracts'];
