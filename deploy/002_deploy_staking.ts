import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';
import { networkConfig, developmentChains } from '../helper-hardhat-config';
import verify from '../utils/verify';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, network } = hre;
  const { deploy, get, read, execute, log } = deployments;
  const { deployer, pauser } = await getNamedAccounts();

  // Overlays in tests are hardcoded with 0 ID so we need to use it for testing
  let networkID: number = 0;
  if (!developmentChains.includes(network.name)) {
    networkID = network.config.chainId!;
  }

  const args = [(await get('TestToken')).address, networkID];
  await deploy('StakeRegistry', {
    from: deployer,
    args: args,
    log: true,
    // we need to wait if on a live network so we can verify properly
    waitConfirmations: networkConfig[network.name].blockConfirmations || 1,
  });

  const pauserRole = await read('StakeRegistry', 'PAUSER_ROLE');
  await execute('StakeRegistry', { from: deployer }, 'grantRole', pauserRole, pauser);
  log('----------------------------------------------------');
};

export default func;
func.tags = ['all', 'staking', 'contracts'];
