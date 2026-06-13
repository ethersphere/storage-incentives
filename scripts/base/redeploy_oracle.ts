/**
 * One-shot Base migration: redeploy PriceOracle + Redistribution and rewire roles.
 *
 * Why both contracts:
 * - Redistribution.OracleContract is set in the constructor (no setter).
 * - Fresh PriceOracle resets lastAdjustedRound to currentRound(), unblocking claims.
 *
 * StakeRegistry still points at the old oracle for currentPrice() reads.
 * Until StakeRegistry is upgraded, keep the old oracle price in sync via setPrice()
 * whenever the new oracle adjusts (same admin can call both).
 *
 * Usage:
 *   DRY_RUN=true  npx hardhat run scripts/base/redeploy_oracle.ts --network base
 *   npx hardhat run scripts/base/redeploy_oracle.ts --network base
 */

import { ethers, deployments, network } from 'hardhat';
import { networkConfig } from '../../helper-hardhat-config';
import type { Contract } from 'ethers';

const DRY_RUN = process.env.DRY_RUN === 'true';

interface Addresses {
  oldOracle: string;
  oldRedis: string;
  postage: string;
  staking: string;
}

async function loadAddresses(): Promise<Addresses> {
  const oldOracle = (await deployments.get('PriceOracle')).address;
  const oldRedis = (await deployments.get('Redistribution')).address;
  const postage = (await deployments.get('PostageStamp')).address;
  const staking = (await deployments.get('StakeRegistry')).address;
  return { oldOracle, oldRedis, postage, staking };
}

async function saveDeployment(name: string, contract: Contract, args: unknown[] = []) {
  const artifact = await deployments.getArtifact(name);
  const receipt = contract.deployTransaction
    ? await contract.deployTransaction.wait(networkConfig[network.name]?.blockConfirmations || 6)
    : undefined;

  await deployments.save(name, {
    address: contract.address,
    abi: artifact.abi,
    args,
    transactionHash: contract.deployTransaction?.hash,
    receipt,
  });
}

async function main() {
  if (network.name !== 'base') {
    throw new Error(`This script is intended for the base network, got: ${network.name}`);
  }

  const [deployer] = await ethers.getSigners();
  const { oldOracle, oldRedis, postage, staking } = await loadAddresses();
  const roundLength = networkConfig.base.roundLength || 380;

  const oldOracleContract = await ethers.getContractAt('PriceOracle', oldOracle);
  const postageContract = await ethers.getContractAt('PostageStamp', postage);

  const currentPrice = await postageContract.lastPrice();
  const priceOracleRole = await postageContract.PRICE_ORACLE_ROLE();
  const redisRole = await postageContract.REDISTRIBUTOR_ROLE();
  const updaterRole = await oldOracleContract.PRICE_UPDATER_ROLE();

  console.log('=== Base oracle migration ===');
  console.log('Deployer:', deployer.address);
  console.log('DRY_RUN:', DRY_RUN);
  console.log('');
  console.log('Current contracts:');
  console.log('  PriceOracle:      ', oldOracle);
  console.log('  Redistribution:   ', oldRedis);
  console.log('  PostageStamp:     ', postage);
  console.log('  StakeRegistry:    ', staking);
  console.log('  Postage lastPrice:', currentPrice.toString());
  console.log('  roundLength:      ', roundLength);
  console.log('');

  if (DRY_RUN) {
    console.log('Dry run complete. Re-run without DRY_RUN=true to execute on-chain.');
    return;
  }

  // 1. Deploy fresh PriceOracle (lastAdjustedRound = currentRound in constructor)
  const PriceOracle = await ethers.getContractFactory('PriceOracle');
  const newOracle = await PriceOracle.deploy(postage, roundLength);
  await newOracle.deployed();
  console.log('Deployed PriceOracle:', newOracle.address);

  // Sync price to match postage (constructor emits minimum price event only)
  const setPriceTx = await newOracle.setPrice(currentPrice);
  await setPriceTx.wait();
  console.log('Set new oracle price to', currentPrice.toString());

  // 2. Deploy new Redistribution pointing at new oracle
  const Redistribution = await ethers.getContractFactory('Redistribution');
  const newRedis = await Redistribution.deploy(staking, postage, newOracle.address, roundLength);
  await newRedis.deployed();
  console.log('Deployed Redistribution:', newRedis.address);

  // 3. Grant roles on PostageStamp
  console.log('Granting PostageStamp roles...');
  await (await postageContract.grantRole(priceOracleRole, newOracle.address)).wait();
  await (await postageContract.grantRole(redisRole, newRedis.address)).wait();

  // 4. Grant roles on StakeRegistry
  const stakingContract = await ethers.getContractAt('StakeRegistry', staking);
  const stakingRedisRole = await stakingContract.REDISTRIBUTOR_ROLE();
  console.log('Granting StakeRegistry REDISTRIBUTOR_ROLE...');
  await (await stakingContract.grantRole(stakingRedisRole, newRedis.address)).wait();

  // 5. Grant PRICE_UPDATER_ROLE on new oracle to new redistribution
  console.log('Granting PriceOracle PRICE_UPDATER_ROLE...');
  await (await newOracle.grantRole(updaterRole, newRedis.address)).wait();

  // 6. Revoke old contract roles
  console.log('Revoking old contract roles...');
  await (await postageContract.revokeRole(priceOracleRole, oldOracle)).wait();
  await (await postageContract.revokeRole(redisRole, oldRedis)).wait();
  await (await stakingContract.revokeRole(stakingRedisRole, oldRedis)).wait();
  await (await oldOracleContract.revokeRole(updaterRole, oldRedis)).wait();

  // 7. Persist deployment records for hardhat-deploy
  await saveDeployment('PriceOracle', newOracle, [postage, roundLength]);
  await saveDeployment('Redistribution', newRedis, [staking, postage, newOracle.address, roundLength]);

  console.log('');
  console.log('=== Migration complete ===');
  console.log('New PriceOracle:    ', newOracle.address);
  console.log('New Redistribution: ', newRedis.address);
  console.log('');
  console.log('Old contracts (keep for StakeRegistry price reads until upgraded):');
  console.log('  Old PriceOracle:  ', oldOracle);
  console.log('  Old Redistribution:', oldRedis);
  console.log('');
  console.log('IMPORTANT: StakeRegistry still reads price from the OLD oracle.');
  console.log('When the new oracle adjusts price, sync the old oracle via setPrice()');
  console.log('so stake calculations stay accurate.');
  console.log('');
  console.log('Next steps:');
  console.log('  1. npx hardhat deploy --tags data --network base');
  console.log('  2. Update bee node / ops config with new Redistribution address');
  console.log('  3. Verify contracts on Basescan if needed');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
