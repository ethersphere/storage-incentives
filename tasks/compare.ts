import { task } from 'hardhat/config';
import fs from 'fs';
import path from 'path';

interface NetworkDeployment {
  chainId: number;
  contracts: {
    [key: string]: {
      bytecode: string;
      address: string;
    };
  };
}

task('compare', 'Compare bytecodes between two deployments')
  .addParam('source', 'Source network (main, test, local, pretestnet, tenderly)')
  .addParam('target', 'Target network to compare against')
  .setAction(async (taskArgs: { source: string; target: string }) => {
    const sourceType = taskArgs.source.toLowerCase();
    const targetType = taskArgs.target.toLowerCase();

    const validNetworks = ['main', 'test', 'local', 'pretestnet', 'tenderly'];
    if (!validNetworks.includes(sourceType) || !validNetworks.includes(targetType)) {
      throw new Error('Network parameters must be one of: ' + validNetworks.join(', '));
    }

    const fileNames = {
      main: 'mainnet_deployed.json',
      test: 'testnet_deployed.json',
      local: 'localhost_deployed.json',
      pretestnet: 'pretestnet_deployed.json',
      tenderly: 'tenderly_deployed.json',
    };

    const sourceFile = fileNames[sourceType as keyof typeof fileNames];
    const targetFile = fileNames[targetType as keyof typeof fileNames];

    try {
      // Read deployment files
      const sourceData: NetworkDeployment = JSON.parse(fs.readFileSync(path.join(__dirname, '..', sourceFile), 'utf8'));
      const targetData: NetworkDeployment = JSON.parse(fs.readFileSync(path.join(__dirname, '..', targetFile), 'utf8'));

      console.log(`\nComparing bytecodes between ${sourceType} and ${targetType}`);
      console.log('=============================================');

      // Compare bytecodes for each contract
      Object.keys(sourceData.contracts).forEach((contractName) => {
        if (targetData.contracts[contractName]) {
          const sourceBytecode = sourceData.contracts[contractName].bytecode;
          const targetBytecode = targetData.contracts[contractName].bytecode;

          console.log(`\nContract: ${contractName}`);

          if (sourceBytecode === targetBytecode) {
            console.log('Bytecodes are identical');
          } else {
            // Find the first differing character position
            let firstDiff = -1;
            for (let i = 0; i < Math.max(sourceBytecode.length, targetBytecode.length); i++) {
              if (sourceBytecode[i] !== targetBytecode[i]) {
                firstDiff = i;
                break;
              }
            }

            console.log(`Bytecodes differ at position: ${firstDiff}`);
            if (firstDiff !== -1) {
              // Show a snippet around the difference
              const start = Math.max(0, firstDiff - 10);
              const end = firstDiff + 10;

              console.log('\nSource bytecode snippet:');
              console.log(sourceBytecode.slice(start, end));
              console.log('                    ^');
              console.log('Target bytecode snippet:');
              console.log(targetBytecode.slice(start, end));
              console.log('                    ^');
            }

            console.log(`\nSource length: ${sourceBytecode.length}`);
            console.log(`Target length: ${targetBytecode.length}`);
          }
        } else {
          console.log(`\nContract ${contractName} not found in ${targetType} deployment`);
        }
      });
    } catch (error) {
      if (error instanceof Error) {
        console.error('Error comparing bytecodes:');
        console.error(error.message);
      }
    }
  });
