import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre;
  const { deploy, get, read, execute } = deployments;
  const { deployer } = await getNamedAccounts();

  await deploy('Redistribution', {
    from: deployer,
    args: [(await get('StakeRegistry')).address, (await get('PostageStamp')).address],
    log: true,
  });

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
