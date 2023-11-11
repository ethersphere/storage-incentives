import { DeployFunction } from 'hardhat-deploy/types';
import { networkConfig } from '../../helper-hardhat-config';

import { unlink, rm } from 'fs';
import { promisify } from 'util';

const axios = require('axios');
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

const func: DeployFunction = async function ({ deployments, getNamedAccounts, ethers, network }) {
  const { log, get, read, execute } = deployments;
  const { deployer } = await getNamedAccounts();
  let token = null;

  // Remove previous deployment so we start fresh for contracts that will be deployed, modify them per case
  await deleteFiles(filesToDelete);
  await deleteDirectory(directoryToDelete);

  // Do preparation for FRESH Tenderly deployment
  log('Funding deployment wallets');

  const WALLETS = [deployer, networkConfig['mainnet'].multisig];
  const multiSig: string | undefined = networkConfig[network.name].multisig;

  const result = await ethers.provider.send('tenderly_setBalance', [
    WALLETS,
    // Amount in wei will be set for all wallets
    ethers.utils.hexValue(ethers.utils.parseUnits('10', 'ether').toHexString()),
  ]);

  // Add missing role for Staking so deployer can set roles to new contracts
  // On Tenderly we can set any FROM it will work
  // const staking = await get('StakeRegistry');
  // const SIMULATE_API = `https://api.tenderly.co/api/v1/account/SwarmDebug/project/swarm/fork/eb11cba9-0fae-4998-a77b-f5afd326521f/simulate`;
  // // Transaction details
  // const transaction = {
  //   network_id: '100',
  //   from: networkConfig['mainnet'].multisig,
  //   to: staking.address,
  //   input:
  //     '0x2f2ff15d0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000b1c7f17ed88189abf269bf68a3b2ed83c5276aae',
  //   save: true,
  // };

  // const opts = {
  //   headers: {
  //     'X-Access-Key': process.env.TENDERLY_ACCESS_KEY || '',
  //   },
  // };
  // const resp = await axios.post(SIMULATE_API, transaction, opts);
  // console.log('Added current deployer as ADMIN via simulated multisig wallet');

  log('Funded wallet(s)', ...WALLETS);

  // We ONLY use already deployed token for MAINNET FORKS
  if (!(token = await get('Token'))) {
    // we have problem as there is not token, error out
  } else {
    log('Using already deployed Token at', token.address);
  }

  log('----------------------------------------------------');
};

export default func;
func.tags = ['token', 'preparation'];
