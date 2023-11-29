import { ethers } from 'hardhat';
import * as fs from 'fs';

interface Batch {
  batchid: string;
  owner: string;
  depth: number;
  bucketDepth: number;
  immutable: boolean;
  remainingBalance: number;
}

async function main() {
  // Read the JSON file with the batches
  const batchesData = JSON.parse(fs.readFileSync('./scripts/migration/batches.json', 'utf8'));
  const batches: Batch[] = batchesData.batches;

  // Group the batches into chunks
  // When using size of 80, each trx will use around 14M of gas
  // When using size of 90, each trx will use around 21M of gas
  // Block total gas limit is around 20M
  const chunkSize = 70;
  // Assuming you have the contract deployed and have its address
  const contractAddress = '0xAdD62a816B30c48F7323568A643c553B2d3bc1fF';
  const contract = await ethers.getContractAt('PostageStamp', contractAddress);

  // Add Admin Role to the contract address itself as it is calling itself with this.copyBatch function
  const adminRole = await contract.DEFAULT_ADMIN_ROLE();
  const tx0 = await contract.grantRole(adminRole, contractAddress);
  console.log('Added Admin Role to contract itself : ', tx0.hash);

  // A numerator to keep track of the batch group number
  let groupNumber = 0;
  const batchGroups: Batch[][] = chunkArray(batches, chunkSize);
  // Iterate over the chunks and send them to the smart contract
  for (const group of batchGroups) {
    groupNumber++; // Increment the group number for each batch group sent
    const batchStructs = group.map((batch) => ({
      batchId: batch.batchid,
      owner: batch.owner,
      depth: batch.depth,
      bucketDepth: batch.bucketDepth,
      immutableFlag: batch.immutable,
      remainingBalance: batch.remainingBalance,
    }));

    // Send the batch group to the smart contract
    // Step 1: Estimate Gas
    const estimatedGasLimit = await contract.estimateGas.copyBatchBulk(batchStructs);

    // Step 2: Add a buffer to the estimated gas (optional but recommended)
    const bufferedGasLimit = estimatedGasLimit.add(estimatedGasLimit.mul(20).div(100)); // Adding 20% buffer

    // Step 3: Send transaction with estimated gas limit
    const tx1 = await contract.copyBatchBulk(batchStructs, {
      gasLimit: bufferedGasLimit,
    });

    console.log(`Batch group #${groupNumber} sent with transaction: ${tx1.hash}`);
    await tx1.wait();
  }
}

// Helper function to divide the array into chunks of a specific size
function chunkArray<T>(array: T[], size: number): T[][] {
  return array.reduce((acc: T[][], val: T, i: number) => {
    const idx = Math.floor(i / size);
    const page: T[] = acc[idx] || (acc[idx] = []);
    page.push(val);
    return acc;
  }, []);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
