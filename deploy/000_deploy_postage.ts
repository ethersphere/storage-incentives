import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';
const { ethers, upgrades } = require("hardhat");

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre;
  const { deploy, execute, read } = deployments;

  const { deployer, oracle, redistributor } = await getNamedAccounts();

  const token = await deploy('TestToken', {
    from: deployer,
    args: [],
    log: true,
  });


  const postageStamp = await hre.ethers.getContractFactory('PostageStamp');
  const postageStampContract = await upgrades.deployProxy(postageStamp, [token.address, 16]);


  const priceOracleRole = await read('PostageStamp', 'PRICE_ORACLE_ROLE');
  await execute('PostageStamp', { from: deployer }, 'grantRole', priceOracleRole, oracle);

  const redistributorRole = await read('PostageStamp', 'REDISTRIBUTOR_ROLE');
  await execute('PostageStamp', { from: deployer }, 'grantRole', redistributorRole, redistributor);
};

export default func;
func.tags = ['Stamp'];
