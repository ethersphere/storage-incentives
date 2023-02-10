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
  const postageStampContract = await upgrades.deployProxy(postageStamp, [token.address, 16], {
    initializer: "initialize",
    kind: "uups",
  });

  await postageStampContract.deployed();

  const priceOracleRole = await postageStampContract.PRICE_ORACLE_ROLE();
  await postageStampContract.grantRole(priceOracleRole, oracle);

  const redistributorRole = await postageStampContract.REDISTRIBUTOR_ROLE();
  await postageStampContract.grantRole(redistributorRole, redistributor);
};

export default func;
func.tags = ['Stamp'];
