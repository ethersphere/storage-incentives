import { DeployFunction } from 'hardhat-deploy/types';

// Used for setting states in contracts according to the currently working environment
const func: DeployFunction = async function ({ deployments, getNamedAccounts }) {
  const { execute, log } = deployments;
  const { deployer } = await getNamedAccounts();

  log('Setting Redistribution state "sampleMaxValue"');

  const sampleMaxValue = '3500000000000000000000000000000000000000000000000000000000000000000000000';
  await execute('Redistribution', { from: deployer }, 'setSampleMaxValue', sampleMaxValue);

  log('----------------------------------------------------');
};

export default func;
func.tags = ['state_changes'];
