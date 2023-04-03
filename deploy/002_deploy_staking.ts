import { DeployFunction } from 'hardhat-deploy/types';
import { networkConfig, developmentChains, deployedBzzData } from '../helper-hardhat-config';

const func: DeployFunction = async function ({ deployments, getNamedAccounts, network, ethers }) {
  const { deploy, get, read, execute, log } = deployments;
  const { deployer, pauser } = await getNamedAccounts();

  // Overlays in tests are hardcoded with 0 ID so we need to use it for testing
  let networkID = 0;
  if (!developmentChains.includes(network.name) && network.config.chainId) {
    networkID = network.config.chainId;
  }

  let token = null;
  if (developmentChains.includes(network.name)) {
    token = await get('TestToken');
  }

  if (network.name == 'testnet') {
    token = await ethers.getContractAt(deployedBzzData[network.name].abi, deployedBzzData[network.name].address);
  }

  if (network.name == 'mainnet') {
    token = await ethers.getContractAt(deployedBzzData[network.name].abi, deployedBzzData[network.name].address);
  }

  if (token == null) {
    throw new Error(`Unsupported network: ${network.name}`);
  }

  const args = [token.address, networkID];
  await deploy('StakeRegistry', {
    from: deployer,
    args: args,
    log: true,
    waitConfirmations: networkConfig[network.name]?.blockConfirmations || 1,
  });

  const pauserRole = await read('StakeRegistry', 'PAUSER_ROLE');
  await execute('StakeRegistry', { from: deployer }, 'grantRole', pauserRole, pauser);
  log('----------------------------------------------------');
};

export default func;
func.tags = ['all', 'staking', 'contracts'];
