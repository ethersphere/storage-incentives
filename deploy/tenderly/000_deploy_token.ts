// BEFORE running the deployment reset the environment with this command/script
//  hh run scripts/tenderly_reset.ts --network tenderly

import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function ({ deployments, getNamedAccounts, ethers, network }) {
  const { log, get } = deployments;
  let token = null;

  // We ONLY use already deployed token for MAINNET FORKS
  if (!(token = await get('Token'))) {
    // we have problem as there is not token, error out
  } else {
    log('Using already deployed Token at', token.address);
  }

  log('----------------------------------------------------');
};

export default func;
func.tags = ['token', 'preparation'];
