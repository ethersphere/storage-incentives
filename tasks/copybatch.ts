import { task } from 'hardhat/config';

interface TaskArguments {
  owner: string;
  initialbalance: string;
  depth: string;
  bucketdepth: string;
  batchid: string;
  immutable: string;
  contract: string;
}

task('copy', 'Use copyBatch function from postageStamp contract')
  .addParam('owner', "The account's address")
  .addParam('initialbalance', "The account's address")
  .addParam('depth', "The account's address")
  .addParam('bucketdepth', "The account's address")
  .addParam('batchid', "The account's address")
  .addParam('immutable', "The account's address")
  .addParam('contract', 'Postage Stamp contract address')

  .setAction(async (taskArgs: TaskArguments, hre) => {
    const argsArray = Object.values(taskArgs);
    const currentPostage: string = argsArray.pop();

    const stamp = await hre.ethers.getContractAt('PostageStamp', currentPostage);

    // Step 1: Estimate Gas
    const estimatedGasLimit = await stamp.estimateGas.copyBatch(...argsArray);

    // Step 2: Add a buffer to the estimated gas (e.g., 20% buffer)
    const bufferPercent = 20;
    const bufferedGasLimit = estimatedGasLimit.add(estimatedGasLimit.mul(bufferPercent).div(100));

    // Adjusting txOptions with the new buffered gas limit
    const bufferedTxOptions = {
      gasLimit: bufferedGasLimit,
    };

    // Step 3: Execute the transaction with the buffered gas limit
    const tx = await stamp.copyBatch(...argsArray, bufferedTxOptions);

    console.log('Created new CopyBatch at : ', tx.hash);
  });
