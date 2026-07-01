/**
 * Change Price Task - Use setPrice function from PriceOracle contract
 *
 * Usage:
 *   npx hardhat changeprice --price 30000 --network localhost
 *
 *   # override the oracle address (defaults to the cluster oracle below)
 *   npx hardhat changeprice --price 30000 --contract 0x1234... --network localhost
 *
 * Parameters:
 *   --price:    The new oracle price (uint)
 *   --contract: PriceOracle contract address (optional)
 *
 * This task:
 * - Reads and logs the current price
 * - Calls setPrice with the provided value
 * - Reads and logs the updated price
 *
 * Note: the signer must hold PRICE_UPDATER_ROLE on the oracle or setPrice reverts.
 */

import { task } from 'hardhat/config';

// Oracle currently deployed on CLUSTER, used as the default target.
const DEFAULT_ORACLE = '0x538E6dE1D876BBCD5667085257bc92F7c808A0F3';

interface TaskArguments {
  price: string;
  contract: string;
}

task('changeprice', 'Use setPrice function from PriceOracle contract')
  .addParam('price', 'The new oracle price (uint)')
  .addOptionalParam('contract', 'PriceOracle contract address', DEFAULT_ORACLE)

  .setAction(async (taskArgs: TaskArguments, hre) => {
    const oracle = await hre.ethers.getContractAt('PriceOracle', taskArgs.contract);

    const currentPrice = await oracle.currentPrice();
    console.log('Current oracle price ', currentPrice.toString());

    const tx = await oracle.setPrice(taskArgs.price);
    await tx.wait();

    const newPrice = await oracle.currentPrice();
    console.log('Changed oracle price ', newPrice.toString());
  });
