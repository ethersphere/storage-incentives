import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre;
  const { execute, log, read } = deployments;
  const { admin } = await getNamedAccounts();

  const currentAdmin = await read('Greeter', 'getAdmin');

  if (currentAdmin !== admin) {
    log(`setting admin from ${currentAdmin} to ${admin}...`);

    await execute('Greeter', { from: currentAdmin, log: true }, 'setAdmin', admin);
    log(`admin sucessfully set to ${admin}`);
  }
};

export default func;
func.runAtTheEnd = true;
