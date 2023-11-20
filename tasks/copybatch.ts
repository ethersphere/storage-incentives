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
    const tx = await stamp.copyBatch(...argsArray);

    console.log('Created new CopyBatch at : ', tx.hash);
  });
