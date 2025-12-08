import { ethers } from "hardhat";
import { PostageStampLegacy, PostageStampStorage, PostageStamp } from "../../typechain-types";

/**
 * Migration script to move from monolithic PostageStamp contract (legacy)
 * to the decoupled PostageStampStorage + PostageStamp architecture
 * 
 * WARNING: This script should be run during a maintenance window with the old contract paused
 * 
 * Steps:
 * 1. Deploy new PostageStampStorage and PostageStamp contracts
 * 2. Pause the old PostageStamp contract (legacy)
 * 3. Export all batch data from old contract
 * 4. Import all batch data to new storage contract
 * 5. Transfer all BZZ tokens to new storage contract
 * 6. Verify migration success
 * 7. Tag deployment in git
 * 8. Update node configurations to use new PostageStamp address
 */

interface BatchData {
  batchId: string;
  owner: string;
  depth: number;
  bucketDepth: number;
  immutableFlag: boolean;
  normalisedBalance: string;
  lastUpdatedBlockNumber: string;
}

async function main() {
  const [deployer, admin] = await ethers.getSigners();
  
  console.log("=== PostageStamp Storage Decoupling Migration ===\n");
  console.log("Deployer:", deployer.address);
  console.log("Admin:", admin.address);

  // Configuration - UPDATE THESE ADDRESSES
  const OLD_POSTAGE_STAMP_ADDRESS = process.env.OLD_POSTAGE_STAMP || "";
  const BZZ_TOKEN_ADDRESS = process.env.BZZ_TOKEN || "";
  
  if (!OLD_POSTAGE_STAMP_ADDRESS || !BZZ_TOKEN_ADDRESS) {
    throw new Error("Please set OLD_POSTAGE_STAMP and BZZ_TOKEN environment variables");
  }

  console.log("\nOld PostageStamp:", OLD_POSTAGE_STAMP_ADDRESS);
  console.log("BZZ Token:", BZZ_TOKEN_ADDRESS);

  // Get old contract
  const oldPostageStamp = await ethers.getContractAt("PostageStampLegacy", OLD_POSTAGE_STAMP_ADDRESS) as PostageStampLegacy;

  // Step 1: Pause old contract
  console.log("\n--- Step 1: Pausing old contract ---");
  try {
    const isPaused = await oldPostageStamp.paused();
    if (!isPaused) {
      const tx = await oldPostageStamp.pause();
      await tx.wait();
      console.log("✓ Old contract paused");
    } else {
      console.log("✓ Old contract already paused");
    }
  } catch (error) {
    console.error("Failed to pause old contract:", error);
    throw error;
  }

  // Step 2: Deploy new contracts
  console.log("\n--- Step 2: Deploying new contracts ---");
  
  const PostageStampStorageFactory = await ethers.getContractFactory("PostageStampStorage");
  const storageContract = await PostageStampStorageFactory.deploy(
    BZZ_TOKEN_ADDRESS,
    deployer.address, // Temporary logic address
    admin.address
  ) as PostageStampStorage;
  await storageContract.deployed();
  console.log("✓ PostageStampStorage deployed at:", storageContract.address);

  const minimumBucketDepth = await oldPostageStamp.minimumBucketDepth();
  const minimumValidityBlocks = await oldPostageStamp.minimumValidityBlocks();

  const PostageStampFactory = await ethers.getContractFactory("PostageStamp");
  const logicContract = await PostageStampFactory.deploy(
    storageContract.address,
    minimumBucketDepth,
    minimumValidityBlocks
  ) as PostageStamp;
  await logicContract.deployed();
  console.log("✓ PostageStamp deployed at:", logicContract.address);

  // Update storage to point to logic contract
  const updateTx = await storageContract.connect(admin).updateLogicContract(logicContract.address);
  await updateTx.wait();
  console.log("✓ Storage contract updated to use logic contract");

  // Step 3: Export batch data from old contract
  console.log("\n--- Step 3: Exporting batch data ---");
  
  // Note: This requires off-chain indexing or events to know all batch IDs
  // For this example, we'll assume batch IDs are stored in a file or database
  const batchIds = await loadBatchIds(); // Implement this based on your data source
  
  console.log(`Found ${batchIds.length} batches to migrate`);

  const batches: BatchData[] = [];
  for (const batchId of batchIds) {
    try {
      const batch = await oldPostageStamp.batches(batchId);
      if (batch.owner !== ethers.constants.AddressZero) {
        batches.push({
          batchId,
          owner: batch.owner,
          depth: batch.depth,
          bucketDepth: batch.bucketDepth,
          immutableFlag: batch.immutableFlag,
          normalisedBalance: batch.normalisedBalance.toString(),
          lastUpdatedBlockNumber: batch.lastUpdatedBlockNumber.toString(),
        });
      }
    } catch (error) {
      console.warn(`Warning: Could not read batch ${batchId}:`, error);
    }
  }

  console.log(`✓ Exported ${batches.length} active batches`);

  // Step 4: Export global state
  console.log("\n--- Step 4: Exporting global state ---");
  
  const validChunkCount = await oldPostageStamp.validChunkCount();
  const pot = await oldPostageStamp.pot();
  const lastExpiryBalance = await oldPostageStamp.lastExpiryBalance();
  const lastPrice = await oldPostageStamp.lastPrice();
  const lastUpdatedBlock = await oldPostageStamp.lastUpdatedBlock();
  const totalOutPayment = await oldPostageStamp.currentTotalOutPayment();

  console.log("Global state:");
  console.log("  validChunkCount:", validChunkCount.toString());
  console.log("  pot:", ethers.utils.formatEther(pot));
  console.log("  lastPrice:", lastPrice.toString());

  // Step 5: Transfer BZZ tokens
  console.log("\n--- Step 5: Transferring BZZ tokens ---");
  
  const bzzToken = await ethers.getContractAt("ERC20", BZZ_TOKEN_ADDRESS);
  const oldContractBalance = await bzzToken.balanceOf(OLD_POSTAGE_STAMP_ADDRESS);
  
  console.log("Old contract BZZ balance:", ethers.utils.formatEther(oldContractBalance));
  
  // Note: This requires a special function in the old contract to transfer tokens out
  // If not available, this needs to be done by the contract owner with appropriate permissions
  // For this script, we assume tokens are transferred separately or via admin function
  
  console.log("⚠️  Please manually transfer", ethers.utils.formatEther(oldContractBalance), "BZZ tokens");
  console.log("    From:", OLD_POSTAGE_STAMP_ADDRESS);
  console.log("    To:", storageContract.address);

  // Wait for user confirmation
  console.log("\nPress Ctrl+C to cancel or wait for manual token transfer...");
  await waitForTokenTransfer(bzzToken, storageContract.address, oldContractBalance);

  // Step 6: Import batches to new storage
  console.log("\n--- Step 6: Importing batches to new storage ---");
  
  let importedCount = 0;
  const batchSize = 50; // Import in chunks to avoid gas limits
  
  for (let i = 0; i < batches.length; i += batchSize) {
    const chunk = batches.slice(i, Math.min(i + batchSize, batches.length));
    console.log(`Importing batches ${i + 1} to ${i + chunk.length}...`);
    
    for (const batch of chunk) {
      try {
        const batchStruct = {
          owner: batch.owner,
          depth: batch.depth,
          bucketDepth: batch.bucketDepth,
          immutableFlag: batch.immutableFlag,
          normalisedBalance: batch.normalisedBalance,
          lastUpdatedBlockNumber: batch.lastUpdatedBlockNumber,
        };

        // Store batch
        const storeTx = await storageContract.storeBatch(batch.batchId, batchStruct);
        await storeTx.wait();

        // Insert into tree
        const insertTx = await storageContract.treeInsert(batch.batchId, batch.normalisedBalance);
        await insertTx.wait();

        importedCount++;
      } catch (error) {
        console.error(`Failed to import batch ${batch.batchId}:`, error);
      }
    }
  }

  console.log(`✓ Imported ${importedCount} batches`);

  // Step 7: Set global state
  console.log("\n--- Step 7: Setting global state ---");
  
  await (await storageContract.setTotalOutPayment(totalOutPayment)).wait();
  await (await storageContract.setValidChunkCount(validChunkCount)).wait();
  await (await storageContract.setPot(pot)).wait();
  await (await storageContract.setLastExpiryBalance(lastExpiryBalance)).wait();
  await (await storageContract.setLastPrice(lastPrice)).wait();
  await (await storageContract.setLastUpdatedBlock(lastUpdatedBlock)).wait();
  
  console.log("✓ Global state set");

  // Step 8: Setup roles on new logic contract
  console.log("\n--- Step 8: Setting up roles ---");
  
  const PRICE_ORACLE_ROLE = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("PRICE_ORACLE_ROLE"));
  const PAUSER_ROLE = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("PAUSER_ROLE"));
  const REDISTRIBUTOR_ROLE = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("REDISTRIBUTOR_ROLE"));

  // Copy role members from old contract (if needed)
  // This is simplified - adjust based on your needs
  console.log("⚠️  Please manually grant roles on new PostageStamp:");
  console.log("   PRICE_ORACLE_ROLE, PAUSER_ROLE, REDISTRIBUTOR_ROLE");

  // Step 9: Verification
  console.log("\n--- Step 9: Verification ---");
  
  const newValidChunkCount = await storageContract.getValidChunkCount();
  const newPot = await storageContract.getPot();
  const newBalance = await bzzToken.balanceOf(storageContract.address);
  
  console.log("Verification:");
  console.log("  Expected BZZ balance:", ethers.utils.formatEther(oldContractBalance));
  console.log("  Actual BZZ balance:", ethers.utils.formatEther(newBalance));
  console.log("  Expected batches:", batches.length);
  console.log("  Imported batches:", importedCount);
  console.log("  Valid chunk count:", newValidChunkCount.toString(), "==", validChunkCount.toString());
  console.log("  Pot:", ethers.utils.formatEther(newPot), "==", ethers.utils.formatEther(pot));

  const success = 
    newBalance.eq(oldContractBalance) &&
    importedCount === batches.length &&
    newValidChunkCount.eq(validChunkCount) &&
    newPot.eq(pot);

  if (success) {
    console.log("\n✅ Migration completed successfully!");
  } else {
    console.log("\n⚠️  Migration completed with warnings - please review");
  }

  console.log("\n=== Migration Summary ===");
  console.log("Old PostageStamp (legacy):", OLD_POSTAGE_STAMP_ADDRESS, "(PAUSED)");
  console.log("New PostageStampStorage:", storageContract.address);
  console.log("New PostageStamp:", logicContract.address);
  console.log("\n📝 Next steps:");
  console.log("1. Tag this deployment: git tag -a v2.0.0 -m 'Migration to storage decoupling'");
  console.log("2. Update all Swarm node configurations to use:", logicContract.address);
  console.log("3. Update documentation and announcements");
  console.log("4. Monitor the new contracts for any issues");
  console.log("5. Keep the old contract paused for reference");
}

/**
 * Load batch IDs from external source
 * This should be implemented based on your data source (events, database, etc.)
 */
async function loadBatchIds(): Promise<string[]> {
  // Option 1: Load from file
  // const fs = require('fs');
  // const data = JSON.parse(fs.readFileSync('./migration/batch-ids.json', 'utf8'));
  // return data.batchIds;

  // Option 2: Query from events
  // const oldPostageStamp = await ethers.getContractAt("PostageStamp", OLD_POSTAGE_STAMP_ADDRESS);
  // const filter = oldPostageStamp.filters.BatchCreated();
  // const events = await oldPostageStamp.queryFilter(filter);
  // return events.map(e => e.args.batchId);

  // Option 3: Load from database/indexer
  // return await fetchBatchIdsFromDatabase();

  // For this example, return empty array
  console.log("⚠️  Please implement loadBatchIds() to fetch actual batch IDs");
  return [];
}

/**
 * Wait for token transfer to complete
 */
async function waitForTokenTransfer(
  token: any,
  targetAddress: string,
  expectedAmount: any
): Promise<void> {
  let attempts = 0;
  const maxAttempts = 60; // 5 minutes with 5-second intervals

  while (attempts < maxAttempts) {
    const balance = await token.balanceOf(targetAddress);
    if (balance.gte(expectedAmount)) {
      console.log("✓ Token transfer confirmed");
      return;
    }
    
    await new Promise(resolve => setTimeout(resolve, 5000));
    attempts++;
    
    if (attempts % 6 === 0) {
      console.log(`Still waiting for token transfer... (${attempts * 5}s elapsed)`);
    }
  }
  
  throw new Error("Timeout waiting for token transfer");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
