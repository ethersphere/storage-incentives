// This script should be used when you CREATE new fork on Tenderly and you want to make automated setup for it
// What we do here is delete files from hardhat deployments folders as we will deploy new contracts to forked network
// then we will give ADMIN role to deployer on forked staking contract, finally we will send XDAI funds to deployer so
// it can be used to deploy contracts for this fork

import 'hardhat-deploy-ethers';
import '@nomiclabs/hardhat-etherscan';
import { ethers, getNamedAccounts, network } from 'hardhat';
import { NetworkConfig, HttpNetworkConfig } from 'hardhat/types';
import { networkConfig } from '../helper-hardhat-config';

import { unlink, rm } from 'fs';
import { promisify } from 'util';
import axios from 'axios';

const unlinkAsync = promisify(unlink);
const rmAsync = promisify(rm);

const filesToDelete = [
  'deployments/tenderly/PostageStamp.json',
  'deployments/tenderly/PriceOracle.json',
  'deployments/tenderly/Redistribution.json',
];
const directoryToDelete = 'deployments/tenderly/solcInputs';

async function deleteFiles(filePaths: string[]) {
  try {
    for (const filePath of filePaths) {
      await unlinkAsync(filePath);
      console.log(`Deleted file: ${filePath}`);
    }
    console.log('All files have been deleted successfully.');
  } catch (error) {
    console.error('Error deleting files');
  }
}

async function deleteDirectory(directoryPath: string) {
  try {
    await rmAsync(directoryPath, { recursive: true, force: true });
    console.log(`Deleted directory and all its contents: ${directoryPath}`);
  } catch (error) {
    console.error('Error deleting directory:', error);
  }
}

function isHttpNetworkConfig(config: NetworkConfig): config is HttpNetworkConfig {
  return 'url' in config;
}

async function main() {
  const { deployer } = await getNamedAccounts();

  // Remove previous deployment so we start fresh for contracts that will be deployed, modify them per case
  await deleteFiles(filesToDelete);
  await deleteDirectory(directoryToDelete);

  let forkId: string;

  if (isHttpNetworkConfig(network.config)) {
    forkId = network.config.url.split('/').slice(-2).join('/');
  } else {
    throw new Error('Network configuration does not include a URL');
  }

  // Give ADMIN role to deployer on deployed Staking, then it can set roles to new contracts
  // On Tenderly we can fake FROM with this API call
  const staking = await ethers.getContractAt('StakeRegistry', '0x781c6D1f0eaE6F1Da1F604c6cDCcdB8B76428ba7');
  const SIMULATE_API = `https://api.tenderly.co/api/v1/account/SwarmDebug/project/swarm/${forkId}/simulate`;

  console.log(SIMULATE_API);
  // Transaction details
  const transaction = {
    network_id: '100',
    from: networkConfig['mainnet'].multisig,
    to: staking.address,
    input:
      '0x2f2ff15d0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000b1c7f17ed88189abf269bf68a3b2ed83c5276aae',
    save: true,
  };

  const opts = {
    headers: {
      'X-Access-Key': process.env.TENDERLY_ACCESS_KEY || '',
    },
  };

  await axios.post(SIMULATE_API, transaction, opts);
  console.log('Added current deployer as ADMIN via simulated multisig wallet');

  // Fund deployer wallet
  console.log('Funding deployment wallets');

  const WALLETS = [deployer, networkConfig['mainnet'].multisig];
  await ethers.provider.send('tenderly_setBalance', [
    WALLETS,
    // Amount in wei will be set for all wallets
    ethers.utils.hexValue(ethers.utils.parseUnits('100', 'ether').toHexString()),
  ]);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
