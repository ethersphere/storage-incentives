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
  networkDeployedData = require('../' + network.name + '_deployed.json');
} catch (e) {
  networkDeployedData = {
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
    chainId: network.config.chainId,
    networkId: networkDeployedData.networkId ? networkDeployedData.networkId : 10,
    networkName: network.name,
    deployedData: networkDeployedData,
    url: hre.config.etherscan.customChains[0]['urls']['browserURL'].toString(),
  },
  mainnet: {
    chainId: network.config.chainId,
    networkId: networkDeployedData.networkId ? networkDeployedData.networkId : 100,
    networkName: network.name,
    deployedData: networkDeployedData,
    url: hre.config.etherscan.customChains[1]['urls']['browserURL'].toString(),
  },
};

const config: ChainConfig = configs[network.name]
  ? configs[network.name]
  : ({
      chainId: network.config.chainId,
      networkId: networkDeployedData.networkId ? networkDeployedData.networkId : network.config.chainId,
      networkName: network.name,
      deployedData: networkDeployedData,
      url: '',
    } as ChainConfig);

async function main() {
  // This is deployer script for emergency deployment of only the redistribution contract with some quick fixes
  let args: string[] = [];
  if (network.name == 'mainnet') {
    // Staking, Stamps, Oracle args
    args = [
      '0x781c6D1f0eaE6F1Da1F604c6cDCcdB8B76428ba7',
      '0x30d155478eF27Ab32A1D578BE7b84BC5988aF381',
      '0x344A2CC7304B32A87EfDC5407cD4bEC7cf98F035',
    ];
  } else if (network.name == 'testnet') {
    args = [
      '0xCb07bf0603da228C8ec602bf12b973b8A94f9bac',
      '0x1f87FEDa43e6ABFe1058E96A07d0ea182e7dc9BD',
      '0x3e475aEAB162E28fee46E69225af446D3c4f3Bd3',
    ];
  }

  // Deploy the contract
  const redisFactory = await ethers.getContractFactory('Redistribution');
  console.log('Deploying contract...');
  const redis = await redisFactory.deploy(...args);
  await redis.deployed();
  console.log(`Deployed contract to: ${redis.address}`);
  await redis.deployTransaction.wait(6);

  // Change roles on current stamps contract
  // const postageStampContract = await ethers.getContractAt('PostageStamp', args[1]);
  // const redistributorRole = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('REDISTRIBUTOR_ROLE'));
  // const tx = await postageStampContract.grantRole(redistributorRole, redis.address);
  // console.log('Changed REDISTRIBUTOR ROLE at : ', tx.hash);

  // // Change roles on current staking contract
  // const stakingContract = await ethers.getContractAt('StakeRegistry', args[0]);
  // const tx2 = await stakingContract.grantRole(redistributorRole, redis.address);
  // console.log('Changed REDISTRIBUTOR ROLE at : ', tx2.hash);

  // Add metadata for Bee Node
  const deployed = await JSON.parse(JSON.stringify(config.deployedData).toString());
  const redisABI = await require('../artifacts/src/Redistribution.sol/Redistribution.json');
  deployed['contracts']['redistribution']['abi'] = redisABI.abi;
  deployed['contracts']['redistribution']['bytecode'] = redisABI.bytecode.toString();
  deployed['contracts']['redistribution']['address'] = redis.address;
  deployed['contracts']['redistribution']['block'] = redis.deployTransaction.blockNumber;
  deployed['contracts']['redistribution']['url'] = config.url + redis.address;

  fs.writeFileSync(config.networkName + '_deployed.json', JSON.stringify(deployed, null, '\t'));

  if (process.env.MAINNET_ETHERSCAN_KEY || process.env.TESTNET_ETHERSCAN_KEY) {
    console.log('Verifying...');
    await verify(redis.address, args);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
