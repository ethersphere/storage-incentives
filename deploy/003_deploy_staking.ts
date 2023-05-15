import { DeployFunction } from 'hardhat-deploy/types';
import { networkConfig, developmentChains, deployedBzzData } from '../helper-hardhat-config';

const func: DeployFunction = async function ({ deployments, getNamedAccounts, network, ethers }) {
  const { deploy, get, log } = deployments;
  const { deployer } = await getNamedAccounts();

  // Overlays in tests are hardcoded with 0 ID so we need to use it for testing
  let swarmNetworkID = networkConfig[network.name]?.swarmNetworkId;

  let token = null;
  if (developmentChains.includes(network.name)) {
    token = await get('TestToken');
  }

  if (network.name == 'mainnet' || network.name == 'testnet') {
    token = await ethers.getContractAt(deployedBzzData[network.name].abi, deployedBzzData[network.name].address);
  }

  if (token == null) {
    throw new Error(`Unsupported network: ${network.name}`);
  }

  const args = [token.address, swarmNetworkID, networkConfig[network.name]?.multisig];
  await deploy('StakeRegistry', {
    from: deployer,
    args: args,
    log: true,
    waitConfirmations: networkConfig[network.name]?.blockConfirmations || 1,
  });

  log('----------------------------------------------------');
};

export default func;
func.tags = ['main', 'staking', 'contracts'];
