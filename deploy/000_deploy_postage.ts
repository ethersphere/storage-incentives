import { DeployFunction } from 'hardhat-deploy/types';
import { networkConfig, developmentChains, deployedBzzData } from '../helper-hardhat-config';

const func: DeployFunction = async function ({ deployments, getNamedAccounts, network, ethers }) {
  const { deploy, execute, read, log } = deployments;
  const { deployer, oracle, redistributor } = await getNamedAccounts();

  let token;
  if (developmentChains.includes(network.name)) {
    token = await deploy('TestToken', {
      from: deployer,
      args: [],
      log: true,
    });
  }

  if (network.name == 'testnet') {
    token = await ethers.getContractAt(deployedBzzData[network.name].abi, deployedBzzData[network.name].address);
  }

  if (network.name == 'mainnet') {
    token = await ethers.getContractAt(deployedBzzData[network.name].abi, deployedBzzData[network.name].address);
  }

  const argsStamp = [token.address, 16];

  await deploy('PostageStamp', {
    from: deployer,
    args: argsStamp,
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
