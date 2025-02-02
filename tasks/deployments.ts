import { task } from 'hardhat/config';
import fs from 'fs';
import path from 'path';

interface Contract {
  address: string;
  url?: string;
}

interface NetworkDeployment {
  chainId: number;
  contracts: {
    [key: string]: Contract;
  };
}

const ETHERSCAN_URLS = {
  mainnet: 'https://gnosisscan.io/address/',
  sepolia: 'https://sepolia.etherscan.io/address/',
};

task('deployments', 'Display Etherscan links for deployed contracts').setAction(async () => {
  try {
    // Read deployment files
    const mainnetData: NetworkDeployment = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'mainnet_deployed.json'), 'utf8')
    );
    const testnetData: NetworkDeployment = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'testnet_deployed.json'), 'utf8')
    );

    // Get contracts that exist in both deployments
    const commonContracts = Object.keys(mainnetData.contracts).filter(
      (contractName) => testnetData.contracts[contractName]
    );

    if (commonContracts.length === 0) {
      console.log('\nNo contracts found deployed on both networks.');
      return;
    }

    console.log('\nContracts deployed on both networks:');
    console.log('=====================================');

    commonContracts.forEach((contractName) => {
      const mainnetContract = mainnetData.contracts[contractName];
      const testnetContract = testnetData.contracts[contractName];

      console.log(`\n${contractName}:`);
      console.log('Mainnet:');
      console.log(`  Address: ${mainnetContract.address}`);
      console.log(`  Explorer: ${ETHERSCAN_URLS.mainnet}${mainnetContract.address}`);

      console.log('\nTestnet (Sepolia):');
      console.log(`  Address: ${testnetContract.address}`);
      console.log(`  Explorer: ${ETHERSCAN_URLS.sepolia}${testnetContract.address}`);
    });

    console.log(`\nTotal contracts found: ${commonContracts.length}`);
  } catch (error) {
    if (error instanceof Error) {
      console.error('\nError scanning deployments:');
      console.error(error.message);
    }
  }
});
