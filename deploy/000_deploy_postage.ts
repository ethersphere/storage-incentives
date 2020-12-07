import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre;
  const { deploy, execute, read } = deployments;

  const { deployer, oracle } = await getNamedAccounts();

  const token = await deploy('ERC20PresetMinterPauser', {
    from: deployer,
    args: ['Test', 'TST'],
    log: true,
  });

  await deploy('PostageStamp', {
    from: deployer,
    args: [token.address],
    log: true,
  });

  const priceOracleRole = await read('PostageStamp', 'PRICE_ORACLE_ROLE');
  await execute('PostageStamp', { from: deployer }, 'grantRole', priceOracleRole, oracle);
};

export default func;
