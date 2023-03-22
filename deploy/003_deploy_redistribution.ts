import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';
import { networkConfig, developmentChains } from '../helper-hardhat-config';
import verify from '../utils/verify';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, network } = hre;
  const { deploy, get, read, execute, log } = deployments;
  const { deployer } = await getNamedAccounts();

  await deploy('Redistribution', {
    from: deployer,
    args: [
      (await get('StakeRegistry')).address,
      (await get('PostageStamp')).address,
      (await get('PriceOracle')).address,
    ],
    log: true,
    // we need to wait if on a live network so we can verify properly
    waitConfirmations: networkConfig[network.name].blockConfirmations || 1,
  });

  const redistributorRoleStakeRegistry = await read('StakeRegistry', 'REDISTRIBUTOR_ROLE');
  await execute(
    'StakeRegistry',
    { from: deployer },
    'grantRole',
    redistributorRoleStakeRegistry,
    (
      await get('Redistribution')
    ).address
  );

  const redistributorRolePostageStamp = await read('PostageStamp', 'REDISTRIBUTOR_ROLE');
  await execute(
    'PostageStamp',
    { from: deployer },
    'grantRole',
    redistributorRolePostageStamp,
    (
      await get('Redistribution')
    ).address
  );

  const priceUpdaterRoleOracle = await read('PriceOracle', 'PRICE_UPDATER_ROLE');
  await execute(
    'PriceOracle',
    { from: deployer },
    'grantRole',
    priceUpdaterRoleOracle,
    (
      await get('Redistribution')
    ).address
  );
  log('----------------------------------------------------');
};

export default func;
