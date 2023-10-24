import { DeployFunction } from 'hardhat-deploy/types';
import { networkConfig } from '../../helper-hardhat-config';

const func: DeployFunction = async function ({ deployments, getNamedAccounts, network }) {
  const { deploy, get, log } = deployments;
  const { deployer } = await getNamedAccounts();

  const args = [
    (await get('StakeRegistry')).address,
    (await get('PostageStamp')).address,
    (await get('PriceOracle')).address,
    networkConfig[network.name]?.multisig,
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
