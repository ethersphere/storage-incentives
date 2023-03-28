import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';
import { networkConfig, developmentChains, deployedBzzData } from '../helper-hardhat-config';
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

const func: DeployFunction = async function ({ deployments, getNamedAccounts, network }) {
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

    fs.writeFileSync(fileName, JSON.stringify(deployedData, null, '\t'));
    return log('Data saved to ' + fileName);
  }

  const tokenContract = await get('TestToken');
  const stampsContract = await get('PostageStamp');
  const oracleContract = await get('PriceOracle');
  const stakingContract = await get('StakeRegistry');
  const redisContract = await get('Redistribution');

  // Insert already deployed data if it is mainnet or testnet
  if (!developmentChains.includes(network.name)) {
    network.name == 'mainnet'
      ? (deployedData['contracts']['bzzToken'] = deployedBzzData.mainnet)
      : (deployedData['contracts']['bzzToken'] = deployedBzzData.testnet);
  } else {
    // Token data for dev chains
    deployedData['contracts']['bzzToken']['abi'] = tokenContract.abi;
    deployedData['contracts']['bzzToken']['bytecode'] = tokenContract.bytecode!;
    deployedData['contracts']['bzzToken']['address'] = tokenContract.address;
    deployedData['contracts']['bzzToken']['block'] = tokenContract.receipt!.blockNumber;
    deployedData['contracts']['bzzToken']['url'] = '';
  }

  // PostageStamp data
  deployedData['contracts']['postageStamp']['abi'] = stampsContract.abi;
  deployedData['contracts']['postageStamp']['bytecode'] = stampsContract.bytecode!;
  deployedData['contracts']['postageStamp']['address'] = stampsContract.address;
  deployedData['contracts']['postageStamp']['block'] = stampsContract.receipt!.blockNumber;
  deployedData['contracts']['postageStamp']['url'] = '';

  // Redistribution data
  deployedData['contracts']['redistribution']['abi'] = redisContract.abi;
  deployedData['contracts']['redistribution']['bytecode'] = redisContract.bytecode!;
  deployedData['contracts']['redistribution']['address'] = redisContract.address;
  deployedData['contracts']['redistribution']['block'] = redisContract.receipt!.blockNumber;
  deployedData['contracts']['redistribution']['url'] = '';

  // Staking data
  deployedData['contracts']['staking']['abi'] = stakingContract.abi;
  deployedData['contracts']['staking']['bytecode'] = stakingContract.bytecode!;
  deployedData['contracts']['staking']['address'] = stakingContract.address;
  deployedData['contracts']['staking']['block'] = stakingContract.receipt!.blockNumber;
  deployedData['contracts']['staking']['url'] = '';

  // Oracle data
  deployedData['contracts']['priceOracle']['abi'] = oracleContract.abi;
  deployedData['contracts']['priceOracle']['bytecode'] = oracleContract.bytecode!;
  deployedData['contracts']['priceOracle']['address'] = oracleContract.address;
  deployedData['contracts']['priceOracle']['block'] = oracleContract.receipt!.blockNumber;
  deployedData['contracts']['priceOracle']['url'] = '';

  await writeResult(deployedData);
  log('----------------------------------------------------');
};

export default func;
func.tags = ['all', 'local'];