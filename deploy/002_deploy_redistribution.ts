import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre;
  const { deploy, get} = deployments;
  const { deployer } = await getNamedAccounts();

  await deploy('Redistribution', {
    from: deployer,
    args: [(await get('Staking')).address, (await get('PostageStamp')).address],
    log: true,
  });
};

export default func;
