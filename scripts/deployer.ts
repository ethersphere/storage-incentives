import 'hardhat-deploy-ethers';
import * as fs from 'fs';
import { ethers, upgrades } from 'hardhat';
import hre from 'hardhat';

interface DeployedContract {
  abi: Array<unknown>;
  bytecode: string;
  address: string;
  block: number;
  url: string;
}

interface DeployedData {
  exists: boolean;
  chainId: number;
  networkId: number;
  contracts: {
    bzzToken: DeployedContract;
    staking: DeployedContract;
    postageStamp: DeployedContract;
    priceOracle: DeployedContract;
    redistribution: DeployedContract;
  };
}

interface ContractData {
  addresses: {
    bzzToken: string;
    staking: string;
    postageStamp: string;
    priceOracle: string;
    redistribution: string;
  };
  blocks: {
    bzzToken: number;
    staking: number;
    postageStamp: number;
    priceOracle: number;
    redistribution: number;
  };
}

interface ChainConfig {
  chainId?: number;
  networkId?: number;
  networkName: string;
  deployedData: DeployedData;
  url: string;
}

let networkDeployedData: DeployedData;
try {
  networkDeployedData = require('../' + hre.network.name + '_deployed.json');
  networkDeployedData.exists = true;
} catch (e) {
  networkDeployedData = {
    exists: false,
    chainId: 0,
    networkId: 0,
    contracts: {
      bzzToken: {} as DeployedContract,
      staking: {} as DeployedContract,
      postageStamp: {} as DeployedContract,
      priceOracle: {} as DeployedContract,
      redistribution: {} as DeployedContract,
    },
  } as DeployedData;
}

const configs: Record<string, ChainConfig> = {
  testnet: {
    chainId: hre.network.config.chainId,
    networkId: networkDeployedData.networkId ? networkDeployedData.networkId : 10,
    networkName: hre.network.name,
    deployedData: networkDeployedData,
    url: hre.config.etherscan.customChains[0]['urls']['browserURL'].toString(),
  },
  mainnet: {
    chainId: hre.network.config.chainId,
    networkId: networkDeployedData.networkId ? networkDeployedData.networkId : 1,
    networkName: hre.network.name,
    deployedData: networkDeployedData,
    url: hre.config.etherscan.customChains[1]['urls']['browserURL'].toString(),
  },
};

const config: ChainConfig = configs[hre.network.name]
  ? configs[hre.network.name]
  : ({
    chainId: hre.network.config.chainId,
    networkId: networkDeployedData.networkId ? networkDeployedData.networkId : hre.network.config.chainId,
    networkName: hre.network.name,
    deployedData: networkDeployedData,
    url: '',
  } as ChainConfig);

async function main() {
  let contractData = {
    addresses: {
      bzzToken: '',
      staking: '',
      postageStamp: '',
      priceOracle: '',
      redistribution: '',
    },
    blocks: {
      bzzToken: 0,
      staking: 0,
      postageStamp: 0,
      priceOracle: 0,
      redistribution: 0,
    },
  };

  contractData = await deployBzzToken(await JSON.parse(JSON.stringify(config.deployedData).toString()), contractData);
  if (!contractData.addresses.bzzToken) {
    throw new Error('BzzToken address not found for deployment over ' + config.networkName);
  }
  contractData = await deployRedistribution(
    await deployPriceOracle(await deployPostageStamp(await deployStaking(contractData)))
  );
  await rolesSetter(contractData);
  await writeResult(config.deployedData, contractData);
}

async function deployBzzToken(deployed: DeployedData, contractData: ContractData) {
  if (!deployed.exists) {
    console.log('Deploying BzzToken contract to network ' + config.networkName + ' with chain id ' + config.chainId);
    const TestToken = await hre.ethers.getContractFactory('TestToken');
    const testTokenContract = await upgrades.deployProxy(TestToken);
    console.log('tx hash:' + testTokenContract.deployTransaction.hash);
    await testTokenContract.deployed();
    contractData.addresses.bzzToken = testTokenContract.address;
    contractData.blocks.bzzToken = testTokenContract.deployTransaction.blockNumber as number;
    console.log(
      'Deployed BzzToken contract to address ' +
      contractData.addresses.bzzToken +
      ' with block number ' +
      contractData.blocks.bzzToken
    );
    return contractData;
  }

  contractData.addresses.bzzToken = deployed['contracts']['bzzToken']['address'];
  contractData.blocks.bzzToken = deployed['contracts']['bzzToken']['block'];
  console.log(
    'Using deployed BzzToken contract address ' +
    contractData.addresses.bzzToken +
    ' with block number ' +
    contractData.blocks.bzzToken
  );
  return contractData;
}

async function deployStaking(contractData: ContractData) {
  console.log(
    '\nDeploying Stake Registry contract to network ' +
    config.networkName +
    ' with chain id ' +
    config.chainId +
    ' and network id ' +
    config.networkId
  );
  const stakeRegistry = await hre.ethers.getContractFactory('StakeRegistry');
  const stakeRegistryContract = await upgrades.deployProxy(stakeRegistry, [contractData.addresses.bzzToken, config.networkId]);
  console.log('tx hash:' + stakeRegistryContract.deployTransaction.hash);
  await stakeRegistryContract.deployed();
  const { provider } = hre.network;
  const txReceipt = await provider.send('eth_getTransactionReceipt', [stakeRegistryContract.deployTransaction.hash]);

  contractData.blocks.staking = parseInt(txReceipt.blockNumber, 16);
  contractData.addresses.staking = stakeRegistryContract.address;
  console.log(
    'Deployed Stake Registry contract to address ' +
    contractData.addresses.staking +
    ' with block number ' +
    contractData.blocks.staking
  );
  return contractData;
}

async function deployPostageStamp(contractData: ContractData) {
  console.log(
    '\nDeploying Postage Stamp contract to network ' +
    config.networkName +
    ' with chain id ' +
    config.chainId +
    ' and bzzToken address ' +
    contractData.addresses.bzzToken
  );

  const minimumBucketDepth = 16;
  const postageStamp = await hre.ethers.getContractFactory('PostageStamp');
  const postageStampContract = await upgrades.deployProxy(postageStamp, [contractData.addresses.bzzToken, minimumBucketDepth]);
  console.log('tx hash:' + postageStampContract.deployTransaction.hash);
  await postageStampContract.deployed();

  const { provider } = hre.network;
  const txReceipt = await provider.send('eth_getTransactionReceipt', [postageStampContract.deployTransaction.hash]);

  contractData.blocks.postageStamp = parseInt(txReceipt.blockNumber, 16);
  contractData.addresses.postageStamp = postageStampContract.address;
  console.log(
    'Deployed Postage contract to address ' +
    contractData.addresses.postageStamp +
    ' with block number ' +
    contractData.blocks.postageStamp
  );
  return contractData;
}

async function deployPriceOracle(contractData: ContractData) {
  console.log(
    '\nDeploying Price Oracle contract to network ' +
    config.networkName +
    ' with chain id ' +
    config.chainId +
    ' and Postage Contract address ' +
    contractData.addresses.postageStamp
  );

  const priceOracle = await hre.ethers.getContractFactory('PriceOracle');
  const priceOracleContract = await upgrades.deployProxy(priceOracle, [contractData.addresses.postageStamp]);
  console.log('tx hash:' + priceOracleContract.deployTransaction.hash);
  await priceOracleContract.deployed();
  const { provider } = hre.network;
  const txReceipt = await provider.send('eth_getTransactionReceipt', [priceOracleContract.deployTransaction.hash]);

  contractData.blocks.priceOracle = parseInt(txReceipt.blockNumber, 16);
  contractData.addresses.priceOracle = priceOracleContract.address;
  console.log(
    'Deployed Price Oracle contract to address ' +
    contractData.addresses.priceOracle +
    ' with block number ' +
    contractData.blocks.priceOracle
  );
  return contractData;
}

async function deployRedistribution(contractData: ContractData) {
  console.log(
    '\nDeploying Redistribution contract to network ' +
    config.networkName +
    ' with chain id ' +
    config.chainId +
    ' and \n\t Stake Registry Contract address ' +
    contractData.addresses.staking +
    '\n\t Postage Contract address ' +
    contractData.addresses.postageStamp +
    '\n\t Price Oracle Contract address ' +
    contractData.addresses.priceOracle
  );

  const redistribution = await hre.ethers.getContractFactory('Redistribution');
  const redistributionContract = await upgrades.deployProxy(redistribution, [
    contractData.addresses.staking,
    contractData.addresses.postageStamp,
    contractData.addresses.priceOracle]
  );
  console.log('tx hash:' + redistributionContract.deployTransaction.hash);
  await redistributionContract.deployed();

  const { provider } = hre.network;
  const txReceipt = await provider.send('eth_getTransactionReceipt', [redistributionContract.deployTransaction.hash]);

  contractData.blocks.redistribution = parseInt(txReceipt.blockNumber, 16);
  contractData.addresses.redistribution = redistributionContract.address;
  console.log(
    'Deployed Redistribution contract to address ' +
    contractData.addresses.redistribution +
    ' with block number ' +
    contractData.blocks.redistribution
  );
  return contractData;
}

async function rolesSetter(contractData: ContractData) {
  const StakeRegistry = await ethers.getContractFactory('StakeRegistry');
  const PostageStamp = await ethers.getContractFactory('PostageStamp');
  const PriceOracle = await ethers.getContractFactory('PriceOracle');

  const stakingRegistryContract = StakeRegistry.attach(contractData.addresses.staking);
  const postageStampContract = PostageStamp.attach(contractData.addresses.postageStamp);
  const priceOracleContract = PriceOracle.attach(contractData.addresses.priceOracle);

  const priceOracleRole = postageStampContract.PRICE_ORACLE_ROLE();
  await postageStampContract.grantRole(priceOracleRole, contractData.addresses.priceOracle);

  const priceUpdaterRole = priceOracleContract.PRICE_UPDATER_ROLE();
  await priceOracleContract.grantRole(priceUpdaterRole, contractData.addresses.redistribution);

  const redistributorRoleForPostageStamp = postageStampContract.REDISTRIBUTOR_ROLE();
  await postageStampContract.grantRole(redistributorRoleForPostageStamp, contractData.addresses.redistribution);

  const redistributorRoleForStakeRegistry = stakingRegistryContract.REDISTRIBUTOR_ROLE();
  await stakingRegistryContract.grantRole(redistributorRoleForStakeRegistry, contractData.addresses.redistribution);
}

async function writeResult(deployedData: DeployedData, contractData: ContractData) {
  // console.log(contractData);
  const deployed = await JSON.parse(JSON.stringify(deployedData).toString());

  deployed['exists'] = undefined; // Don't write this auxiliary field to the result.

  deployed['networkId'] = config.networkId;
  deployed['chainId'] = config.chainId;

  const stakingABI = await require('../artifacts/src/Staking.sol/StakeRegistry.json');
  deployed['contracts']['staking']['abi'] = stakingABI.abi;
  deployed['contracts']['staking']['bytecode'] = stakingABI.bytecode.toString();

  const postageABI = await require('../artifacts/src/PostageStamp.sol/PostageStamp.json');
  deployed['contracts']['postageStamp']['abi'] = postageABI.abi;
  deployed['contracts']['postageStamp']['bytecode'] = postageABI.bytecode.toString();

  const oracleABI = await require('../artifacts/src/PriceOracle.sol/PriceOracle.json');
  deployed['contracts']['priceOracle']['abi'] = oracleABI.abi;
  deployed['contracts']['priceOracle']['bytecode'] = oracleABI.bytecode.toString();

  const redisABI = await require('../artifacts/src/Redistribution.sol/Redistribution.json');
  deployed['contracts']['redistribution']['abi'] = redisABI.abi;
  deployed['contracts']['redistribution']['bytecode'] = redisABI.bytecode.toString();

  deployed['contracts']['staking']['address'] = contractData.addresses.staking;
  deployed['contracts']['postageStamp']['address'] = contractData.addresses.postageStamp;
  deployed['contracts']['priceOracle']['address'] = contractData.addresses.priceOracle;
  deployed['contracts']['redistribution']['address'] = contractData.addresses.redistribution;

  deployed['contracts']['staking']['block'] = contractData.blocks.staking;
  deployed['contracts']['postageStamp']['block'] = contractData.blocks.postageStamp;
  deployed['contracts']['priceOracle']['block'] = contractData.blocks.priceOracle;
  deployed['contracts']['redistribution']['block'] = contractData.blocks.redistribution;

  if (!deployedData.exists) {
    const testToken = await require('../artifacts/src/TestToken.sol/TestToken.json');
    deployed['contracts']['bzzToken']['abi'] = testToken.abi;
    deployed['contracts']['bzzToken']['bytecode'] = testToken.bytecode.toString();

    deployed['contracts']['bzzToken']['address'] = contractData.addresses.bzzToken;
    deployed['contracts']['bzzToken']['block'] = contractData.blocks.bzzToken;
    deployed['contracts']['bzzToken']['url'] = '';
  }

  deployed['contracts']['postageStamp']['url'] = config.url;
  deployed['contracts']['redistribution']['url'] = config.url;
  deployed['contracts']['staking']['url'] = config.url;
  deployed['contracts']['priceOracle']['url'] = config.url;
  if (config.url.length != 0) {
    deployed['contracts']['postageStamp']['url'] += contractData.addresses.postageStamp;
    deployed['contracts']['redistribution']['url'] += contractData.addresses.redistribution;
    deployed['contracts']['staking']['url'] += contractData.addresses.staking;
    deployed['contracts']['priceOracle']['url'] += contractData.addresses.priceOracle;
  }

  fs.writeFileSync(config.networkName + '_deployed.json', JSON.stringify(deployed, null, '\t'));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
