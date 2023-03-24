import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';
import { networkConfig, developmentChains } from '../helper-hardhat-config';
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

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, network } = hre;
  const { deploy, execute, get, read, log } = deployments;

  var deployedData: DeployedData;

  deployedData = {
    chainId: networkConfig[network.name].chainID,
    networkId: networkConfig[network.name].networkID,
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

  console.log(stakingContract.receipt!.blockNumber);

  // TODO rework tokendata to use predifned bytecode and address and blocknumber when testnet or mainet
  // Token data
  deployedData['contracts']['bzzToken']['abi'] = tokenContract.abi;
  deployedData['contracts']['bzzToken']['bytecode'] = tokenContract.bytecode!;
  deployedData['contracts']['bzzToken']['address'] = tokenContract.address;
  deployedData['contracts']['bzzToken']['block'] = tokenContract.receipt!.blockNumber;
  deployedData['contracts']['bzzToken']['url'] = networkConfig[network.name].scanLink + tokenContract.address;

  // PostageStamp data
  deployedData['contracts']['postageStamp']['abi'] = stampsContract.abi;
  deployedData['contracts']['postageStamp']['bytecode'] = stampsContract.bytecode!;
  deployedData['contracts']['postageStamp']['address'] = stampsContract.address;
  deployedData['contracts']['postageStamp']['block'] = stampsContract.receipt!.blockNumber;
  deployedData['contracts']['postageStamp']['url'] = networkConfig[network.name].scanLink + stampsContract.address;

  // Redistribution data
  deployedData['contracts']['redistribution']['abi'] = redisContract.abi;
  deployedData['contracts']['redistribution']['bytecode'] = redisContract.bytecode!;
  deployedData['contracts']['redistribution']['address'] = redisContract.address;
  deployedData['contracts']['redistribution']['block'] = redisContract.receipt!.blockNumber;
  deployedData['contracts']['redistribution']['url'] = networkConfig[network.name].scanLink + redisContract.address;

  // Staking data
  deployedData['contracts']['staking']['abi'] = stakingContract.abi;
  deployedData['contracts']['staking']['bytecode'] = stakingContract.bytecode!;
  deployedData['contracts']['staking']['address'] = stakingContract.address;
  deployedData['contracts']['staking']['block'] = stakingContract.receipt!.blockNumber;
  deployedData['contracts']['staking']['url'] = networkConfig[network.name].scanLink + stakingContract.address;

  // Oracle data
  deployedData['contracts']['priceOracle']['abi'] = oracleContract.abi;
  deployedData['contracts']['priceOracle']['bytecode'] = oracleContract.bytecode!;
  deployedData['contracts']['priceOracle']['address'] = oracleContract.address;
  deployedData['contracts']['priceOracle']['block'] = oracleContract.receipt!.blockNumber;
  deployedData['contracts']['priceOracle']['url'] = networkConfig[network.name].scanLink + oracleContract.address;

  await writeResult(deployedData);
  log('----------------------------------------------------');
};

export default func;
func.tags = ['all', 'local', 'deployedData'];
