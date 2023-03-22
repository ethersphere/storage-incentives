import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';
import { networkConfig, developmentChains } from '../helper-hardhat-config';
import verify from '../utils/verify';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, network } = hre;
  const { deploy, execute, read, log } = deployments;

  const { deployer, oracle, redistributor } = await getNamedAccounts();

  // Skip this one for mainent and testnet
  const token = await deploy('TestToken', {
    from: deployer,
    args: [],
    log: true,
  });

  const args = [token.address, 16];

  const postageStamp = await deploy('PostageStamp', {
    from: deployer,
    args: args,
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
