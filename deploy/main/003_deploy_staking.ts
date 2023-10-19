import { DeployFunction } from 'hardhat-deploy/types';
import { networkConfig } from '../../helper-hardhat-config';

const func: DeployFunction = async function ({ deployments, getNamedAccounts, network }) {
  const { deploy, log, get } = deployments;
  const { deployer } = await getNamedAccounts();
  const swarmNetworkID = networkConfig[network.name]?.swarmNetworkId;
  const token = await get('Token');
  
  const args = [token.address, swarmNetworkID, networkConfig[network.name]?.multisig];
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
