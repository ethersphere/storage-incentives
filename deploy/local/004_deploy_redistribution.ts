import { DeployFunction } from 'hardhat-deploy/types';
import { networkConfig } from '../../helper-hardhat-config';

const func: DeployFunction = async function ({ deployments, getNamedAccounts, network }) {
  const { deploy, get, log } = deployments;
  const { deployer } = await getNamedAccounts();

  const roundLength = networkConfig[network.name]?.roundLength || 152;
  const args = [
    (await get('StakeRegistry')).address,
    (await get('PostageStamp')).address,
    (await get('PriceOracle')).address,
    roundLength,
  ];

  await deploy('Redistribution', {
    from: deployer,
    args: args,
    log: true,
    waitConfirmations: networkConfig[network.name]?.blockConfirmations || 1,
  });

  log('----------------------------------------------------');
};

export default func;
func.tags = ['redistribution', 'contracts'];
