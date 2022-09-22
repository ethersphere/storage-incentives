import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre;
  const { deploy, get, read, execute } = deployments;
  const { deployer, pauser } = await getNamedAccounts();

  const networkID = 0; //test network

  await deploy('StakeRegistry', {
    from: deployer,
    args: [(await get('TestToken')).address, networkID],
    log: true,
  });

  const pauserRole = await read('StakeRegistry', 'PAUSER_ROLE');
  await execute('StakeRegistry', { from: deployer }, 'grantRole', pauserRole, pauser);

  const redistributorRole = await read('StakeRegistry', 'REDISTRIBUTOR_ROLE');
  await execute(
    'StakeRegistry',
    { from: deployer },
    'grantRole',
    redistributorRole,
    (await get('Redistribution')).address
  );
};

export default func;
