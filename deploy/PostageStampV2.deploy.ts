import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

/**
 * Deployment script for PostageStamp Storage Decoupling Architecture
 * 
 * This script deploys:
 * 1. PostageStampStorage (immutable storage contract)
 * 2. PostageStampV2 (upgradeable logic contract)
 * 
 * For new deployments (not migrating from existing PostageStamp)
 */
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, ethers } = hre;
  const { deploy, execute, read } = deployments;
  const { deployer, admin, priceOracle, redistributor, pauser } = await getNamedAccounts();

  console.log("Deploying PostageStamp Storage Decoupling Architecture...");
  console.log("Deployer:", deployer);
  console.log("Admin:", admin);

  // Get BZZ token address from previous deployment or config
  const bzzToken = await deployments.get("TestToken");
  console.log("BZZ Token:", bzzToken.address);

  // Configuration parameters
  const minimumBucketDepth = 16; // Adjust as needed
  const minimumValidityBlocks = 17280; // ~24 hours

  // Step 1: Deploy PostageStampStorage
  console.log("\n--- Deploying PostageStampStorage ---");
  
  // Deploy with a temporary logic address (will update after PostageStampV2 is deployed)
  const tempLogicAddress = deployer; // Temporary, will be updated
  
  const storageDeployment = await deploy("PostageStampStorage", {
    from: deployer,
    args: [
      bzzToken.address,
      tempLogicAddress, // Temporary logic contract address
      admin || deployer, // Admin who can update logic contract
    ],
    log: true,
    autoMine: true,
  });

  console.log("PostageStampStorage deployed at:", storageDeployment.address);

  // Step 2: Deploy PostageStampV2
  console.log("\n--- Deploying PostageStampV2 ---");
  
  const logicDeployment = await deploy("PostageStampV2", {
    from: deployer,
    args: [
      storageDeployment.address,
      minimumBucketDepth,
      minimumValidityBlocks,
    ],
    log: true,
    autoMine: true,
  });

  console.log("PostageStampV2 deployed at:", logicDeployment.address);

  // Step 3: Update storage contract to point to the real logic contract
  console.log("\n--- Updating Logic Contract Address in Storage ---");
  
  const currentLogicAddress = await read("PostageStampStorage", "logicContract");
  
  if (currentLogicAddress.toLowerCase() !== logicDeployment.address.toLowerCase()) {
    await execute(
      "PostageStampStorage",
      { from: admin || deployer, log: true },
      "updateLogicContract",
      logicDeployment.address
    );
    console.log("Logic contract updated to:", logicDeployment.address);
  } else {
    console.log("Logic contract already set correctly");
  }

  // Step 4: Setup roles on PostageStampV2
  console.log("\n--- Setting up Roles on PostageStampV2 ---");

  const PRICE_ORACLE_ROLE = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("PRICE_ORACLE_ROLE"));
  const PAUSER_ROLE = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("PAUSER_ROLE"));
  const REDISTRIBUTOR_ROLE = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("REDISTRIBUTOR_ROLE"));

  // Grant PRICE_ORACLE_ROLE
  if (priceOracle) {
    const hasPriceOracleRole = await read("PostageStampV2", "hasRole", PRICE_ORACLE_ROLE, priceOracle);
    if (!hasPriceOracleRole) {
      await execute(
        "PostageStampV2",
        { from: deployer, log: true },
        "grantRole",
        PRICE_ORACLE_ROLE,
        priceOracle
      );
      console.log("Granted PRICE_ORACLE_ROLE to:", priceOracle);
    }
  }

  // Grant REDISTRIBUTOR_ROLE
  if (redistributor) {
    const hasRedistributorRole = await read("PostageStampV2", "hasRole", REDISTRIBUTOR_ROLE, redistributor);
    if (!hasRedistributorRole) {
      await execute(
        "PostageStampV2",
        { from: deployer, log: true },
        "grantRole",
        REDISTRIBUTOR_ROLE,
        redistributor
      );
      console.log("Granted REDISTRIBUTOR_ROLE to:", redistributor);
    }
  }

  // Grant PAUSER_ROLE
  if (pauser) {
    const hasPauserRole = await read("PostageStampV2", "hasRole", PAUSER_ROLE, pauser);
    if (!hasPauserRole) {
      await execute(
        "PostageStampV2",
        { from: deployer, log: true },
        "grantRole",
        PAUSER_ROLE,
        pauser
      );
      console.log("Granted PAUSER_ROLE to:", pauser);
    }
  }

  // Step 5: Verification and Summary
  console.log("\n=== Deployment Complete ===");
  console.log("PostageStampStorage:", storageDeployment.address);
  console.log("PostageStampV2:", logicDeployment.address);
  console.log("BZZ Token:", bzzToken.address);
  console.log("\nNext steps:");
  console.log("1. Verify contracts on block explorer");
  console.log("2. Update Swarm node configurations to use PostageStampV2 address");
  console.log("3. Test batch creation, topup, and other operations");
  console.log("4. When upgrading in the future, deploy new logic contract and call:");
  console.log(`   PostageStampStorage.updateLogicContract(newLogicAddress)`);

  return true;
};

func.tags = ["PostageStampV2", "StorageDecoupling"];
func.dependencies = ["TestToken"]; // or "Token" for mainnet

export default func;
