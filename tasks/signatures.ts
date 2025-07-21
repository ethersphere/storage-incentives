import { task } from 'hardhat/config';

interface TaskArgs {
  c: string;
  f?: string;
}

interface AbiItem {
  name: string;
  inputs: { type: string }[];
  type: string;
}

task('sigs', 'Generate ABI signatures for errors and functions')
  .addParam('c', 'Name of the contract for which to generate ABI data')
  .addOptionalParam('f', 'Name of Solidity file where contract is stored')
  .setAction(async (taskArgs: TaskArgs, { ethers }) => {
    // If 'f' is not defined, use the value of 'c' for it
    const fileName = taskArgs.f || taskArgs.c;

    try {
      // Load the contract ABI based on the contract name
      const ABI = (await import(`../artifacts/src/${fileName}.sol/${taskArgs.c}.json`)).abi;

      const prepareData = (e: { name: string; inputs: { type: string }[] }) =>
        `${e.name}(${e.inputs.map((param) => param.type)})`;
      const encodeSelector = (f: string) => ethers.utils.id(f).slice(0, 10);

      // Parse ABI - show only errors
      const output = ABI.filter((e: AbiItem) => ['error'].includes(e.type)).flatMap(
        (e: AbiItem) => `${encodeSelector(prepareData(e))}: ${prepareData(e)}`
      );

      if (output.length === 0) {
        console.log('No errors found in the contract ABI');
      } else {
        console.log('Error signatures:');
        output.forEach((sig: string) => console.log(sig));
      }
    } catch (error) {
      console.error(`Error loading contract ABI: ${error}`);
      console.log(`Expected path: artifacts/src/${fileName}.sol/${taskArgs.c}.json`);
    }
  });
