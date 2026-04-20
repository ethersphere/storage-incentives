import { ethers, deployments } from 'hardhat';

async function main() {
  await deployments.fixture();
  const blockNum = await ethers.provider.getBlockNumber();
  console.log('Fixture block number:', blockNum);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
