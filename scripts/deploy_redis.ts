import 'hardhat-deploy-ethers';
import { ethers, network } from 'hardhat';
import verify from '../utils/verify';

async function main() {
  if (network.name == 'testnet' || network.name == 'sepolia') {
    // Staking, Stamps, Oracle args
    // TODO add admin roles to constructor so I can deploy from any account and set to current admin
    const args = [
      '0xCb07bf0603da228C8ec602bf12b973b8A94f9bac',
      '0x1f87FEDa43e6ABFe1058E96A07d0ea182e7dc9BD',
      '0x3e475aEAB162E28fee46E69225af446D3c4f3Bd3',
    ];
    const redisFactory = await ethers.getContractFactory('Redistribution');
    console.log('Deploying contract...');
    const redis = await redisFactory.deploy(...args);
    await redis.deployed();
    console.log(`Deployed contract to: ${redis.address}`);
    await redis.deployTransaction.wait(6);

    if (network.name == 'testnet' || network.name == 'sepolia') {
      console.log('Verifying...');
      await verify(redis.address, args);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
