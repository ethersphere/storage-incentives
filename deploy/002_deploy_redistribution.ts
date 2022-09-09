import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre;
  const { deploy, get, read, execute } = deployments;
  const { deployer, redistributor } = await getNamedAccounts();

  await deploy('Redistribution', {
    from: deployer,
    args: [],
    log: true,
  });

};

export default func;
