import 'hardhat-deploy-ethers';
import { ethers, network } from 'hardhat';

async function main() {

  if (network.name == 'testnet') {
    const args = ['gBZZ', 'gBZZ', '1250000000000000000000000'];
    const gBzzTokenFactory = await ethers.getContractFactory("TestToken");
    console.log("Deploying contract...");
    const gBzzToken = await gBzzTokenFactory.deploy(args)
    await gBzzToken.deployed()
    console.log(`Deployed contract to: ${gBzzToken.address}`);

    //console.log(gBzzToken);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
