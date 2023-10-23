import { DeployFunction } from 'hardhat-deploy/types';
import { networkConfig } from '../../helper-hardhat-config';

const func: DeployFunction = async function ({ deployments, getNamedAccounts, network }) {
  const { deploy, log, get } = deployments;
  const { deployer } = await getNamedAccounts();
  const swarmNetworkID = networkConfig[network.name]?.swarmNetworkId;
  const token = await get('Token');
  let staking = null;

  // We use legacy token that was migrated, until we deploy new one with this framework
  if (!(staking = await get('StakeRegistry'))) {
  } else {
    log('Using already deployed token at', staking.address);
  }

  log('----------------------------------------------------');
};

export default func;
func.tags = ['staking', 'contracts'];
