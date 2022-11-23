import { ethers } from 'hardhat';
import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';
import 'hardhat-deploy-ethers';
import hre from 'hardhat';

import * as addresses from '../deployed.json';
import { ContractReceipt, ContractTransaction } from 'ethers';

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

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
