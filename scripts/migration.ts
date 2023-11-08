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
  const batchesData = JSON.parse(fs.readFileSync('./migration/batches.json', 'utf8'));
  const batches: Batch[] = batchesData.batches;

  // Group the batches into chunks of 10
  const chunkSize = 500;
  const batchGroups: Batch[][] = chunkArray(batches, chunkSize);

  // Assuming you have the contract deployed and have its address
  const contractAddress = '0x3a235fd10563fdd954c3199c08f4da132284287d';

  const contract = await ethers.getContractAt('PostageStamp', contractAddress);

  // Iterate over the chunks and send them to the smart contract
  for (const group of batchGroups) {
    const batchStructs = group.map((batch) => ({
      batchId: batch.batchid,
      owner: batch.owner,
      depth: batch.depth,
      bucketDepth: batch.bucketDepth,
      immutableFlag: batch.immutable,
      remainingBalance: batch.remainingBalance,
    }));

    // Send the batch group to the smart contract
    const tx = await contract.copyBatchBulk(batchStructs);
    console.log(`Batches sent with transaction: ${tx.hash}`);
    await tx.wait();
  }
}

// Helper function to divide the array into chunks of a specific size
function chunkArray<T>(array: T[], size: number): T[][] {
  return array.reduce((acc: T[][], val: T, i: number) => {
    let idx = Math.floor(i / size);
    let page: T[] = acc[idx] || (acc[idx] = []);
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
