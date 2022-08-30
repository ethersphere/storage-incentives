import 'dotenv/config';
import { HardhatUserConfig } from 'hardhat/types';
import 'solidity-coverage';
import 'hardhat-deploy';
import 'hardhat-deploy-ethers';
import { task } from "hardhat/config";

require("@nomiclabs/hardhat-ethers");

const GOERLI_PRIVATE_KEY = "/";
const GBZZ_TOKEN = "2ac3c1d3e24b45c6c310534bc2dd84b5ed576335";
task("copy", "A sample task with params")
  .addParam("owner", "")
  .addParam("initialbalance", "")
  .addParam("depth", "")
  .addParam("bucketdepth", "")
  .addParam("batchid", "")
  .addParam("immutable", "")
  .setAction(async (taskArgs, { ethers }) => {

  const bytes32 = require('bytes32');

  const [deployer] = await ethers.getSigners();

  const MyContract = await ethers.getContractFactory("PostageStamp");
  const contract = await MyContract.attach(
    "0x07456430a9878626ba42d4A26D5AfDa0A0Ca9D26" // goerli address of new postage stamp contract
  );

  // const MyToken = await ethers.getContractFactory("TestToken");
  // const token = await MyContract.attach(
  //   "0x2ac3c1d3e24b45c6c310534bc2dd84b5ed576335"
  // );

  let bid = ethers.utils.hexValue(taskArgs.batchid);

  let transferAmount = taskArgs.initialbalance * 2 ** taskArgs.depth;

  // let appr = await token.approve(deployer.address, transferAmount);

  // Now you can call functions of the contract
  let result = await contract.copyBatch(ethers.utils.getAddress(taskArgs.owner), taskArgs.initialbalance, taskArgs.depth, taskArgs.bucketdepth, bid, taskArgs.immutable);
  console.log("copy Trx hash:", result.hash);
  console.log("error:", result.error);

  });

module.exports = {
  solidity: "0.8.1",
  networks: {
    goerli: {
      url: `https://goerli.prylabs.net/`,
      accounts: [`${GOERLI_PRIVATE_KEY}`],
      gasPrice: 9_690_000,
      gas: 30_000_000
    }
  },
  etherscan: {
    apiKey: {
      goerli: '8BG68Q43RV7P7VPQ2QGWGHHTBAIU9MNSA1'
    }
  }
};

// Define mnemonic for accounts.
let mnemonic = process.env.MNEMONIC;
if (!mnemonic) {
  // NOTE: this fallback is for development only!
  // When using other networks, set the secret in .env.
  // DO NOT commit or share your mnemonic with others!
  mnemonic = 'test test test test test test test test test test test test';
}

const accounts = { mnemonic };

// Config for hardhat.
const config: HardhatUserConfig = {
  solidity: {
    version: '0.8.1',
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  // mocha: {
  //   timeout: 100000000
  // },
  namedAccounts: {
    deployer: 0,
    admin: 1,
    stamper: 2,
    oracle: 3,
  },
  networks: {
    hardhat: {
      initialBaseFeePerGas: 0,
      accounts,
    },
    localhost: {
      url: 'http://localhost:8545',
      accounts,
    },
    staging: {
      url: 'https://goerli.infura.io/v3/' + process.env.INFURA_TOKEN,
      accounts,
    },
  },
  paths: {
    sources: 'src',
  },
};

export default config;
