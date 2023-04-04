import 'hardhat-deploy-ethers';
import { ethers, network } from 'hardhat';
import verify from '../utils/verify';

async function main() {
  // This is deployer script for emergency deployment of only the redistribution contract with some quick fixes
  let args: string[] = [];
  if (network.name == 'mainnet') {
    // Staking, Stamps, Oracle args
    args = [
      '0x781c6D1f0eaE6F1Da1F604c6cDCcdB8B76428ba7',
      '0x30d155478eF27Ab32A1D578BE7b84BC5988aF381',
      '0x344A2CC7304B32A87EfDC5407cD4bEC7cf98F035',
    ];
  } else if (network.name == 'testnet') {
    args = [
      '0xCb07bf0603da228C8ec602bf12b973b8A94f9bac',
      '0x1f87FEDa43e6ABFe1058E96A07d0ea182e7dc9BD',
      '0x3e475aEAB162E28fee46E69225af446D3c4f3Bd3',
    ];
  }
  const redisFactory = await ethers.getContractFactory('Redistribution');
  console.log('Deploying contract...');
  const redis = await redisFactory.deploy(...args);
  await redis.deployed();
  console.log(`Deployed contract to: ${redis.address}`);
  await redis.deployTransaction.wait(6);

  if (process.env.MAINNET_ETHERSCAN_KEY || process.env.TESTNET_ETHERSCAN_KEY) {
    console.log('Verifying...');
    await verify(redis.address, args);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
