import { DeployFunction } from 'hardhat-deploy/types';
import { networkConfig } from '../../helper-hardhat-config';

const func: DeployFunction = async function ({ deployments, getNamedAccounts, network }) {
  const { deploy, log, get } = deployments;
  const { deployer } = await getNamedAccounts();

  const token = await get('Token');
  const argsStamp = [token.address, 16, networkConfig[network.name]?.multisig];

  await deploy('PostageStamp', {
    from: deployer,
    args: argsStamp,
    log: true,
    waitConfirmations: networkConfig[network.name]?.blockConfirmations || 6,
  });

  log('----------------------------------------------------');
};

export default func;
func.tags = ['postageStamp', 'contracts'];
