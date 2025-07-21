import 'hardhat-deploy-ethers';
import { ethers } from 'hardhat';

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main() {
  // Contracts currently deployed on CLUSTER
  const currentOracle = '0x538E6dE1D876BBCD5667085257bc92F7c808A0F3';

  // Change oracle price example

  // Get Oracle contract at deployed address
  const oracle = await ethers.getContractAt('PriceOracle', currentOracle);

  // Check current price with read only function
  const curentPrice = await oracle.currentPrice();
  console.log('Curent oracle price ', curentPrice);

  // Change current price with write function
  await oracle.setPrice(24021);
  await delay(5000);

  // Check value of current price
  const newPrice = await oracle.currentPrice();
  console.log('Changed oracle price ', newPrice);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
