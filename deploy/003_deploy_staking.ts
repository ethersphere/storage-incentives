import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre;
  const { deploy, get, read, execute } = deployments;
  const { deployer, redistributor } = await getNamedAccounts();

  const networkID = 0; //test network

  await deploy('StakeRegistry', {
    from: deployer,
    args: [(await get('TestToken')).address, networkID],
    log: true,
  });

};

export default func;
