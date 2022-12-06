import 'hardhat-deploy-ethers';
import * as fs from 'fs';
import mainnetData from '../mainnet_deployed.json';
import testnetData from '../testnet_deployed.json';
import { ethers } from 'hardhat';
import hre from 'hardhat';

interface DeployedContract {
  abi: Array<unknown>;
  bytecode: string;
  address: string;
  block: number;
  url: string;
}

interface DeployedData {
  chainId: number;
  networkId: number;
  contracts: {
    postageStamp: DeployedContract;
    redistribution: DeployedContract;
    staking: DeployedContract;
    priceOracle: DeployedContract;
    bzzToken: DeployedContract;
  };
}

interface ContractData {
  addresses: {
    postageStamp: string;
    redistribution: string;
    staking: string;
    priceOracle: string;
    bzzToken: string;
  };
  blocks: {
    postageStamp: number;
    redistribution: number;
    staking: number;
    priceOracle: number;
    bzzToken: number;
  };
}

const networkID = hre.network.config.chainId;
const blockChainVendor = hre.network.name;

async function main(deployedData: DeployedData = testnetData) {
  let contractData = {
    addresses: {
      postageStamp: '',
      redistribution: '',
      staking: '',
      priceOracle: '',
      bzzToken: '',
    },
    blocks: {
      postageStamp: 0,
      redistribution: 0,
      staking: 0,
      priceOracle: 0,
      bzzToken: 0,
    },
  };

  switch (blockChainVendor) {
    case 'testnet':
      contractData = await deployBzzToken(await JSON.parse(JSON.stringify(testnetData).toString()), contractData);
      deployedData = testnetData;
      break;
    case 'mainnet':
      contractData = await deployBzzToken(await JSON.parse(JSON.stringify(mainnetData).toString()), contractData);
      deployedData = mainnetData;
      break;
    default:
      contractData = await deployBzzToken(null, contractData);
  }

  if (!contractData.addresses.bzzToken) {
    throw new Error('BzzToken address not found for deployment over ' + blockChainVendor);
  }

  contractData = await deployRedistribution(
    await deployPriceOracle(await deployPostageStamp(await deployStaking(contractData)))
  );

  await rolesSetter(contractData);

  await writeResult(deployedData, contractData);
}

async function deployBzzToken(deployed: DeployedData | null, contractData: ContractData) {
  if (deployed == null) {
    console.log(
      'Deploying BzzToken contract to network ' + hre.network.name + ' with chain id ' + hre.network.config.chainId
    );
    const TestToken = await hre.ethers.getContractFactory('TestToken');
    const testToken = await TestToken.deploy();
    console.log('tx hash:' + testToken.deployTransaction.hash);
    await testToken.deployed();
    contractData.addresses.bzzToken = testToken.address;
    contractData.blocks.bzzToken = testToken.deployTransaction.blockNumber as number;
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
      hre.network.name +
      ' with chain id ' +
      hre.network.config.chainId +
      ' and network id ' +
      networkID
  );
  const StakeRegistryContract = await hre.ethers.getContractFactory('StakeRegistry');
  const stakeRegistryContract = await StakeRegistryContract.deploy(contractData.addresses.bzzToken, networkID);
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
      hre.network.name +
      ' with chain id ' +
      hre.network.config.chainId +
      ' and bzzToken address ' +
      contractData.addresses.bzzToken
  );
  const Postage = await hre.ethers.getContractFactory('PostageStamp');
  const postageContract = await Postage.deploy(contractData.addresses.bzzToken);
  console.log('tx hash:' + postageContract.deployTransaction.hash);
  await postageContract.deployed();

  const { provider } = hre.network;
  const txReceipt = await provider.send('eth_getTransactionReceipt', [postageContract.deployTransaction.hash]);

  contractData.blocks.postageStamp = parseInt(txReceipt.blockNumber, 16);
  contractData.addresses.postageStamp = postageContract.address;
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
      hre.network.name +
      ' with chain id ' +
      hre.network.config.chainId +
      ' and Postage Contract address ' +
      contractData.addresses.postageStamp
  );

  const Oracle = await hre.ethers.getContractFactory('PriceOracle');
  const priceOracleContract = await Oracle.deploy(contractData.addresses.postageStamp);
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
      hre.network.name +
      ' with chain id ' +
      hre.network.config.chainId +
      ' and \n\t Stake Registry Contract address ' +
      contractData.addresses.staking +
      '\n\t Postage Contract address ' +
      contractData.addresses.postageStamp +
      '\n\t Price Oracle Contract address ' +
      contractData.addresses.priceOracle
  );

  const Redistribution = await hre.ethers.getContractFactory('Redistribution');
  const redistributionContract = await Redistribution.deploy(
    contractData.addresses.staking,
    contractData.addresses.postageStamp,
    contractData.addresses.priceOracle
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
  const PostageStamp = await ethers.getContractFactory('PostageStamp');
  const StakeReg = await ethers.getContractFactory('StakeRegistry');
  const Oracle = await ethers.getContractFactory('PriceOracle');

  const contract = PostageStamp.attach(contractData.addresses.postageStamp);

  const redistributorRole = contract.REDISTRIBUTOR_ROLE();
  await contract.grantRole(redistributorRole, contractData.addresses.redistribution);

  const priceOracleRole = contract.PRICE_ORACLE_ROLE();
  await contract.grantRole(priceOracleRole, contractData.addresses.priceOracle);

  const contract2 = StakeReg.attach(contractData.addresses.staking);

  const redistributorRole2 = contract2.REDISTRIBUTOR_ROLE();
  await contract2.grantRole(redistributorRole2, contractData.addresses.redistribution);

  const contract3 = Oracle.attach(contractData.addresses.priceOracle);
  const priceUpdaterRole = contract3.PRICE_UPDATER_ROLE();
  await contract2.grantRole(priceUpdaterRole, contractData.addresses.redistribution);
}

async function writeResult(deployedData: DeployedData, contractData: ContractData) {
  const deployed = await JSON.parse(JSON.stringify(deployedData).toString());

  //set addresses
  deployed['contracts']['postageStamp']['address'] = contractData.addresses.postageStamp;
  deployed['contracts']['redistribution']['address'] = contractData.addresses.redistribution;
  deployed['contracts']['staking']['address'] = contractData.addresses.staking;
  deployed['contracts']['priceOracle']['address'] = contractData.addresses.priceOracle;

  //set blocks
  deployed['contracts']['postageStamp']['block'] = contractData.blocks.postageStamp;
  deployed['contracts']['redistribution']['block'] = contractData.blocks.redistribution;
  deployed['contracts']['staking']['block'] = contractData.blocks.staking;
  deployed['contracts']['priceOracle']['block'] = contractData.blocks.priceOracle;

  //set abi and bytecode
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const postageABI = await require('../artifacts/src/PostageStamp.sol/PostageStamp.json');
  deployed['contracts']['postageStamp']['abi'] = postageABI.abi;
  deployed['contracts']['postageStamp']['bytecode'] = postageABI.bytecode.toString();

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const redisABI = await require('../artifacts/src/Redistribution.sol/Redistribution.json');
  deployed['contracts']['redistribution']['abi'] = redisABI.abi;
  deployed['contracts']['redistribution']['bytecode'] = redisABI.bytecode.toString();

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const stakingABI = await require('../artifacts/src/Staking.sol/StakeRegistry.json');
  deployed['contracts']['staking']['abi'] = stakingABI.abi;
  deployed['contracts']['staking']['bytecode'] = stakingABI.bytecode.toString();

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const oracleABI = await require('../artifacts/src/PriceOracle.sol/PriceOracle.json');
  deployed['contracts']['priceOracle']['abi'] = oracleABI.abi;
  deployed['contracts']['priceOracle']['bytecode'] = oracleABI.bytecode.toString();

  // set chain and network id
  deployed['networkId'] = networkID;
  deployed['chainId'] = hre.network.config.chainId;

  // Construct URL for contract
  let urlAddress = '';
  let fileName = '';
  switch (blockChainVendor) {
    case 'testnet':
      urlAddress = hre.config.etherscan.customChains[0]['urls']['browserURL'].toString();
      fileName = 'testnet_deployed.json';
      break;
    case 'mainnet':
      urlAddress = hre.config.etherscan.customChains[1]['urls']['browserURL'].toString();
      fileName = 'mainnet_deployed.json';
      break;
    default:
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const testToken = await require('../artifacts/src/TestToken.sol/TestToken.json');
      deployed['contracts']['bzzToken']['abi'] = testToken.abi;
      deployed['contracts']['bzzToken']['bytecode'] = testToken.bytecode.toString();

      deployed['contracts']['bzzToken']['address'] = contractData.addresses.bzzToken;
      deployed['contracts']['bzzToken']['block'] = contractData.blocks.bzzToken;
      deployed['contracts']['bzzToken']['url'] = '';
      break;
  }
  if (urlAddress.length != 0) {
    deployed['contracts']['postageStamp']['url'] = urlAddress + contractData.addresses.postageStamp;
    deployed['contracts']['redistribution']['url'] = urlAddress + contractData.addresses.redistribution;
    deployed['contracts']['staking']['url'] = urlAddress + contractData.addresses.staking;
    deployed['contracts']['priceOracle']['url'] = urlAddress + contractData.addresses.priceOracle;
  } else {
    deployed['contracts']['postageStamp']['url'] = urlAddress;
    deployed['contracts']['redistribution']['url'] = urlAddress;
    deployed['contracts']['staking']['url'] = urlAddress;
    deployed['contracts']['priceOracle']['url'] = urlAddress;
  }

  if (fileName.length == 0 || !fs.existsSync(fileName)) {
    fileName = blockChainVendor + '_deployed.json';
  }
  fs.writeFileSync(fileName, JSON.stringify(deployed, null, '\t'));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
