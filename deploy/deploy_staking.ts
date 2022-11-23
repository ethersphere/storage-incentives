import { getNamedAccounts, getUnnamedAccounts, deployments } from 'hardhat';
import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';
import hre from 'hardhat';

import * as addresses from '../deployed.json';

const deployTo = process.env.DEPLOYTO;
const networkID = 5; //test network

// all contract addresses will be set here
let factory = '';
let staking = '';
// let postage = '';
// let oracle = '';
// let redistribution = '';

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
  const postage = await Postage.deploy(factory);
  await postage.deployed();
  console.log(postage.address);

  const { read, execute } = deployments;
  const priceOracleRole = await read('PostageStamp', 'PRICE_ORACLE_ROLE');
  await execute(
    'PostageStamp',
    { from: '0x1b01dd7aA18d2E1971A5e8d0403C08fCC77AAbEe' },
    'grantRole',
    '0x1b01dd7aA18d2E1971A5e8d0403C08fCC77AAbEe'
  );

  const redistributorRole = await read('PostageStamp', 'REDISTRIBUTOR_ROLE');
  await execute(
    'PostageStamp',
    { from: '0x1b01dd7aA18d2E1971A5e8d0403C08fCC77AAbEe' },
    'grantRole',
    redistributorRole,
    '0x1b01dd7aA18d2E1971A5e8d0403C08fCC77AAbEe'
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
