// This is SCRIPT for MIGRATION of Stamps, it fetches created contracts from BatchCreated EVENT

const hre = require("hardhat");
const fs = require("fs/promises");
const { ethers } = require("hardhat");

// Function to decode transaction input data
async function decodeTransactionInput(transactionHash, provider) {
  try {
    // Get the transaction
    const transaction = await provider.getTransaction(transactionHash);
    if (!transaction) {
      console.log("Transaction not found!");
      return null;
    }

    const contractABI = await require("../../artifacts/src/PostageStamp.sol/PostageStamp.json");

    // Create an interface from the ABI to decode the data
    const contractInterface = new ethers.utils.Interface(contractABI.abi);

    // Decode the transaction input data
    const decodedInput = contractInterface.parseTransaction({
      data: transaction.data,
    });

    // TODO create additional transaction to get remainingBalance
    // Transform decoded data to the desired format
    let batches = decodedInput.args.map(batch => {
      return {
        batchid: batch[0],
        owner: batch[3],
        depth: parseInt(batch[4]),
        bucketDepth: parseInt(batch[5]),
        immutable: batch[6],
        remainingBalance: parseInt(batch[2])
      };
    });

    return { batches };
  } catch (error) {
    console.error("Error decoding transaction input:", error);
    return null;
  }
}


// Custom replacer function to handle BigInt serialization
function replacer(key, value) {
  if (typeof value === "bigint") {
    return value.toString();
  }
  return value;
}

async function main() {
  const provider = ethers.provider;

  // Specify the starting block
  const startBlock = 25527076; // Replace with the block number from where you want to start

  const contractAddress = "0x30d155478eF27Ab32A1D578BE7b84BC5988aF381";
  const myContract = await ethers.getContractAt(
    "PostageStamp",
    contractAddress
  );

  // Prepare to store the decoded data
  let decodedDataArray = [];

  // Define batch size and delay (in milliseconds)
  const batchSize = 10000; // Adjust based on your needs
  const delay = 20; // Delay of 0.02 seconds

  // Get the latest block number
  const latestBlock = await provider.getBlockNumber();

  for (
    let currentBlock = startBlock;
    currentBlock < latestBlock;
    currentBlock += batchSize
  ) {
    // Calculate the end block for the current batch
    const endBlock = Math.min(currentBlock + batchSize - 1, latestBlock);

    // Query events in the current batch
    const events = await myContract.queryFilter(
      "BatchCreated",
      currentBlock,
      endBlock
    );
    for (let event of events) {
      const decodedData = await decodeTransactionInput(
        event.transactionHash,
        provider
      );
      if (decodedData) {
        decodedDataArray.push(decodedData);
      }
    }

    // Log completion of the current batch
    console.log(`Completed querying blocks ${currentBlock} to ${endBlock}`);

    // Wait for a specified delay before the next batch
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  // Save the decoded data array to a JSON file
  try {
    await fs.writeFile(
      "scripts/migration/decodedData.json",
      JSON.stringify(decodedDataArray, replacer, 2)
    );
    console.log("Successfully wrote decoded data to decodedData.json");
  } catch (err) {
    console.error("Error writing file:", err);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
