import { ethers } from 'hardhat';
import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';
import 'hardhat-deploy-ethers';
import hre from 'hardhat';
import * as fs from 'fs';
import { ContractReceipt, ContractTransaction } from 'ethers';
import mainnetData from '../mainnet_deployed.json';
import testnetData from '../testnet_deployed.json';
import dummyData from '../example_testnet_deployed.json';
import { getCurrentTimestamp } from 'hardhat/internal/hardhat-network/provider/utils/getCurrentTimestamp';

let deployedData = dummyData;
let fileName = 'example_testnet_deployed.json';
// refactor:
//  mainnet_deployed.json
//  testnet_deployed.json
//  local_deployed.json

// URL
const mainnetURL = 'https://gnosisscan.io/address/';
const testnetURL = 'https://goerli.etherscan.io/address/';

// Chain Vendor
const blockChainVendor = hre.network.name;
const networkID = hre.network.config.chainId;

// all contract addresses will be set here
let factory = '';
let staking = '';
let postage = '';
let oracle = '';
let redistribution = '';

// all block numbers will be set here
let factoryBlock = 0;
let stakingBlock = 0;
let postageBlock = 0;
let oracleBlock = 0;
let redistributionBlock = 0;

async function main() {
  if (blockChainVendor != 'testnet' && blockChainVendor != 'mainnet') {
    const TestToken = await hre.ethers.getContractFactory('TestToken');
    const testToken = await TestToken.deploy();
    await testToken.deployed();
    factory = testToken.address;
    factoryBlock = testToken.deployTransaction.blockNumber as number;
  } else if (blockChainVendor == 'testnet') {
    const deployed = await JSON.parse(JSON.stringify(testnetData).toString());
    factory = deployed['contracts']['factory']['address'];
    factoryBlock = deployed['contracts']['factory']['block'];
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    deployedData = testnetData;
  } else if (blockChainVendor == 'mainnet') {
    const deployed = await JSON.parse(JSON.stringify(mainnetData).toString());
    factory = deployed['contracts']['factory']['address'];
    factoryBlock = deployed['contracts']['factory']['block'];
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    deployedData = mainnetData;
  }

  if (!factory) {
    handleErr('expected factory address');
  }

  const StakeRegistry = await hre.ethers.getContractFactory('StakeRegistry');
  const stakeRegistry = await StakeRegistry.deploy(factory, networkID);
  await stakeRegistry.deployed();
  stakingBlock = stakeRegistry.deployTransaction.blockNumber as number;
  staking = stakeRegistry.address;

  const Postage = await hre.ethers.getContractFactory('PostageStamp');
  const postageadd = await Postage.deploy(factory);
  await postageadd.deployed();
  postageBlock = postageadd.deployTransaction.blockNumber as number;
  postage = postageadd.address;

  const Oracle = await hre.ethers.getContractFactory('PriceOracle');
  const oracleAdd = await Oracle.deploy(postage);
  await oracleAdd.deployed();
  oracleBlock = oracleAdd.deployTransaction.blockNumber as number;
  oracle = oracleAdd.address;

  const Redistribution = await hre.ethers.getContractFactory('Redistribution');
  const redisAdd = await Redistribution.deploy(staking, postage, oracle);
  await redisAdd.deployed();
  redistributionBlock = redisAdd.deployTransaction.blockNumber as number;
  redistribution = redisAdd.address;

  if (blockChainVendor == 'testnet' || blockChainVendor == 'mainnet') {
    await rolesSetter();
  }
  await jsonIO();
  await log();
}

async function log() {
  console.log('\n---Contract Addresses with Blocks | Timestamp: ' + getCurrentTimestamp());
  console.log('staking address:' + staking + '\n block:' + stakingBlock);
  console.log('redistribution address:' + redistribution + '\n block:' + redistributionBlock);
  console.log('oracle address:' + oracle + '\n block:' + oracleBlock);
  console.log('postage address:' + postage + '\n block:' + postageBlock);
}

async function rolesSetter() {
  const [deployer] = await ethers.getSigners();

  const PostageStamp = await ethers.getContractFactory('PostageStamp');
  const StakeReg = await ethers.getContractFactory('StakeRegistry');

  const contract = PostageStamp.attach(postage);

  let result: ContractTransaction;
  let receipt: ContractReceipt;

  const redistributorRole = contract.REDISTRIBUTOR_ROLE();
  result = await contract.grantRole(redistributorRole, redistribution);
  receipt = await result.wait();

  const contract2 = StakeReg.attach(staking);

  const redistributorRole2 = contract2.REDISTRIBUTOR_ROLE();
  result = await contract2.grantRole(redistributorRole2, redistribution);
  receipt = await result.wait();
}

async function jsonIO() {
  const deployed = await JSON.parse(JSON.stringify(deployedData).toString());

  //set addresses
  deployed['contracts']['postage']['address'] = postage;
  deployed['contracts']['redistribution']['address'] = redistribution;
  deployed['contracts']['staking']['address'] = staking;
  deployed['contracts']['priceOracle']['address'] = oracle;

  //set blocks
  deployed['contracts']['postage']['block'] = postageBlock;
  deployed['contracts']['redistribution']['block'] = redistributionBlock;
  deployed['contracts']['staking']['block'] = stakingBlock;
  deployed['contracts']['priceOracle']['block'] = oracleBlock;

  //set abi and bytecode
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const postageABI = await require('../artifacts/src/PostageStamp.sol/PostageStamp.json');
  deployed['contracts']['postage']['abi'] = postageABI.abi;
  deployed['contracts']['postage']['bytecode'] = postageABI.bytecode.toString();

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
  if (blockChainVendor == 'testnet') {
    urlAddress = testnetURL;
    fileName = 'testnet_deployed.json';
  } else if (blockChainVendor == 'mainnet') {
    urlAddress = mainnetURL;
    fileName = 'mainnet_deployed.json';
  } else {
    urlAddress = 'not supported/';
  }
  deployed['contracts']['postage']['url'] = urlAddress + postage;
  deployed['contracts']['redistribution']['url'] = urlAddress + redistribution;
  deployed['contracts']['staking']['url'] = urlAddress + staking;
  deployed['contracts']['priceOracle']['url'] = urlAddress + oracle;

  fs.writeFileSync(fileName, JSON.stringify(deployed, null, '\t'));
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
