import 'hardhat-deploy-ethers';
import '@nomiclabs/hardhat-etherscan';
import { ethers, network } from 'hardhat';
import hre from 'hardhat';

async function main() {
  // This is deployer script for emergency deployment of only the postagestamp contract with some quick fixes

  const provider = hre.ethers.provider;

  const params = [
    ethers.utils.hexValue(10), // hex encoded number of blocks to increase
  ];

  await provider.send('evm_increaseBlocks', params);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
