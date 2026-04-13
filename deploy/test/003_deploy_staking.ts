import { DeployFunction } from 'hardhat-deploy/types';
import { ethers } from 'hardhat';
import { networkConfig } from '../../helper-hardhat-config';

const func: DeployFunction = async function ({ deployments, getNamedAccounts, network }) {
  const { deploy, log, get } = deployments;
  const { deployer } = await getNamedAccounts();
  const config = networkConfig[network.name] || {};
  const swarmNetworkID = config.swarmNetworkId;
  const token = await get('TestToken');
  const redistributionAddress = ethers.utils.getContractAddress({
    from: deployer,
    nonce: (await ethers.provider.getTransactionCount(deployer)) + 1,
  });

  const args = [
    token.address,
    redistributionAddress,
    swarmNetworkID,
    config.stakeWaitBase || 2,
    config.stakeWaitOverlayChange || 2,
    config.stakeWaitWithdrawal || 2,
  ];
  await deploy('StakeRegistry', {
    from: deployer,
    args: args,
    log: true,
    waitConfirmations: networkConfig[network.name]?.blockConfirmations || 6,
  });

  log('----------------------------------------------------');
};

export default func;
func.tags = ['staking', 'contracts'];
