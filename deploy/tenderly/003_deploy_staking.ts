import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function ({ deployments }) {
  const { log, get } = deployments;

  const staking = await get('StakeRegistry');

  log('Using already deployed Staking at', staking.address);

  log('----------------------------------------------------');
};

export default func;
func.tags = ['staking', 'contracts'];
