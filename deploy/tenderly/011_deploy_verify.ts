import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function ({ deployments }) {
  const { log } = deployments;

  // We verified all the contracts automtically with setup and Hardhat plugin, for any additional changes look here
  // https://docs.tenderly.co/monitoring/smart-contract-verification/verifying-contracts-using-the-tenderly-hardhat-plugin/automatic-contract-verification

  log('----------------------------------------------------');
};

export default func;
func.tags = ['verify'];
