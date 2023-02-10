import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';
const { ethers, upgrades } = require("hardhat");

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre;
  const { deploy, execute, read } = deployments;

  const { deployer, oracle, redistributor } = await getNamedAccounts();


  const Token = await ethers.getContractFactory('TestToken');
  const token = await Token.deploy();
  await token.deployed();

  const PostageStamp = await ethers.getContractFactory('PostageStamp');
  const postageStamp = await upgrades.deployProxy(PostageStamp, [token.address, 16], {
    initializer: "initialize",
    kind: "uups",
  });

  await postageStamp.deployed();

  const priceOracleRole = await postageStamp.PRICE_ORACLE_ROLE();
  await postageStamp.grantRole(priceOracleRole, oracle);

  const redistributorRole = await postageStamp.REDISTRIBUTOR_ROLE();
  await postageStamp.grantRole(redistributorRole, redistributor);
};

export default func;
func.tags = ['Stamp'];
