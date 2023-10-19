import { DeployFunction } from 'hardhat-deploy/types';
import { networkConfig } from '../../helper-hardhat-config';

const func: DeployFunction = async function ({ deployments, getNamedAccounts, network }) {
  const { deploy, log, get } = deployments;
  const { deployer } = await getNamedAccounts();

  let token = null;

  if (network.name == 'mainnet') {
    // We ONLY use already deployed token
    if (!(token = await get('Token'))) {
      // we have problem, error out
    } else {
      log('Using already deployed token at', token.address);
    }
  }

  log('----------------------------------------------------');
};

export default func;
func.tags = ['token', 'contracts'];
