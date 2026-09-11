import { DeployFunction } from 'hardhat-deploy/types';
import { networkConfig } from '../../helper-hardhat-config';

const func: DeployFunction = async function ({ deployments, getNamedAccounts, network }) {
  const { deploy, get, log } = deployments;
  const { deployer } = await getNamedAccounts();

  // SWIP-050 moves the stamp witness verification into a deployed library: Redistribution does
  // not fit under the EIP-170 24 KiB limit with it inlined.
  const stsWitness = await deploy('StsWitness', {
    from: deployer,
    log: true,
    waitConfirmations: networkConfig[network.name]?.blockConfirmations || 6,
  });

  const args = [
    (await get('StakeRegistry')).address,
    (await get('PostageStamp')).address,
    (await get('PriceOracle')).address,
    (await get('TestToken')).address,
  ];

  await deploy('Redistribution', {
    from: deployer,
    args: args,
    libraries: {
      StsWitness: stsWitness.address,
    },
    log: true,
    waitConfirmations: networkConfig[network.name]?.blockConfirmations || 6,
  });

  log('----------------------------------------------------');
};

export default func;
func.tags = ['redistribution', 'contracts'];
