import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';
const { ethers, upgrades } = require("hardhat");

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre;
  const { deploy, execute, read } = deployments;

  const { deployer, oracle, redistributor } = await getNamedAccounts();

  // Token code

  const token = await deploy('TestToken', {
    from: deployer,
    args: [],
    log: true,
  });

  // Stamp code
  const PostageStamp = await ethers.getContractFactory('PostageStamp');
  const postageStampProxy = await upgrades.deployProxy(PostageStamp, [token.address, 16], {
    initializer: "initialize",
    kind: "uups",
  });

  await postageStampProxy.deployed();

  // const impl = await upgrades.upgradeProxy(postageStampProxy, PostageStamp);
  // console.log('Deploy PostageStamp Impl  done -> ' + impl.address);

  const artifactStamp = await deployments.getExtendedArtifact('PostageStamp');
  let proxyDeployments = {
    address: postageStampProxy.address,
    ...artifactStamp
  }

  await deployments.save('PostageStamp', proxyDeployments);

  // console.log(await upgrades.erc1967.getImplementationAddress(postageStampProxy.address));
  // console.log(postageStampProxy.address);

  const priceOracleRole = await postageStampProxy.PRICE_ORACLE_ROLE();
  await postageStampProxy.grantRole(priceOracleRole, oracle);

  const redistributorRole = await postageStampProxy.REDISTRIBUTOR_ROLE();
  await postageStampProxy.grantRole(redistributorRole, redistributor);

  //console.log(await deployments.all())
};

export default func;
func.tags = ['Stamp'];
