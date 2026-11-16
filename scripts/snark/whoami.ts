// Prints the deployer address, chain and balance of the selected network. Never prints keys.
import { ethers, network } from 'hardhat';

async function main() {
  const [deployer] = await ethers.getSigners();
  const balance = await deployer.getBalance();
  console.log(`network ${network.name} chainId ${(await ethers.provider.getNetwork()).chainId}`);
  console.log(`deployer ${deployer.address} balance ${ethers.utils.formatEther(balance)} ETH`);
  console.log(`block ${await ethers.provider.getBlockNumber()}, gas price ${ethers.utils.formatUnits(await ethers.provider.getGasPrice(), 'gwei')} gwei`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
