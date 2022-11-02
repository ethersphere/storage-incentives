import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre;
  const { deploy, get, read, execute } = deployments;
  const { deployer } = await getNamedAccounts();

  await deploy('Redistribution', {
    from: deployer,
    args: [
      (await get('StakeRegistry')).address,
      (await get('PostageStamp')).address,
      (await get('PriceOracle')).address,
    ],
    log: true,
  });

  const redistributorRoleStakeRegistry = await read('StakeRegistry', 'REDISTRIBUTOR_ROLE');
  await execute(
    'StakeRegistry',
    { from: deployer },
    'grantRole',
    redistributorRoleStakeRegistry,
    (await get('Redistribution')).address
  );

  const redistributorRolePostageStamp = await read('PostageStamp', 'REDISTRIBUTOR_ROLE');
  await execute(
    'PostageStamp',
    { from: deployer },
    'grantRole',
    redistributorRolePostageStamp,
    (await get('Redistribution')).address
  );

  const priceUpdaterRoleOracle = await read('PriceOracle', 'PRICE_UPDATER_ROLE');
  await execute(
    'PriceOracle',
    { from: deployer },
    'grantRole',
    priceUpdaterRoleOracle,
    (await get('Redistribution')).address
  );
};

export default func;
