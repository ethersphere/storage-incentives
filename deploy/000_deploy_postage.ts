import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';
import { networkConfig, developmentChains } from '../helper-hardhat-config';

const func: DeployFunction = async function ({ deployments, getNamedAccounts, network }) {
  const { deploy, execute, read, log } = deployments;
  const { deployer, oracle, redistributor } = await getNamedAccounts();

  const argsToken = ['TEST', 'TST', '1249989122910552325012092'];

  // Skip this one for mainent and testnet
  const token = await deploy('TestToken', {
    from: deployer,
    args: argsToken,
    log: true,
  });

  const argsStamp = [token.address, 16];

  await deploy('PostageStamp', {
    from: deployer,
    args: argsStamp,
    log: true,
    // we need to wait if on a live network so we can verify properly
    waitConfirmations: networkConfig[network.name].blockConfirmations || 1,
  });

  const priceOracleRole = await read('PostageStamp', 'PRICE_ORACLE_ROLE');
  await execute('PostageStamp', { from: deployer }, 'grantRole', priceOracleRole, oracle);

  const redistributorRole = await read('PostageStamp', 'REDISTRIBUTOR_ROLE');
  await execute('PostageStamp', { from: deployer }, 'grantRole', redistributorRole, redistributor);

  log('----------------------------------------------------');
};

export default func;
func.tags = ['all', 'postageStamp', 'contracts'];
