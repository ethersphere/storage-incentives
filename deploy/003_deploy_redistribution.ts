import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';
import { networkConfig, developmentChains } from '../helper-hardhat-config';

const func: DeployFunction = async function ({ deployments, getNamedAccounts, network }) {
  const { deploy, get, read, execute, log } = deployments;
  const { deployer } = await getNamedAccounts();

  const args = [
    (await get('StakeRegistry')).address,
    (await get('PostageStamp')).address,
    (await get('PriceOracle')).address,
  ]
  await deploy('Redistribution', {
    from: deployer,
    args: args,
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
func.tags = ['all', 'redistribution', 'contracts'];
