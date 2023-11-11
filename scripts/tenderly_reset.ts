// Run this only when you have NEW Tenderly FORK and what to do a new SETUP for it.

import 'hardhat-deploy-ethers';
import '@nomiclabs/hardhat-etherscan';
import { ethers, getNamedAccounts } from 'hardhat';
const axios = require('axios');
import { networkConfig } from '../helper-hardhat-config';

import { unlink, rm } from 'fs';
import { promisify } from 'util';

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

async function main() {
  const { deployer } = await getNamedAccounts();

  // Fund deployer wallet
  console.log('Funding deployment wallets');

  const WALLETS = [deployer, networkConfig['mainnet'].multisig];
  await ethers.provider.send('tenderly_setBalance', [
    WALLETS,
    // Amount in wei will be set for all wallets
    ethers.utils.hexValue(ethers.utils.parseUnits('10', 'ether').toHexString()),
  ]);

  // Remove previous deployment so we start fresh for contracts that will be deployed, modify them per case
  await deleteFiles(filesToDelete);
  await deleteDirectory(directoryToDelete);

  // Add missing role for Staking so deployer can set roles to new contracts
  // On Tenderly we can set any FROM it will work
  const staking = await ethers.getContractAt('StakeRegistry', '0x781c6D1f0eaE6F1Da1F604c6cDCcdB8B76428ba7');
  const SIMULATE_API = `https://api.tenderly.co/api/v1/account/SwarmDebug/project/swarm/fork/eb11cba9-0fae-4998-a77b-f5afd326521f/simulate`;
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
  const resp = await axios.post(SIMULATE_API, transaction, opts);
  console.log('Added current deployer as ADMIN via simulated multisig wallet');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
