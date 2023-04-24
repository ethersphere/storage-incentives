import { DeployFunction } from 'hardhat-deploy/types';
import { developmentChains, deployedBzzData } from '../helper-hardhat-config';
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
    postageStamp: DeployedContract;
    redistribution: DeployedContract;
    staking: DeployedContract;
    priceOracle: DeployedContract;
    bzzToken: DeployedContract;
  };
}

const func: DeployFunction = async function ({ deployments, network, config }) {
  const { get, log } = deployments;

  // Chain ID and Network ID are often the same but could be different https://chainid.network/chains_mini.json
  const deployedData = {
    chainId: network.config.chainId,
    networkId: network.config.chainId,
    contracts: {
      bzzToken: {} as DeployedContract,
      staking: {} as DeployedContract,
      postageStamp: {} as DeployedContract,
      priceOracle: {} as DeployedContract,
      redistribution: {} as DeployedContract,
    },
  } as DeployedData;

  async function writeResult(deployedData: DeployedData) {
    let fileName = '';

    if (fileName.length == 0 || !fs.existsSync(fileName)) {
      fileName = network.name + '_deployed.json';
    }

    fs.writeFileSync(fileName, JSON.stringify(deployedData, null, '\t') + '\n');
    log('Data saved to ' + fileName);
  }

  const stampsContract = await get('PostageStamp');
  const oracleContract = await get('PriceOracle');
  const stakingContract = await get('StakeRegistry');
  const redisContract = await get('Redistribution');
  const browserURL = config.etherscan.customChains.find(
    (chain) => chain.network === network.name
  )?.urls.browserURL;


  // Insert already deployed data if it is mainnet or testnet
  if (!developmentChains.includes(network.name)) {
    network.name == 'mainnet'
      ? (deployedData['contracts']['bzzToken'] = deployedBzzData.mainnet)
      : (deployedData['contracts']['bzzToken'] = deployedBzzData.testnet);
  } else {
    // Token data for dev chains
    const tokenContract = await get('TestToken');
    deployedData['contracts']['bzzToken']['abi'] = tokenContract.abi;
    deployedData['contracts']['bzzToken']['bytecode'] = tokenContract.bytecode ? tokenContract.bytecode : '';
    deployedData['contracts']['bzzToken']['address'] = tokenContract.address;
    deployedData['contracts']['bzzToken']['block'] =
      tokenContract.receipt && tokenContract.receipt.blockNumber ? tokenContract.receipt.blockNumber : 0;
    deployedData['contracts']['bzzToken']['url'] = browserURL + tokenContract.address;
  }

  // PostageStamp data
  deployedData['contracts']['postageStamp']['abi'] = stampsContract.abi;
  deployedData['contracts']['postageStamp']['bytecode'] = stampsContract.bytecode ? stampsContract.bytecode : '';
  deployedData['contracts']['postageStamp']['address'] = stampsContract.address;
  deployedData['contracts']['postageStamp']['block'] =
    stampsContract.receipt && stampsContract.receipt.blockNumber ? stampsContract.receipt.blockNumber : 0;
  deployedData['contracts']['postageStamp']['url'] = browserURL + stampsContract.address;

  // Redistribution data
  deployedData['contracts']['redistribution']['abi'] = redisContract.abi;
  deployedData['contracts']['redistribution']['bytecode'] = redisContract.bytecode ? redisContract.bytecode : '';
  deployedData['contracts']['redistribution']['address'] = redisContract.address;
  deployedData['contracts']['redistribution']['block'] =
    redisContract.receipt && redisContract.receipt.blockNumber ? redisContract.receipt.blockNumber : 0;
  deployedData['contracts']['redistribution']['url'] = browserURL + redisContract.address;

  // Staking data
  deployedData['contracts']['staking']['abi'] = stakingContract.abi;
  deployedData['contracts']['staking']['bytecode'] = stakingContract.bytecode ? stakingContract.bytecode : '';
  deployedData['contracts']['staking']['address'] = stakingContract.address;
  deployedData['contracts']['staking']['block'] =
    stakingContract.receipt && stakingContract.receipt.blockNumber ? stakingContract.receipt.blockNumber : 0;
  deployedData['contracts']['staking']['url'] = browserURL + stakingContract.address;

  // Oracle data
  deployedData['contracts']['priceOracle']['abi'] = oracleContract.abi;
  deployedData['contracts']['priceOracle']['bytecode'] = oracleContract.bytecode ? oracleContract.bytecode : '';
  deployedData['contracts']['priceOracle']['address'] = oracleContract.address;
  deployedData['contracts']['priceOracle']['block'] =
    oracleContract.receipt && oracleContract.receipt.blockNumber ? oracleContract.receipt.blockNumber : 0;
  deployedData['contracts']['priceOracle']['url'] = browserURL + oracleContract.address;

  await writeResult(deployedData);
  log('----------------------------------------------------');
};

export default func;
func.tags = ['main', 'local'];
