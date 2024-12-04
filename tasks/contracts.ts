import { task } from 'hardhat/config';
import fs from 'fs';
import path from 'path';

task('contracts', 'Display contract deployment information')
  .addParam('target', 'Network type (main or test)')
  .setAction(async (taskArgs: { target: string }) => {
    const networkType = taskArgs.target.toLowerCase();

    if (networkType !== 'main' && networkType !== 'test') {
      throw new Error('Network parameter must be either "main" or "test"');
    }

    const fileName = networkType === 'main' ? 'mainnet_deployed.json' : 'testnet_deployed.json';

    // Read JSON file
    const filePath = path.join(__dirname, '..', fileName);
    const fileContent = fs.readFileSync(filePath, 'utf8');
    const deploymentData = JSON.parse(fileContent);

    // Extract and display contract information
    console.log(`\nDeployed Contracts (${networkType})`);
    console.log('========================');

    Object.entries(deploymentData.contracts).forEach(([name, data]: [string, any]) => {
      console.log(`\n${name}:`);
      console.log(`Address: ${data.address}`);
      console.log(`Explorer: ${data.url}`);
    });
  });
