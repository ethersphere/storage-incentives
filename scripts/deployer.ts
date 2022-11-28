import 'hardhat-deploy-ethers';
import * as fs from 'fs';
import { ContractReceipt, ContractTransaction } from 'ethers';
import mainnetData from '../mainnet_deployed.json';
import testnetData from '../testnet_deployed.json';
import dummyData from '../example_testnet_deployed.json';
import { getCurrentTimestamp } from 'hardhat/internal/hardhat-network/provider/utils/getCurrentTimestamp';
import { ethers } from 'hardhat';
import hre from 'hardhat';

interface DeployedContract {
  abi: Array<any>; // Improve these types
  bytecode: string;
  address: string;
  block: number;
  url: string;
}

interface DeployedData {
  contracts: {
    postageStamp: DeployedContract;
    redistribution: DeployedContract;
    staking: DeployedContract;
    priceOracle: DeployedContract;
    factory: DeployedContract;
  };
}

let fileName = 'example_testnet_deployed.json';

// URL
const mainnetURL = 'https://gnosisscan.io/address/';
const testnetURL = 'https://goerli.etherscan.io/address/';

const blockChainVendor = hre.network.name;
const networkID = hre.network.config.chainId;

async function main(deployedData: DeployedData = dummyData) {
  let contractData = {
    addresses: {
      postageStamp: '',
      redistribution: '',
      staking: '',
      priceOracle: '',
      factory: '',
    },
    blocks: {
      postageStamp: 0,
      redistribution: 0,
      staking: 0,
      priceOracle: 0,
      factory: 0,
    },
  };

  switch (blockChainVendor) {
    case 'testnet':
      contractData = await deployFactory(await JSON.parse(JSON.stringify(testnetData).toString()), contractData);
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      deployedData = testnetData;
      break;
    case 'mainnet':
      contractData = await deployFactory(await JSON.parse(JSON.stringify(mainnetData).toString()), contractData);
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      deployedData = mainnetData;
      break;
    default:
      contractData = await deployFactory(null, contractData);
  }

  if (!contractData.addresses.factory) {
    handleErr('expected factory address');
  }

  contractData = await deployRedistribution(
    await deployPriceOracle(await deployPostageStamp(await deployStaking(contractData)))
  );

  await rolesSetter(contractData);

  await writeResult(deployedData, contractData);
  await logResult(contractData);
}

async function deployFactory(deployed: any, contractData: any) {
  if (deployed == null) {
    const TestToken = await hre.ethers.getContractFactory('TestToken');
    const testToken = await TestToken.deploy();
    await testToken.deployed();
    contractData.addresses.factory = testToken.address;
    contractData.blocks.factory = testToken.deployTransaction.blockNumber as number;
    return contractData;
  }
  contractData.addresses.factory = deployed['contracts']['factory']['address'];
  contractData.blocks.factory = deployed['contracts']['factory']['block'];
  return contractData;
}

async function deployStaking(contractData: any) {
  const StakeRegistryContract = await hre.ethers.getContractFactory('StakeRegistry');
  const stakeRegistryContract = await StakeRegistryContract.deploy(contractData.addresses.factory, networkID);
  await stakeRegistryContract.deployed();
  console.log(stakeRegistryContract.address);
  const { provider } = hre.network;
  const txReceipt = await provider.send('eth_getTransactionReceipt', [stakeRegistryContract.deployTransaction.hash]);

  contractData.blocks.staking = parseInt(txReceipt.blockNumber, 16);
  contractData.addresses.staking = stakeRegistryContract.address;
  console.log('staking address:' + contractData.addresses.staking + '\n block:' + contractData.blocks.staking);
  return contractData;
}

async function deployPostageStamp(contractData: any) {
  const Postage = await hre.ethers.getContractFactory('PostageStamp');
  const postageContract = await Postage.deploy(contractData.addresses.factory);
  await postageContract.deployed();

  const { provider } = hre.network;
  const txReceipt = await provider.send('eth_getTransactionReceipt', [postageContract.deployTransaction.hash]);

  contractData.blocks.postageStamp = parseInt(txReceipt.blockNumber, 16);
  contractData.addresses.postageStamp = postageContract.address;
  console.log('postage address:' + postageContract.address + '\n block:' + contractData.blocks.postageStamp);
  return contractData;
}

async function deployPriceOracle(contractData: any) {
  const Oracle = await hre.ethers.getContractFactory('PriceOracle');
  const priceOracleContract = await Oracle.deploy(contractData.addresses.postageStamp);
  await priceOracleContract.deployed();
  const { provider } = hre.network;
  const txReceipt = await provider.send('eth_getTransactionReceipt', [priceOracleContract.deployTransaction.hash]);

  contractData.blocks.priceOracle = parseInt(txReceipt.blockNumber, 16);
  contractData.addresses.priceOracle = priceOracleContract.address;
  console.log('oracle address:' + priceOracleContract.address + '\n block:' + contractData.blocks.priceOracle);
  return contractData;
}

async function deployRedistribution(contractData: any) {
  const Redistribution = await hre.ethers.getContractFactory('Redistribution');
  const redistributionContract = await Redistribution.deploy(
    contractData.addresses.staking,
    contractData.addresses.postageStamp,
    contractData.addresses.priceOracle
  );
  await redistributionContract.deployed();

  const { provider } = hre.network;
  const txReceipt = await provider.send('eth_getTransactionReceipt', [redistributionContract.deployTransaction.hash]);

  contractData.blocks.redistribution = parseInt(txReceipt.blockNumber, 16);
  contractData.addresses.redistribution = redistributionContract.address;
  console.log(
    'redistribution address:' + redistributionContract.address + '\n block:' + contractData.blocks.redistribution
  );
  return contractData;
}

async function logResult(contractData: any) {
  console.log('\n---Contract Addresses with Blocks | Timestamp: ' + getCurrentTimestamp());
  console.log('staking address:' + contractData.addresses.staking + '\n block:' + contractData.blocks.staking);
  console.log(
    'redistribution address:' +
      contractData.addresses.redistribution +
      '\n block:' +
      (contractData.blocks.redistribution as number)
  );
  console.log('oracle address:' + contractData.addresses.priceOracle + '\n block:' + contractData.blocks.priceOracle);
  console.log(
    'postage address:' +
      contractData.addresses.postageStamp +
      '\n block:' +
      (contractData.blocks.postageStamp as number)
  );
}

async function rolesSetter(contractData: any) {
  const [deployer] = await ethers.getSigners();

  const PostageStamp = await ethers.getContractFactory('PostageStamp');
  const StakeReg = await ethers.getContractFactory('StakeRegistry');

  const contract = PostageStamp.attach(contractData.addresses.postageStamp);

  let result: ContractTransaction;
  let receipt: ContractReceipt;

  const redistributorRole = contract.REDISTRIBUTOR_ROLE();
  result = await contract.grantRole(redistributorRole, contractData.addresses.redistribution);
  receipt = await result.wait();

  const contract2 = StakeReg.attach(contractData.addresses.staking);

  const redistributorRole2 = contract2.REDISTRIBUTOR_ROLE();
  result = await contract2.grantRole(redistributorRole2, contractData.addresses.redistribution);
  receipt = await result.wait();
}

async function writeResult(deployedData: any, contractData: any) {
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

  // Construct URL for contract
  let urlAddress = '';
  switch (blockChainVendor) {
    case 'testnet':
      urlAddress = testnetURL;
      fileName = 'testnet_deployed.json';
      break;
    case 'mainnet':
      urlAddress = mainnetURL;
      fileName = 'testnet_deployed.json';
      break;
    default:
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

    fs.writeFileSync(fileName, JSON.stringify(deployed, null, '\t'));
  }
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

function handleErr(err: string) {
  console.error(err);
  process.exit(1);
}
