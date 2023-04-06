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
  networkDeployedData = require('../localhost_deployed.json');
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
  args = [
    '0xCb07bf0603da228C8ec602bf12b973b8A94f9bac',
    '0x1f87FEDa43e6ABFe1058E96A07d0ea182e7dc9BD',
    '0x3e475aEAB162E28fee46E69225af446D3c4f3Bd3',
  ];

  // Deploy the contract
  const redisFactory = await ethers.getContractFactory('Redistribution');
  console.log('Deploying contract...');
  const redis = await redisFactory.deploy(...args);
  const tx1 = await redis.deployed();
  console.log(`Deployed contract to: ${redis.address}`);
  //await redis.deployTransaction.wait(6);


  // Add metadata for Bee Node
  const deployed = await JSON.parse(JSON.stringify(config.deployedData).toString());
  const redisABI = await require('../artifacts/src/Redistribution.sol/Redistribution.json');
  deployed['contracts']['redistribution']['abi'] = redisABI.abi;
  deployed['contracts']['redistribution']['bytecode'] = redisABI.bytecode.toString();
  deployed['contracts']['redistribution']['address'] = redis.address;
  deployed['contracts']['redistribution']['block'] = redis.deployTransaction.blockNumber;
  deployed['contracts']['redistribution']['url'] = config.url;

  fs.writeFileSync(config.networkName + '_deployed.json', JSON.stringify(deployed, null, '\t'));
  console.log(config);

}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
