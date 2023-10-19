import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function ({ deployments, getNamedAccounts }) {
  const { log, get } = deployments;
  const { deployer } = await getNamedAccounts();
  let token = null;

  // We ONLY use already deployed token
  if (!(token = await get('Token'))) {
    // we have problem as there is not token, error out
  } else {
    log('Using already deployed token at', token.address);
  }
  
  log('----------------------------------------------------');
};

export default func;
func.tags = ['token', 'contracts'];
