import { DeployFunction } from 'hardhat-deploy/types';
import { networkConfig } from '../../helper-hardhat-config';

const func: DeployFunction = async function ({ deployments, getNamedAccounts, network }) {
  const { deploy, get, read, log } = deployments;
  const { deployer } = await getNamedAccounts();

  const args = [
    (await get('StakeRegistry')).address,
    (await get('PostageStamp')).address,
    (await get('PriceOracle')).address,
  ];

  const redistribution = await deploy('Redistribution', {
    from: deployer,
    args: args,
    log: true,
    waitConfirmations: networkConfig[network.name]?.blockConfirmations || 6,
  });

  const configuredRedistribution = await read('StakeRegistry', 'redistributionContract');
  if (configuredRedistribution.toLowerCase() !== redistribution.address.toLowerCase()) {
    throw new Error(
      `StakeRegistry redistribution mismatch: expected ${redistribution.address}, got ${configuredRedistribution}`
    );
  }

  log('----------------------------------------------------');
};

export default func;
func.tags = ['redistribution', 'contracts'];
