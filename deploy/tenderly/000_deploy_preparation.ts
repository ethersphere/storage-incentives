import { DeployFunction } from 'hardhat-deploy/types';
import { networkConfig } from '../../helper-hardhat-config';

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

const func: DeployFunction = async function ({ deployments, getNamedAccounts, ethers, network }) {
  const { log, get, read, execute } = deployments;
  const { deployer } = await getNamedAccounts();
  let token = null;

  // We ONLY use already deployed token for MAINNET FORKS
  if (!(token = await get('Token'))) {
    // we have problem as there is not token, error out
  } else {
    log('Using already deployed token at', token.address);
  }

  log('----------------------------------------------------');

  // Do preparation for Tenderly
  if (network.name == 'tenderly') {
    log('Funding deployment wallets');

    const namedAccounts = await getNamedAccounts();
    const deployer = namedAccounts.deployer;
    const WALLETS = [deployer];
    const multiSig: string | undefined = networkConfig[network.name].multisig;

    const result = await ethers.provider.send('tenderly_setBalance', [
      WALLETS,
      //amount in wei will be set for all wallets
      ethers.utils.hexValue(ethers.utils.parseUnits('10', 'ether').toHexString()),
    ]);

    // Add missing role for Staking so deployer can set roles to new contracts
    // On Tenderly we can set any FROM it will work
    // const adminRole = await read('StakeRegistry', 'DEFAULT_ADMIN_ROLE');
    // await execute('StakeRegistry', { from: multiSig }, 'grantRole', adminRole, deployer);

    log('Funded wallet(s)', ...WALLETS);
    // Remove previous deployment so we start fresh for contracts that will be deployed, modify them per case
    await deleteFiles(filesToDelete);
    await deleteDirectory(directoryToDelete);
  }
};

export default func;
func.tags = ['token', 'contracts'];
