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
    oracle: DeployedContract;
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
      oracle: {} as DeployedContract,
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
  // This is deployer script for emergency deployment of only the stake contract with some quick fixes
  let args: string[] = [];
  let waitTime = 6;
  if (network.name == 'mainnet') {
    //SwarmNetworkId, BZZ token, Multisig
    args = ['1', '0xb1C7F17Ed88189Abf269Bf68A3B2Ed83C5276aAe', '0xb1C7F17Ed88189Abf269Bf68A3B2Ed83C5276aAe'];
  } else if (network.name == 'testnet') {
    args = ['10', '0x0b2bbcbe94d5d4bb782713b137c85d29aa609a13', '0xb1C7F17Ed88189Abf269Bf68A3B2Ed83C5276aAe'];
  } else if (network.name == 'localhost') {
    args = ['0', '0x942C6684eB9874C63d4ed26Ab0623F951D253081', '0x3c8F39EE625fCF97cB6ee22bCe25BE1F1E5A5dE8'];
    waitTime = 1;
  }

  // Deploy the contract
  const stakeFactory = await ethers.getContractFactory('StakeRegistry');
  console.log('Deploying contract...');
  const stake = await stakeFactory.deploy(...args);
  await stake.deployed();
  console.log(`Deployed contract to: ${stake.address}`);
  const deploymentReceipt = await stake.deployTransaction.wait(waitTime);

  // Add metadata for Bee Node
  const deployed = await JSON.parse(JSON.stringify(config.deployedData).toString());
  const stakeABI = await require('../artifacts/src/Staking.sol/StakeRegistry.json');
  deployed['contracts']['priceOracle']['abi'] = stakeABI.abi;
  deployed['contracts']['priceOracle']['bytecode'] = stakeABI.bytecode.toString();
  deployed['contracts']['priceOracle']['address'] = stake.address;
  deployed['contracts']['priceOracle']['block'] = deploymentReceipt.blockNumber;
  deployed['contracts']['priceOracle']['url'] = config.url + stake.address;

  fs.writeFileSync(config.networkName + '_deployed.json', JSON.stringify(deployed, null, '\t'));

  if ((process.env.MAINNET_ETHERSCAN_KEY || process.env.TESTNET_ETHERSCAN_KEY) && network.name != 'localhost') {
    console.log('Verifying...');
    await verify(stake.address, args);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
