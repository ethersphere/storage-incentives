import { DeployFunction } from 'hardhat-deploy/types';
import { networkConfig } from '../helper-hardhat-config';

const func: DeployFunction = async function ({ deployments, getNamedAccounts, network }) {
  const { deploy, execute, read, log } = deployments;
  const { deployer, oracle, redistributor } = await getNamedAccounts();

  // TODO Skip this one for mainent and testnet
  const token = await deploy('TestToken', {
    from: deployer,
    args: [],
    log: true,
  });

  const args = [token.address, 16];

  await deploy('PostageStamp', {
    from: deployer,
    args: args,
    log: true,
    waitConfirmations: networkConfig[network.name]?.blockConfirmations || 1,
  });

  const priceOracleRole = await read('PostageStamp', 'PRICE_ORACLE_ROLE');
  await execute('PostageStamp', { from: deployer }, 'grantRole', priceOracleRole, oracle);

  const redistributorRole = await read('PostageStamp', 'REDISTRIBUTOR_ROLE');
  await execute('PostageStamp', { from: deployer }, 'grantRole', redistributorRole, redistributor);

  log('----------------------------------------------------');
};

export default func;
func.tags = ['all', 'postageStamp', 'contracts'];
