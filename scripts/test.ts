import 'hardhat-deploy-ethers';
import { ethers, network } from 'hardhat';
import verify from '../utils/verify';

async function main() {
  // This is deployer script for emergency deployment of only the redistribution contract with some quick fixes
  let args: string[] = [];

  // Change roles on current redis contract
  const redisContract = await ethers.getContractAt('Redistribution', '0x60d55297f7E76B4A09e110c42e7450bFB79a6130');
  const mainAdminRole = '0x0000000000000000000000000000000000000000000000000000000000000000';
  const tx = await redisContract.grantRole(mainAdminRole, '0xa6B04AFfC92BA83D4B6FFAded0A58412892CF381');
  console.log('Changed REDISTRIBUTOR ROLE at : ', tx.hash);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
