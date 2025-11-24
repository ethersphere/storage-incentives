import { DeployFunction } from 'hardhat-deploy/types';
import { networkConfig } from '../../helper-hardhat-config';

const func: DeployFunction = async function ({ deployments, getNamedAccounts, network }) {
  const { deploy, get, log } = deployments;
  const { deployer } = await getNamedAccounts();

  const roundLength = networkConfig[network.name]?.roundLength || 152;
  const args = [(await get('PostageStamp')).address, roundLength];
  await deploy('PriceOracle', {
    from: deployer,
    args: args,
    log: true,
    waitConfirmations: networkConfig[network.name]?.blockConfirmations || 6,
  });

  log('----------------------------------------------------');
};

export default func;
func.tags = ['oracle', 'contracts'];
