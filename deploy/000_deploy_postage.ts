import { DeployFunction } from 'hardhat-deploy/types';
import { networkConfig, developmentChains, deployedBzzData } from '../helper-hardhat-config';

const func: DeployFunction = async function ({ deployments, getNamedAccounts, network, ethers }) {
  const { deploy, log } = deployments;
  const { deployer } = await getNamedAccounts();

  let token = null;
  if (developmentChains.includes(network.name)) {
    token = await deploy('TestToken', {
      from: deployer,
      args: [],
      log: true,
    });
  }

  if (network.name == 'mainnet' || network.name == 'testnet') {
    token = await ethers.getContractAt(deployedBzzData[network.name].abi, deployedBzzData[network.name].address);
  }

  if (token == null) {
    throw new Error(`Unsupported network: ${network.name}`);
  }

  const argsStamp = [token.address, 16];

  await deploy('PostageStamp', {
    from: deployer,
    args: argsStamp,
    log: true,
    waitConfirmations: networkConfig[network.name]?.blockConfirmations || 1,
  });

  log('----------------------------------------------------');
};

export default func;
func.tags = ['main', 'postageStamp', 'contracts'];
