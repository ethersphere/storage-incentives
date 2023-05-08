import '@nomiclabs/hardhat-ethers';
import '@nomiclabs/hardhat-etherscan';
import { ethers, network, upgrades } from 'hardhat';
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
  // This is deployer script for emergency deployment of only the postageStamp contract with some quick fixes
  let args: Array<string | number> = [];
  let proxyAddress = '';

  if (network.name == 'mainnet') {
    // Staking, Stamps, Oracle args
    args = ['0x70b34daD3DDb19B8c5574d611cf1a607A01856f5', 16];
    proxyAddress = '0x70058cC8A9e538140007853fE7c553eBE1773C06';
  } else if (network.name == 'testnet') {
    args = ['0x70b34daD3DDb19B8c5574d611cf1a607A01856f5', 16];
    proxyAddress = '0x70058cC8A9e538140007853fE7c553eBE1773C06';
  }

  // Deploy the contract
  const stampFactory = await ethers.getContractFactory('PostageStamp');
  console.log('Upgrading contract...');

  //const stamp = await upgrades.upgradeProxy(proxyAddress, stampFactory);
  const stamp = await upgrades.forceImport(proxyAddress, stampFactory);
  await stamp.deployed();

  console.log(`Deployed contract to: ${stamp.address}`);
  const deploymentReceipt = await stamp.deployTransaction.wait(6);

  // Change roles on current stamps contract
  //   const postageStampContract = await ethers.getContractAt('PostageStamp', args[1]);
  //   const redistributorRole = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('REDISTRIBUTOR_ROLE'));
  //   const tx = await postageStampContract.grantRole(redistributorRole, stamp.address);
  //   console.log('Changed REDISTRIBUTOR ROLE at : ', tx.hash);

  //   // Change roles on current staking contract
  //   const stakingContract = await ethers.getContractAt('StakeRegistry', args[0]);
  //   const tx2 = await stakingContract.grantRole(redistributorRole, stamp.address);
  //   console.log('Changed REDISTRIBUTOR ROLE at : ', tx2.hash);

  // Add metadata for Bee Node
  const deployed = await JSON.parse(JSON.stringify(config.deployedData).toString());
  const stampABI = await require('../artifacts/src/postageStamp.sol/PotageStamp.json');
  deployed['contracts']['postageStamp']['abi'] = stampABI.abi;
  deployed['contracts']['postageStamp']['bytecode'] = stampABI.bytecode.toString();
  deployed['contracts']['postageStamp']['address'] = stamp.address;
  deployed['contracts']['postageStamp']['block'] = deploymentReceipt.blockNumber;
  deployed['contracts']['postageStamp']['url'] = config.url + stamp.address;

  fs.writeFileSync(config.networkName + '_deployed.json', JSON.stringify(deployed, null, '\t'));

  if (process.env.MAINNET_ETHERSCAN_KEY || process.env.TESTNET_ETHERSCAN_KEY) {
    console.log('Verifying...');
    await verify(stamp.address);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
