import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre;
  const { deploy, read, log } = deployments;

  const { deployer } = await getNamedAccounts();

  await deploy('Greeter', {
    from: deployer,
    args: [deployer, 'Hello World!'],
    log: true,
  });

  const currentGreeting = await read('Greeter', 'getGreeting');
  log(`Curent greeting set to: ${currentGreeting}`);
};

export default func;
