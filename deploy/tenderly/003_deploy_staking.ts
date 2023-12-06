import { DeployFunction } from 'hardhat-deploy/types';
import { networkConfig } from '../../helper-hardhat-config';

const func: DeployFunction = async function ({ deployments, getNamedAccounts, network, ethers }) {
  const { deploy, log, get, read } = deployments;
  const { deployer } = await getNamedAccounts();
  const swarmNetworkID = networkConfig[network.name]?.swarmNetworkId;
  const token = await get('Token');
  let staking = null;

  if (!(staking = await get('StakeRegistry'))) {
  } else {
    log('Using already deployed Staking at', staking.address);
  }

  log('----------------------------------------------------');
};

export default func;
func.tags = ['staking', 'contracts'];
