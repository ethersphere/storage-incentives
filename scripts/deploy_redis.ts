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
  // This is deployer script for emergency deployment of only the redistribution contract with some quick fixes
  let args: string[] = [];
  let waitTime = 6;
  if (network.name == 'mainnet') {
    // Staking, Stamps, Oracle, multisig
    args = [
      '0x781c6D1f0eaE6F1Da1F604c6cDCcdB8B76428ba7', // old staking
      '0x30d155478eF27Ab32A1D578BE7b84BC5988aF381',
      '0x344A2CC7304B32A87EfDC5407cD4bEC7cf98F035',
      '0xb1C7F17Ed88189Abf269Bf68A3B2Ed83C5276aAe',
    ];
  } else if (network.name == 'testnet') {
    args = [
      '0x484fc3388FD1083fbaF8CE12F282df11F1095Ddf',
      '0xf86b48B65355D292dDE7da8B4ad1913a72ad45C9',
      '0x17CFdc0Ac0723ef2c9F39D4BC1FFBeD0405FffeD',
      '0xb1C7F17Ed88189Abf269Bf68A3B2Ed83C5276aAe',
    ];
  } else if (network.name == 'localhost') {
    args = [
      '0xFC402f08a61Ebfc4e30e1DB6Cfb38b79578709C1',
      '0x9A2F29598CB0787Aa806Bbfb65B82A9e558945E7',
      '0xF52458e65b8e3B69d93DD3803d8ef934c75E0022',
      '0x3c8F39EE625fCF97cB6ee22bCe25BE1F1E5A5dE8',
    ];
    waitTime = 1;
  }

  // Deploy the contract
  const redisFactory = await ethers.getContractFactory('Redistribution');
  console.log('Deploying contract...');
  const redis = await redisFactory.deploy(...args);
  await redis.deployed();
  console.log(`Deployed contract to: ${redis.address}`);
  const deploymentReceipt = await redis.deployTransaction.wait(waitTime);

  // Change roles on current stamps contract
  const postageStampContract = await ethers.getContractAt('PostageStamp', args[1]);
  const redistributorRole = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('REDISTRIBUTOR_ROLE'));
  const tx = await postageStampContract.grantRole(redistributorRole, redis.address);
  console.log('Changed REDISTRIBUTOR ROLE at : ', tx.hash);

  // Change roles on current staking contract
  const stakingContract = await ethers.getContractAt('StakeRegistry', args[0]);
  const tx2 = await stakingContract.grantRole(redistributorRole, redis.address);
  console.log('Changed REDISTRIBUTOR ROLE at : ', tx2.hash);

  // Add metadata for Bee Node
  const deployed = await JSON.parse(JSON.stringify(config.deployedData).toString());
  const redisABI = await require('../artifacts/src/Redistribution.sol/Redistribution.json');
  deployed['contracts']['redistribution']['abi'] = redisABI.abi;
  deployed['contracts']['redistribution']['bytecode'] = redisABI.bytecode.toString();
  deployed['contracts']['redistribution']['address'] = redis.address;
  deployed['contracts']['redistribution']['block'] = deploymentReceipt.blockNumber;
  deployed['contracts']['redistribution']['url'] = config.url + redis.address;

  fs.writeFileSync(config.networkName + '_deployed.json', JSON.stringify(deployed, null, '\t'));

  if ((process.env.MAINNET_ETHERSCAN_KEY || process.env.TESTNET_ETHERSCAN_KEY) && network.name != 'localhost') {
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
