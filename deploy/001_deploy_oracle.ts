import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre;
  const { deploy, get, read, execute } = deployments;
  const { deployer } = await getNamedAccounts();

  await deploy('PriceOracle', {
    from: deployer,
    args: [(await get('PostageStamp')).address],
    log: true,
  });

  const priceOracleRole = await read('PostageStamp', 'PRICE_ORACLE_ROLE');
  await execute('PostageStamp', { from: deployer }, 'grantRole', priceOracleRole, (await get('PriceOracle')).address);
};

export default func;
