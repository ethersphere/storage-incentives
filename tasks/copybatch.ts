/**
 * Copy Batch Task - Use copyBatch function from PostageStamp contract
 *
 * Usage:
 *   npx hardhat copy \
 *     --owner 0x1234... \
 *     --initialbalance 1000000000000000000 \
 *     --depth 20 \
 *     --bucketdepth 16 \
 *     --batchid 0xabcd... \
 *     --immutable false \
 *     --contract 0x5678...
 *
 * Parameters:
 *   --owner: The account's address
 *   --initialbalance: Initial balance for the batch
 *   --depth: Batch depth
 *   --bucketdepth: Bucket depth
 *   --batchid: Batch ID
 *   --immutable: Whether batch is immutable (true/false)
 *   --contract: PostageStamp contract address
 *
 * This task:
 * - Estimates gas for the copyBatch transaction
 * - Adds 20% buffer to estimated gas
 * - Executes copyBatch with optimized gas settings
 */

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
