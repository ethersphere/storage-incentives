import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';
import { ENV_ORACLE_BEE_VERSION } from '../helper-hardhat-config';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();
  const args = [ENV_ORACLE_BEE_VERSION];

  await deploy('EnvOracle', {
    from: deployer,
    args,
    log: true,
  });
};

export default func;
