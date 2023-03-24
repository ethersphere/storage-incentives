import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';
import { networkConfig, developmentChains } from '../helper-hardhat-config';
import verify from '../utils/verify';
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

  const { deployer, oracle, redistributor } = await getNamedAccounts();

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
    return deployedData;
  }


  // TODO This is placeholder for saving deployed data, model it per 1558.ts file
  //const stakingArtifact = await deployments.getArtifact("StakeRegistry");
  const stakingContract = await get('PriceOracle');
  console.log(stakingContract.receipt!.blockNumber);

  deployedData['contracts']['staking']['abi'] = stakingContract.abi;
  deployedData['contracts']['staking']['bytecode'] = stakingContract.bytecode!;
  deployedData['contracts']['staking']['address'] = stakingContract.address;
  deployedData['contracts']['staking']['block'] = stakingContract.receipt!.blockNumber;
  deployedData['contracts']['staking']['url'] = networkConfig[network.name].scanLink + stakingContract.address;

  await writeResult(deployedData);
  log('----------------------------------------------------');
};

export default func;
func.tags = ['all', 'local', 'deployedData'];
