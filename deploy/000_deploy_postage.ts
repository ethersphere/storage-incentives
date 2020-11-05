import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre;
  const { deploy, read, log } = deployments;

  const { deployer } = await getNamedAccounts();
  
  const token = await deploy('ERC20PresetMinterPauser', {
    from: deployer,
    args: ["Test", "TST"],
    log: true,
  })  

  await deploy('PostageStamp', {
    from: deployer,
    args: [token.address],
    log: true,
  });
};

export default func;
