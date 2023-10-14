import { task } from 'hardhat/config';

task('sigs', 'Generate ABI signatures for errors and functions')
  .addParam('c', 'Name of the contract for which to generate ABI data')
  .setAction(async (taskArgs: any, { ethers }) => {
    // Load the contract ABI based on the contract name
    const ABI = (await import(`../artifacts/src/${taskArgs.c}.sol/${taskArgs.c}.json`)).abi;

    const prepareData = (e: { name: string; inputs: { type: string }[] }) =>
      `${e.name}(${e.inputs.map((param) => param.type)})`;
    const encodeSelector = (f: string) => ethers.utils.id(f).slice(0, 10);

    // Parse ABI
    const output = ABI.filter((e: any) => ['function', 'error'].includes(e.type)).flatMap(
      (e: any) => `${encodeSelector(prepareData(e))}: ${prepareData(e)}`
    );

    console.log(output);
  });
