import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function ({ deployments, getNamedAccounts }) {
  // Currently we dont need to set any roles on Redistribution contract, they are all set on Constructor
  // This is used just as placeholder for future possible settings
};

export default func;
func.tags = ['redistribution_roles', 'roles'];
