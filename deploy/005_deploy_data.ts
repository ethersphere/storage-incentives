import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';
import { networkConfig, developmentChains } from '../helper-hardhat-config';
import verify from '../utils/verify';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, network } = hre;
  const { deploy, execute, read, log } = deployments;

  const { deployer, oracle, redistributor } = await getNamedAccounts();

  // TODO This is placeholder for saving deployed data, model it per 1558.ts file
  log('----------------------------------------------------');
};

export default func;
func.tags = ['all', 'local', 'deployedData'];
