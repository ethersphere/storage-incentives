import 'hardhat-deploy-ethers';
import * as fs from 'fs';
import mainnetData from '../mainnet_deployed.json';
import testnetData from '../testnet_deployed.json';
import hre from 'hardhat';
import { ethers } from 'ethers';
import '@nomiclabs/hardhat-etherscan/dist/src/type-extensions';
import { spawnSync } from 'child_process';
import { InfuraToken } from '../hardhat.config';
//abi imports
import postageABI from '../artifacts/src/PostageStamp.sol/PostageStamp.json';
import redisABI from '../artifacts/src/Redistribution.sol/Redistribution.json';
import stakingABI from '../artifacts/src/Staking.sol/StakeRegistry.json';
import oracleABI from '../artifacts/src/PriceOracle.sol/PriceOracle.json';
import bzzTokenABI from '../artifacts/src/TestToken.sol/TestToken.json';

let account: ethers.Wallet;

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

let configurations: ChainConfig;

interface ChainConfig {
  chainId?: number;
  networkId?: number;
  networkName: string;
  url: string;
  deployedData: DeployedData;
  etherscanKey: string;
}

const configs: Record<string, ChainConfig> = {
  testnet: {
    chainId: hre.network.config.chainId,
    networkId: 10,
    networkName: hre.network.name,
    url: hre.config.etherscan.customChains[0]['urls']['browserURL'].toString(),
    deployedData: testnetData,
    etherscanKey: '',
  },
  mainnet: {
    chainId: hre.network.config.chainId,
    networkId: 1,
    networkName: hre.network.name,
    url: hre.config.etherscan.customChains[1]['urls']['browserURL'].toString(),
    deployedData: mainnetData,
    etherscanKey: '',
  },
  private: {
    chainId: hre.network.config.chainId,
    networkId: 10000,
    networkName: hre.network.name,
    url: '',
    deployedData: testnetData,
    etherscanKey: '',
  },
};

interface Mnemonic {
  mnemonic: string;
}

interface Etherscan {
  testnet: string;
  mainnet: string;
}

const blockChainVendor = hre.network.name;

async function main() {
  await setConfigurations();

  // // fill deployedData with already compiled data e.g. bytecode and ABI
  // const deployedData = await writeResult(
  //   await writeURL(
  //     await rolesSetter(
  //       await deployRedistribution(
  //         await deployPriceOracle(
  //           await deployPostageStamp(
  //             await deployStakeRegistry(await deployBzzToken(await setCompiledData(configurations.deployedData)))
  //           )
  //         )
  //       )
  //     )
  //   )
  // );

  if (configurations.etherscanKey.length == 34) {
    await verifier(configurations.deployedData);
  }
}

async function setConfigurations() {
  let wallet: ethers.Wallet;
  if (Array.isArray(hre.network.config.accounts)) {
    if (hre.network.config.accounts.length > 1) {
      throw new Error('only 1 private key expected');
    }
    wallet = new ethers.Wallet(hre.network.config.accounts[0] as string);
  } else if (isMnemonic(hre.network.config.accounts)) {
    wallet = ethers.Wallet.fromMnemonic(hre.network.config.accounts.mnemonic);
  } else {
    throw new Error('unknown type');
  }
  switch (blockChainVendor) {
    case 'testnet':
      account = wallet.connect(new ethers.providers.JsonRpcProvider('https://goerli.infura.io/v3/' + InfuraToken));
      configurations = configs['testnet'];
      if (isTestnetKey(hre.config.etherscan.apiKey)) {
        configurations.etherscanKey = hre.config.etherscan.apiKey.testnet;
      }
      break;
    case 'mainnet':
      account = wallet.connect(new ethers.providers.JsonRpcProvider(process.env.MAINNETPROVIDER));
      configurations = configs['mainnet'];
      if (isMainnetKey(hre.config.etherscan.apiKey)) {
        configurations.etherscanKey = hre.config.etherscan.apiKey.mainnet;
      }
      break;
    default:
      account = wallet.connect(hre.ethers.provider);
      configurations = configs['private'];
  }
}

function isMnemonic(param: unknown): param is Mnemonic {
  return typeof param === 'object' && param != null && 'mnemonic' in param;
}

function isTestnetKey(param: unknown): param is Etherscan {
  return typeof param === 'object' && param != null && 'testnet' in param;
}

function isMainnetKey(param: unknown): param is Etherscan {
  return typeof param === 'object' && param != null && 'mainnet' in param;
}

async function deployBzzToken(deployed: DeployedData) {
  if (configurations.networkName == 'testnet' || configurations.networkName == 'testnet') {
    const bzzTokenAddress = deployed['contracts']['bzzToken']['address'];
    const block = deployed['contracts']['bzzToken']['block'];
    console.log('Using deployed BzzToken contract address ' + bzzTokenAddress + ' with block number ' + block);

    if (bzzTokenAddress.length < 0) {
      throw new Error('BzzToken address not found for deployment over ' + blockChainVendor);
    }
    return deployed;
  }
  console.log(
    'Deploying BzzToken contract to network ' + configurations.networkName + ' with chain id ' + configurations.chainId
  );
  const TestToken = new ethers.ContractFactory(bzzTokenABI.abi, bzzTokenABI.bytecode).connect(account);
  const testToken = await TestToken.deploy();
  console.log('tx hash:' + testToken.deployTransaction.hash);
  await testToken.deployed();
  const address = testToken.address;
  const blockNum = await getBlock(testToken.deployTransaction.hash);
  await deployedInfo('Bzz Token', blockNum, address);
  return await setAddressAndBlock(deployed, 'bzzToken', address, blockNum);
}

async function deployStakeRegistry(deployedData: DeployedData) {
  console.log(
    '\nDeploying Stake Registry contract to network ' +
      configurations.networkName +
      ' with chain id ' +
      configurations.chainId +
      ' and network id ' +
      deployedData['networkId']
  );
  const StakeRegistryContract = new ethers.ContractFactory(stakingABI.abi, stakingABI.bytecode).connect(account);
  const stakeRegistryContract = await StakeRegistryContract.deploy(
    deployedData['contracts']['bzzToken']['address'],
    deployedData['networkId']
  );

  console.log('tx hash:' + stakeRegistryContract.deployTransaction.hash);
  await stakeRegistryContract.deployed();

  // block number and address
  const blockNumber = await getBlock(stakeRegistryContract.deployTransaction.hash);
  const address = stakeRegistryContract.address;

  await deployedInfo('Stake Registry', blockNumber, address);

  return await setAddressAndBlock(deployedData, 'staking', address, blockNumber);
}

async function deployPostageStamp(deployedData: DeployedData) {
  console.log(
    '\nDeploying Postage Stamp contract to network ' +
      configurations.networkName +
      ' with chain id ' +
      configurations.chainId +
      ' ,with network id ' +
      deployedData['networkId'] +
      ' and bzzToken address ' +
      deployedData['contracts']['bzzToken']['address']
  );

  const PostageStampContract = new ethers.ContractFactory(postageABI.abi, postageABI.bytecode).connect(account);
  const postageStampContract = await PostageStampContract.deploy(deployedData['contracts']['bzzToken']['address'], 16);

  // log tx hash
  console.log('tx hash:' + postageStampContract.deployTransaction.hash);
  await postageStampContract.deployed();

  // block number and address
  const blockNumber = await getBlock(postageStampContract.deployTransaction.hash);
  const address = postageStampContract.address;

  await deployedInfo('Postage Stamp', blockNumber, address);

  return await setAddressAndBlock(deployedData, 'postageStamp', address, blockNumber);
}

async function deployPriceOracle(deployedData: DeployedData) {
  console.log(
    '\nDeploying Price Oracle contract to network ' +
      configurations.networkName +
      ' with chain id ' +
      configurations.chainId +
      ' and Postage Contract address ' +
      deployedData['contracts']['postageStamp']['address']
  );

  const PriceOracleContract = new ethers.ContractFactory(oracleABI.abi, oracleABI.bytecode).connect(account);
  const priceOracleContract = await PriceOracleContract.deploy(deployedData['contracts']['postageStamp']['address']);

  // log tx hash
  console.log('tx hash:' + priceOracleContract.deployTransaction.hash);
  await priceOracleContract.deployed();

  // block number and address
  const blockNumber = await getBlock(priceOracleContract.deployTransaction.hash);
  const address = priceOracleContract.address;

  await deployedInfo('Price Oracle', blockNumber, address);

  return await setAddressAndBlock(deployedData, 'priceOracle', address, blockNumber);
}

async function deployRedistribution(deployedData: DeployedData) {
  console.log(
    '\nDeploying Redistribution contract to network ' +
      configurations.networkName +
      ' with chain id ' +
      configurations.chainId +
      ' and \n\t Stake Registry Contract address ' +
      deployedData['contracts']['staking']['address'] +
      '\n\t Postage Contract address ' +
      deployedData['contracts']['postageStamp']['address'] +
      '\n\t Price Oracle Contract address ' +
      deployedData['contracts']['priceOracle']['address']
  );

  const RedistributionContract = new ethers.ContractFactory(redisABI.abi, redisABI.bytecode).connect(account);
  const redistributionContract = await RedistributionContract.deploy(
    deployedData['contracts']['staking']['address'],
    deployedData['contracts']['postageStamp']['address'],
    deployedData['contracts']['priceOracle']['address']
  );

  // log tx hash
  console.log('tx hash:' + redistributionContract.deployTransaction.hash);
  await redistributionContract.deployed();

  // block number and address
  const blockNumber = await getBlock(redistributionContract.deployTransaction.hash);
  const address = redistributionContract.address;

  await deployedInfo('Redistribution Contract', blockNumber, address);

  return await setAddressAndBlock(deployedData, 'redistribution', address, blockNumber);
}

async function rolesSetter(deployedData: DeployedData) {
  const StakeRegistry = await new ethers.Contract(
    deployedData['contracts']['staking']['address'],
    stakingABI.abi,
    account
  );
  const PostageStamp = await new ethers.Contract(
    deployedData['contracts']['postageStamp']['address'],
    postageABI.abi,
    account
  );
  const PriceOracle = await new ethers.Contract(
    deployedData['contracts']['priceOracle']['address'],
    oracleABI.abi,
    account
  );

  console.log('\nGranting Price Oracle Role in Postage Stamp Contract');
  await PostageStamp.grantRole(
    await PostageStamp.PRICE_ORACLE_ROLE(),
    deployedData['contracts']['priceOracle']['address']
  );

  console.log('\nGranting Price Updater Role in Price Oracle Contract');
  await PriceOracle.grantRole(PriceOracle.PRICE_UPDATER_ROLE(), deployedData['contracts']['redistribution']['address']);

  console.log('\nGranting Redistributor Role in Postage Stamp Contract');
  await PostageStamp.grantRole(
    PostageStamp.REDISTRIBUTOR_ROLE(),
    deployedData['contracts']['redistribution']['address']
  );

  console.log('\nGranting Redistributor Role in Stake Registry Contract');
  await StakeRegistry.grantRole(
    StakeRegistry.REDISTRIBUTOR_ROLE(),
    deployedData['contracts']['redistribution']['address']
  );

  return deployedData;
}

async function setAddressAndBlock(deployedData: DeployedData, contractName: string, address: string, block: number) {
  const deployed = await JSON.parse(JSON.stringify(deployedData).toString());
  // set contract address
  deployed['contracts'][contractName]['address'] = address;
  // set contract block
  deployed['contracts'][contractName]['block'] = block;
  return deployed;
}

async function getBlock(params: string) {
  const { provider } = hre.network;
  const txReceipt = await provider.send('eth_getTransactionReceipt', [params]);
  return parseInt(await txReceipt.blockNumber, 16);
}

async function writeURL(deployed: DeployedData) {
  if (configurations.networkName == 'testnet' || configurations.networkName == 'mainnet') {
    deployed['contracts']['postageStamp']['url'] =
      configurations.url + deployed['contracts']['postageStamp']['address'];
    deployed['contracts']['redistribution']['url'] =
      configurations.url + deployed['contracts']['redistribution']['address'];
    deployed['contracts']['staking']['url'] = configurations.url + deployed['contracts']['staking']['address'];
    deployed['contracts']['priceOracle']['url'] = configurations.url + deployed['contracts']['priceOracle']['address'];
  } else {
    deployed['contracts']['postageStamp']['url'] = '';
    deployed['contracts']['redistribution']['url'] = '';
    deployed['contracts']['staking']['url'] = '';
    deployed['contracts']['priceOracle']['url'] = '';
    deployed['contracts']['bzzToken']['url'] = '';
  }
  return deployed;
}

async function writeResult(deployedData: DeployedData) {
  let fileName = '';

  if (fileName.length == 0 || !fs.existsSync(fileName)) {
    fileName = blockChainVendor + '_deployed.json';
  }

  fs.writeFileSync(fileName, JSON.stringify(deployedData, null, '\t'));

  return deployedData;
}

async function setCompiledData(deployedData: DeployedData) {
  //set abi and bytecode
  deployedData['contracts']['postageStamp']['abi'] = postageABI.abi;
  deployedData['contracts']['postageStamp']['bytecode'] = postageABI.bytecode.toString();

  deployedData['contracts']['redistribution']['abi'] = redisABI.abi;
  deployedData['contracts']['redistribution']['bytecode'] = redisABI.bytecode.toString();

  deployedData['contracts']['staking']['abi'] = stakingABI.abi;
  deployedData['contracts']['staking']['bytecode'] = stakingABI.bytecode.toString();

  deployedData['contracts']['priceOracle']['abi'] = oracleABI.abi;
  deployedData['contracts']['priceOracle']['bytecode'] = oracleABI.bytecode.toString();

  // set chain and network id
  if (configurations.networkId != null) {
    deployedData['networkId'] = configurations.networkId;
  }
  if (configurations.chainId != null) {
    deployedData['chainId'] = configurations.chainId;
  }

  return deployedData;
}

async function deployedInfo(name: string, block: number, address: string) {
  console.log('Deployed ' + name + ' contract to address ' + address + ' with block number ' + block);
}

async function verifier(deployedData: DeployedData) {
  await processExecutor(
    deployedData['contracts']['staking']['address'],
    deployedData['contracts']['bzzToken']['address'] + ' ' + deployedData['networkId']
  );

  await processExecutor(
    deployedData['contracts']['postageStamp']['address'],
    deployedData['contracts']['bzzToken']['address'] + ' ' + 16
  );

  await processExecutor(
    deployedData['contracts']['priceOracle']['address'],
    deployedData['contracts']['postageStamp']['address']
  );

  await processExecutor(
    deployedData['contracts']['redistribution']['address'],
    deployedData['contracts']['staking']['address'] +
      ' ' +
      deployedData['contracts']['postageStamp']['address'] +
      ' ' +
      deployedData['contracts']['priceOracle']['address']
  );
  return deployedData;
}

async function processExecutor(address: string, args: string) {
  const sp = spawnSync('yarn run hardhat verify ' + address + ' ' + args + ' --network testnet ', [], {
    timeout: 30000,
    stdio: ['inherit', 'inherit', 'pipe'],
    shell: true,
  });
  if (sp.stderr.toString('utf-8').match('[A|a]lready [V|v]erified')) {
    console.log('Contract already verified');
  } else if (sp.stderr.toString() === null || sp.stderr.toString() === '') {
    console.log('Contract Verified Successfully');
  } else {
    throw new Error(sp.stderr.toString());
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
