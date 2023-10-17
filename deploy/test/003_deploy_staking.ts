import { DeployFunction } from 'hardhat-deploy/types';
import { networkConfig, deployedBzzData } from '../../helper-hardhat-config';

const func: DeployFunction = async function ({ deployments, getNamedAccounts, network, ethers }) {
  const { deploy, log } = deployments;
  const { deployer } = await getNamedAccounts();
  const swarmNetworkID = networkConfig[network.name]?.swarmNetworkId;

  const token = await ethers.getContractAt(deployedBzzData['testnet'].abi, deployedBzzData['testnet'].address);

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
func.tags = ['staking', 'contracts'];
