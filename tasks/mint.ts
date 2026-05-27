/**
 * Mint Task - Mint test BZZ tokens to an address
 *
 * Usage:
 *   npx hardhat mint --amount 1000 --network base                     # Mint to signer
 *   npx hardhat mint --to 0xYourAddress --amount 1000 --network base  # Mint to specific address
 *   npx hardhat mint --amount 1000 --network localhost
 *
 * Note: Only accounts with MINTER_ROLE can mint tokens.
 * The deployer address has MINTER_ROLE by default.
 *
 * Amount is in whole tokens (will be multiplied by 10^16 for BZZ decimals).
 */

import { task } from 'hardhat/config';
import { HardhatRuntimeEnvironment } from 'hardhat/types';

task('mint', 'Mint test BZZ tokens to an address')
  .addOptionalParam('to', 'Recipient address (defaults to signer if not provided)')
  .addParam('amount', 'Amount of tokens to mint (in whole tokens, e.g., 1000)')
  .setAction(async (taskArgs, hre: HardhatRuntimeEnvironment) => {
    const { amount } = taskArgs;
    const network = hre.network.name;

    console.log(`\n🪙 Minting BZZ tokens on ${network}...\n`);

    // Get signer first (needed for default recipient)
    const [signer] = await hre.ethers.getSigners();

    // Use provided address or default to signer
    const to = taskArgs.to || signer.address;

    // Validate address
    if (!hre.ethers.utils.isAddress(to)) {
      throw new Error(`Invalid address: ${to}`);
    }

    // Get the token contract address based on network
    let tokenAddress: string;

    if (network === 'localhost' || network === 'hardhat') {
      // For local network, get from deployments
      const deployment = await hre.deployments.get('TestToken');
      tokenAddress = deployment.address;
    } else if (network === 'base') {
      // Base mainnet deployment
      tokenAddress = '0x239Db952bde69A15962436C6CD86FDd3b45342e4';
    } else {
      throw new Error(`Unsupported network: ${network}. Use 'base', 'localhost', or 'hardhat'.`);
    }

    console.log(`📍 Token address: ${tokenAddress}`);
    console.log(`📍 Recipient: ${to}${taskArgs.to ? '' : ' (signer)'}`);
    console.log(`📍 Amount: ${amount} BZZ`);
    console.log(`📍 Minter (signer): ${signer.address}`);

    // Get token contract
    const token = await hre.ethers.getContractAt('TestToken', tokenAddress, signer);

    // Check if signer has MINTER_ROLE
    const MINTER_ROLE = hre.ethers.utils.keccak256(hre.ethers.utils.toUtf8Bytes('MINTER_ROLE'));
    const hasMinterRole = await token.hasRole(MINTER_ROLE, signer.address);

    if (!hasMinterRole) {
      console.log(`\n❌ Error: Signer ${signer.address} does not have MINTER_ROLE`);
      console.log(`   Only the deployer or addresses granted MINTER_ROLE can mint.`);
      process.exit(1);
    }

    console.log(`✅ Signer has MINTER_ROLE`);

    // BZZ uses 16 decimals
    const decimals = await token.decimals();
    const amountWithDecimals = hre.ethers.utils.parseUnits(amount, decimals);

    console.log(`\n🔄 Minting ${amount} BZZ (${amountWithDecimals.toString()} raw)...`);

    // Mint tokens
    const tx = await token.mint(to, amountWithDecimals);
    console.log(`📝 Transaction hash: ${tx.hash}`);

    // Wait for confirmation
    const receipt = await tx.wait();
    console.log(`✅ Confirmed in block ${receipt.blockNumber}`);

    // Check new balance
    const newBalance = await token.balanceOf(to);
    const formattedBalance = hre.ethers.utils.formatUnits(newBalance, decimals);

    console.log(`\n💰 New balance of ${to}: ${formattedBalance} BZZ`);
    console.log(`\n✅ Done!`);
  });
