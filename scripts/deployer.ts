import { ethers } from 'hardhat';
import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';
import 'hardhat-deploy-ethers';
import hre from 'hardhat';
import * as fs from 'fs';
import { ContractReceipt, ContractTransaction } from 'ethers';

import deployedData from '../deployed.json';
const fileName = 'deployed.json';
// refactor:
//  mainnet_deployed.json
//  testnet_deployed.json
//  local_deployed.json

const deployTo = process.env.DEPLOYTO;
const networkID = 5; //test network

// all contract addresses will be set here
let factory = '';
let staking = '';
let postage = '';
let oracle = '';
let redistribution = '';

async function main() {
  console.log('ran');
  console.log(deployTo);
  if (deployTo == 'ganache') {
    const TestToken = await hre.ethers.getContractFactory('TestToken');
    const testToken = await TestToken.deploy();
    await testToken.deployed();
    console.log(testToken.address);
    factory = testToken.address;
  }

  const StakeRegistry = await hre.ethers.getContractFactory('StakeRegistry');
  const stakeRegistry = await StakeRegistry.deploy(factory, networkID);
  await stakeRegistry.deployed();
  console.log(stakeRegistry.address);

  staking = stakeRegistry.address;

  const Postage = await hre.ethers.getContractFactory('PostageStamp');
  const postageadd = await Postage.deploy(factory);
  await postageadd.deployed();
  console.log(postageadd.address);

  postage = postageadd.address;

  const Oracle = await hre.ethers.getContractFactory('PostageStamp');
  const oracleAdd = await Oracle.deploy(postage);
  await postageadd.deployed();
  console.log(oracleAdd.address);

  oracle = oracleAdd.address;

  const Redistribution = await hre.ethers.getContractFactory('Redistribution');
  const redisAdd = await Redistribution.deploy(staking, postage, oracle);
  await redisAdd.deployed();
  console.log(redisAdd.address);

  redistribution = redisAdd.address;

  await jsonIO();
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
  console.log(result);
  receipt = await result.wait();

  const contract2 = StakeReg.attach(staking);

  const redistributorRole2 = contract2.REDISTRIBUTOR_ROLE();
  result = await contract2.grantRole(redistributorRole2, redistribution);
  console.log(result);
  receipt = await result.wait();
  console.log(receipt);
}

async function jsonIO() {
  const deployed = JSON.parse(JSON.stringify(deployedData).toString());

  deployed['contracts']['postage']['deployer'] = 'haseeb';

  //set addresses
  deployed['contracts']['postage']['deployedAddress'] = postage;
  deployed['contracts']['redistribution']['deployedAddress'] = redistribution;
  deployed['contracts']['staking']['deployedAddress'] = staking;
  deployed['contracts']['priceOracle']['deployedAddress'] = oracle;

  //set abi and bytecode
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const postageABI = require('../artifacts/src/PostageStamp.sol/PostageStamp.json');
  deployed['contracts']['postage']['abi'] = postageABI.abi;
  deployed['contracts']['postage']['bytecode'] = postageABI.bytecode;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const redisABI = require('../artifacts/src/Redistribution.sol/Redistribution.json');
  deployed['contracts']['redistribution']['abi'] = redisABI.abi;
  deployed['contracts']['redistribution']['bytecode'] = redisABI.bytecode;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const stakingABI = require('../artifacts/src/Staking.sol/StakeRegistry.json');
  deployed['contracts']['staking']['abi'] = stakingABI.abi;
  deployed['contracts']['staking']['bytecode'] = stakingABI.bytecode;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const oracleABI = require('../artifacts/src/PriceOracle.sol/PriceOracle.json');
  deployed['contracts']['priceOracle']['abi'] = oracleABI.abi;
  deployed['contracts']['priceOracle']['bytecode'] = oracleABI.bytecode;

  await fs.writeFile(
    fileName,
    JSON.stringify(deployed),
    await function writeJSON(err) {
      if (err) return console.log(err);
      console.log('writing to ' + fileName);
    }
  );
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
