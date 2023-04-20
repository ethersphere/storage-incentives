import 'hardhat-deploy-ethers';
import { ethers, network } from 'hardhat';
import verify from '../utils/verify';
import { developmentChains } from '../helper-hardhat-config';

async function main() {
  if (network.name == 'testnet' || network.name == 'sepolia') {
    const args = ['gBZZ', 'gBZZ', '1250000000000000000000000'];
    const gBzzTokenFactory = await ethers.getContractFactory('TestToken');
    console.log('Deploying contract...');
    const gBzzToken = await gBzzTokenFactory.deploy(...args);
    await gBzzToken.deployed();
    console.log(`Deployed contract to: ${gBzzToken.address}`);
    await gBzzToken.deployTransaction.wait(6);

    if (!developmentChains.includes(network.name) && process.env.TESTNET_ETHERSCAN_KEY) {
      console.log('Verifying...');
      await verify(gBzzToken.address, args);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
