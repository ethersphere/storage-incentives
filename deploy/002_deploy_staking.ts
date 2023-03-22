import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';
import { networkConfig, developmentChains } from '../helper-hardhat-config';
import verify from '../utils/verify';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, network } = hre;
  const { deploy, get, read, execute, log } = deployments;
  const { deployer, pauser } = await getNamedAccounts();

  const networkID = 0; //test network

  await deploy('StakeRegistry', {
    from: deployer,
    args: [(await get('TestToken')).address, networkID],
    log: true,
    // we need to wait if on a live network so we can verify properly
    waitConfirmations: networkConfig[network.name].blockConfirmations || 1,
  });

  const pauserRole = await read('StakeRegistry', 'PAUSER_ROLE');
  await execute('StakeRegistry', { from: deployer }, 'grantRole', pauserRole, pauser);
  log('----------------------------------------------------');
};

export default func;
