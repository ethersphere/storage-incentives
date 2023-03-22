import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';
import { networkConfig, developmentChains } from '../helper-hardhat-config';
import verify from '../utils/verify';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, network } = hre;
  const { deploy, execute, read, log, get } = deployments;

  const { deployer, oracle, redistributor } = await getNamedAccounts();

  // Verify postageStamp
  const token = await get('TestToken');
  const postageStamp = await get('PostageStamp');
  const argsStamp = [token.address, 16];

  if (!developmentChains.includes(network.name) && process.env.MAINNET_ETHERSCAN_KEY) {
    log('Verifying...');
    await verify(postageStamp.address, argsStamp);
  }
  log('----------------------------------------------------');

  // Verify oracle
  const priceOracle = await get('PriceOracle');
  const argsOracle = [postageStamp.address];

  if (!developmentChains.includes(network.name) && process.env.MAINNET_ETHERSCAN_KEY) {
    log('Verifying...');
    await verify(priceOracle.address, argsOracle);
  }
  log('----------------------------------------------------');
};

export default func;
func.tags = ['all', 'etherscan', 'verify'];
