import 'hardhat-deploy-ethers';
import '@nomiclabs/hardhat-etherscan';
import { ethers, network } from 'hardhat';
import verify from '../utils/verify';
import hre from 'hardhat';
import * as fs from 'fs';

interface DeployedContract {
  abi: Array<unknown>;
  bytecode: string;
  address: string;
  block: number;
  url: string;
}

interface DeployedData {
  chainId: number;
  swarmNetworkId: number;
  contracts: {
    bzzToken: DeployedContract;
    staking: DeployedContract;
    postageStamp: DeployedContract;
    priceOracle: DeployedContract;
    redistribution: DeployedContract;
  };
}

interface ChainConfig {
  chainId?: number;
  swarmNetworkId?: number;
  networkName: string;
  deployedData: DeployedData;
  url: string;
}

let networkDeployedData: DeployedData;
try {
  networkDeployedData = require('../' + network.name + '_deployed.json');
} catch (e) {
  networkDeployedData = {
    chainId: 0,
    swarmNetworkId: 0,
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
    chainId: network.config.chainId,
    swarmNetworkId: networkDeployedData.swarmNetworkId ? networkDeployedData.swarmNetworkId : 10,
    networkName: network.name,
    deployedData: networkDeployedData,
    url: hre.config.etherscan.customChains[1]['urls']['browserURL'].toString(),
  },
  mainnet: {
    chainId: network.config.chainId,
    swarmNetworkId: networkDeployedData.swarmNetworkId ? networkDeployedData.swarmNetworkId : 1,
    networkName: network.name,
    deployedData: networkDeployedData,
    url: hre.config.etherscan.customChains[2]['urls']['browserURL'].toString(),
  },
};

const config: ChainConfig = configs[network.name]
  ? configs[network.name]
  : ({
      chainId: network.config.chainId,
      swarmNetworkId: networkDeployedData.swarmNetworkId ? networkDeployedData.swarmNetworkId : network.config.chainId,
      networkName: network.name,
      deployedData: networkDeployedData,
      url: '',
    } as ChainConfig);

async function main() {
  // This is deployer script for emergency deployment of only the postagestamp contract with some quick fixes
  let args: string[] = [];
  let waitTime = 6;
  let currentRedis = '';
  let currentOracle = '';
  if (network.name == 'mainnet') {
    // BZZ Token address, minimumBucketDepth, multisig
    args = ['0xb1C7F17Ed88189Abf269Bf68A3B2Ed83C5276aAe', '16'];
    currentRedis = '';
    currentOracle = '';
  } else if (network.name == 'testnet') {
    args = ['0x2ac3c1d3e24b45c6c310534bc2dd84b5ed576335', '16'];
    currentRedis = '0x9e3BDb0c69838CC06D85409d4AD6245e54F70F1d';
    currentOracle = '0xefC5Ead3188402eCC951DB45827F6e0F99B67a25';
  } else if (network.name == 'localhost') {
    args = ['0x942C6684eB9874C63d4ed26Ab0623F951D253081', '16'];
    currentRedis = '0xDF64aed195102E644ad6A0204eD5377589b29618';
    currentOracle = '0xF52458e65b8e3B69d93DD3803d8ef934c75E0022';
    waitTime = 1;
  }

  // Deploy the contract
  const stampFactory = await ethers.getContractFactory('PostageStamp');
  console.log('Deploying contract...');
  const stamp = await stampFactory.deploy(...args);
  await stamp.deployed();
  const deploymentReceipt = await stamp.deployTransaction.wait(waitTime);

  // Add metadata for Bee Node
  const deployed = await JSON.parse(JSON.stringify(config.deployedData).toString());
  const stampABI = await require('../artifacts/src/PostageStamp.sol/PostageStamp.json');
  deployed['contracts']['postageStamp']['abi'] = stampABI.abi;
  deployed['contracts']['postageStamp']['bytecode'] = stampABI.bytecode.toString();
  deployed['contracts']['postageStamp']['address'] = stamp.address;
  deployed['contracts']['postageStamp']['block'] = deploymentReceipt.blockNumber;
  deployed['contracts']['postageStamp']['url'] = config.url + stamp.address;

  // We need to first deploy this contract and then use this address and deploy with it redistribution
  // After that we can add here redis role

  // Change roles on current staking contract
  const redistributorRole = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('REDISTRIBUTOR_ROLE'));
  const tx2 = await stamp.grantRole(redistributorRole, currentRedis);
  console.log('Changed REDISTRIBUTOR ROLE at : ', tx2.hash);

  const oracleRole = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('PRICE_ORACLE_ROLE'));
  const tx3 = await stamp.grantRole(oracleRole, currentOracle);
  console.log('Changed ORACLE ROLE at : ', tx3.hash);

  fs.writeFileSync(config.networkName + '_deployed.json', JSON.stringify(deployed, null, '\t'));

  if ((process.env.MAINNET_ETHERSCAN_KEY || process.env.TESTNET_ETHERSCAN_KEY) && network.name != 'localhost') {
    console.log('Verifying...');
    await verify(stamp.address, args);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
