import { DeployFunction } from 'hardhat-deploy/types';
import { networkConfig } from '../../helper-hardhat-config';

const func: DeployFunction = async function ({ deployments, getNamedAccounts, network }) {
  const { deploy, get, log } = deployments;
  const { deployer } = await getNamedAccounts();
  const config = networkConfig[network.name] || {};
  const swarmNetworkID = config.swarmNetworkId;

  const token = await get('TestToken');

  const args = [
    token.address,
    swarmNetworkID,
    config.stakeWaitBase || 2,
    config.stakeWaitOverlayChange || 2,
    config.stakeWaitWithdrawal || 2,
  ];
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
