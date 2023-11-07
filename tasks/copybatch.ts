import { task } from 'hardhat/config';

task('copy', 'Use copyBatch function from postageStamp contract')
  .addParam('owner', "The account's address")
  .addParam('initialbalance', "The account's address")
  .addParam('depth', "The account's address")
  .addParam('bucketdepth', "The account's address")
  .addParam('batchid', "The account's address")
  .addParam('immutable', "The account's address")
  .addParam('contract', 'Postage Stamp contract address')

  .setAction(async (taskArgs: any, hre) => {
    const argsArray = Object.values(taskArgs);
    console.log(argsArray);

    if (typeof argsArray[4] === 'string' && !argsArray[4].startsWith('0x')) {
      argsArray[4] = '0x' + argsArray[4];
    }

    const currentPostage: any = argsArray.pop();

    const stamp = await hre.ethers.getContractAt('PostageStamp', currentPostage);
    const tx = await stamp.copyBatch(...argsArray);

    console.log('Created new CopyBatch at : ', tx.hash);
  });
