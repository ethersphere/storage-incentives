import { DeployFunction } from 'hardhat-deploy/types';
import { networkConfig } from '../../helper-hardhat-config';

const func: DeployFunction = async function ({ deployments, getNamedAccounts, network }) {
  const { deploy, log, get } = deployments;
  const { deployer } = await getNamedAccounts();
  const config = networkConfig[network.name] || {};
  const swarmNetworkID = config.swarmNetworkId;
  if (swarmNetworkID === undefined) {
    throw new Error(`swarmNetworkId is not configured for network '${network.name}'`);
  }
  const token = await get('Token');

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
    waitConfirmations: networkConfig[network.name]?.blockConfirmations || 6,
  });

  log('----------------------------------------------------');
};

export default func;
func.tags = ['staking', 'contracts'];
