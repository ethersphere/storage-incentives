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
  mainnet: 'https://etherscan.io/address/',
  sepolia: 'https://sepolia.etherscan.io/address/',
};

task('deployments', 'Display deployed contracts in copy-paste friendly format').setAction(async () => {
  try {
    const deployments: { [networkName: string]: NetworkDeployment } = {};
    
    // Read deployment files
    try {
      deployments['mainnet'] = JSON.parse(
        fs.readFileSync(path.join(__dirname, '..', 'mainnet_deployed.json'), 'utf8')
      );
    } catch {}

    try {
      deployments['testnet'] = JSON.parse(
        fs.readFileSync(path.join(__dirname, '..', 'testnet_deployed.json'), 'utf8')
      );
    } catch {}

    if (Object.keys(deployments).length === 0) {
      console.log('No deployment files found.');
      return;
    }

    Object.entries(deployments).forEach(([networkKey, deployment]) => {
      const networkName = networkKey === 'mainnet' ? 'Mainnet' : 'Testnet (Sepolia)';
      const explorerUrl = networkKey === 'mainnet' ? ETHERSCAN_URLS.mainnet : ETHERSCAN_URLS.sepolia;
      
      console.log(`\n${networkName}:`);
      
      const contracts = deployment.contracts;
      if (Object.keys(contracts).length === 0) {
        console.log('No contracts deployed');
        return;
      }

      Object.entries(contracts).forEach(([name, contract]) => {
        console.log(`${name}: ${contract.address}`);
        console.log(`Explorer: ${explorerUrl}${contract.address}`);
        console.log('');
      });
    });

  } catch (error) {
    console.error('Error reading deployments:', error);
  }
});
