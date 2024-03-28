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
  // This is deployer script for emergency deployment of only the oracle contract with some quick fixes
  let args: string[] = [];
  let waitTime = 6;
  let currentRedis = '';
  if (network.name == 'mainnet') {
    // Postagestamp, Multisig
    args = ['0x30d155478eF27Ab32A1D578BE7b84BC5988aF381', '0xb1C7F17Ed88189Abf269Bf68A3B2Ed83C5276aAe'];
    currentRedis = '0xDF64aed195102E644ad6A0204eD5377589b29618';
  } else if (network.name == 'testnet') {
    args = ['0xf86b48B65355D292dDE7da8B4ad1913a72ad45C9', '0xb1C7F17Ed88189Abf269Bf68A3B2Ed83C5276aAe'];
    currentRedis = '0x9e3BDb0c69838CC06D85409d4AD6245e54F70F1d';
  } else if (network.name == 'localhost') {
    args = ['0x9A2F29598CB0787Aa806Bbfb65B82A9e558945E7', '0x62cab2b3b55f341f10348720ca18063cdb779ad5'];
    waitTime = 1;
    currentRedis = '0xDF64aed195102E644ad6A0204eD5377589b29618';
  }

  // Deploy the contract
  const oracleFactory = await ethers.getContractFactory('PriceOracle');
  console.log('Deploying contract...');
  const oracle = await oracleFactory.deploy(...args);
  await oracle.deployed();
  console.log(`Deployed contract to: ${oracle.address}`);
  const deploymentReceipt = await oracle.deployTransaction.wait(waitTime);

  // Add metadata for Bee Node
  const deployed = await JSON.parse(JSON.stringify(config.deployedData).toString());
  const oracleABI = await require('../artifacts/src/PriceOracle.sol/PriceOracle.json');
  deployed['contracts']['priceOracle']['abi'] = oracleABI.abi;
  deployed['contracts']['priceOracle']['bytecode'] = oracleABI.bytecode.toString();
  deployed['contracts']['priceOracle']['address'] = oracle.address;
  deployed['contracts']['priceOracle']['block'] = deploymentReceipt.blockNumber;
  deployed['contracts']['priceOracle']['url'] = config.url + oracle.address;

  // Change roles on current oracle contract
  const updaterRole = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('PRICE_UPDATER_ROLE'));
  const tx2 = await oracle.grantRole(updaterRole, currentRedis);
  console.log('Changed PRICE UPDATER ROLE at : ', tx2.hash);

  // TODO Needs to be unpaused to be running, either here with trx on through etherscan or something like that

  fs.writeFileSync(config.networkName + '_deployed.json', JSON.stringify(deployed, null, '\t'));

  if ((process.env.MAINNET_ETHERSCAN_KEY || process.env.TESTNET_ETHERSCAN_KEY) && network.name != 'localhost') {
    console.log('Verifying...');
    await verify(oracle.address, args);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
