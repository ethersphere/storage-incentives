import { task } from 'hardhat/config';
import fs from 'fs';
import path from 'path';

interface ContractData {
  address: string;
  url: string;
  [key: string]: unknown;
}

task('contracts', 'Display contract deployment information')
  .addParam('target', 'Network type (main, test, local, pretestnet, tenderly)')
  .setAction(async (taskArgs: { target: string }) => {
    const networkType = taskArgs.target.toLowerCase();

    const validNetworks = ['main', 'test', 'local', 'pretestnet', 'tenderly'];
    if (!validNetworks.includes(networkType)) {
      throw new Error('Network parameter must be one of: ' + validNetworks.join(', '));
    }

    const fileNames = {
      main: 'mainnet_deployed.json',
      test: 'testnet_deployed.json',
      local: 'localhost_deployed.json',
      pretestnet: 'pretestnet_deployed.json',
      tenderly: 'tenderly_deployed.json',
    };

    const fileName = fileNames[networkType as keyof typeof fileNames];

    // Read JSON file
    const filePath = path.join(__dirname, '..', fileName);

    try {
      const fileContent = fs.readFileSync(filePath, 'utf8');
      const deploymentData = JSON.parse(fileContent);

      // Extract and display contract information
      console.log(`\nDeployed Contracts (${networkType})`);
      console.log('========================');

      Object.entries(deploymentData.contracts).forEach(([name, data]) => {
        const contractData = data as ContractData;
        console.log(`\n${name}:`);
        console.log(`Address: ${contractData.address}`);
        console.log(`Explorer: ${contractData.url}`);
      });
    } catch (error) {
      if (error instanceof Error) {
        console.error(`Error: Could not read or parse ${fileName}`);
        console.error(`Details: ${error.message}`);
      }
    }
  });
