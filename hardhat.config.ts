import 'dotenv/config';
import { HardhatUserConfig } from 'hardhat/types';
import 'solidity-coverage';
import 'hardhat-deploy';
import 'hardhat-deploy-ethers';
import 'hardhat-tracer';
import { task } from "hardhat/config";
import { ContractTransaction, ContractReceipt } from 'ethers';
import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { boolean, int, string  } from 'hardhat/internal/core/params/argumentTypes';
import "@ethersproject/bignumber";

// Define mnemonic for accounts.
let mnemonic = process.env.MNEMONIC;
if (!mnemonic) {
  // NOTE: this fallback is for development only!
  // When using other networks, set the secret in .env.
  // DO NOT commit or share your mnemonic with others!
  mnemonic = 'test test test test test test test test test test test test';
}

task("setprice", "Another sample task with params")
.addParam("amount", "", "", string)
.addParam("postagecontract", "", "")
.setAction(async (taskArgs, { ethers }) => {

  const [deployer] = await ethers.getSigners();

  const PostageStamp = await ethers.getContractFactory("PostageStamp");
  const contract = PostageStamp.attach(taskArgs.postagecontract);

  let result: ContractTransaction;
  let receipt: ContractReceipt;

  const priceOracleRole = contract.PRICE_ORACLE_ROLE();
  result = await contract.grantRole(priceOracleRole, deployer.getAddress());
  console.log(result);
  receipt = await result.wait();

  // Now you can call functions of the contract
  result = await contract.setPrice(taskArgs.amount);
  console.log(result);
  receipt = await result.wait();
});


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
    redistributor: 4,
    pauser: 5,
    node_0: 6,
    node_1: 7,
    node_2: 8,
    node_3: 9,
    node_4: 10,
    // node_5: 11,
    // node_6: 12,
    // node_7: 13,
    // node_8: 14
  },
  networks: {
    hardhat: {
      initialBaseFeePerGas: 0,
      accounts: [
        // deployer
        {
          privateKey: '0x0d8f0a76e88539c4ceaa6ad01372cce44fb621b56b34b2cc614b4c77fb081f20',
          balance: '10000000000000000000000',
        },
        // admin
        {
          privateKey: '0x8d56d322a1bb1e94c7d64ccd62aa2e5cc9760f59575eda0f7fd392bab8d6ba0d',
          balance: '10000000000000000000000',
        },
        // stamper
        {
          privateKey: '0x963893a36bd803209c07615b0650303706fb01158479a46fba4dea3fe8cf0734',
          balance: '10000000000000000000000',
        },
        // oracle
        {
          privateKey: '0xee65b03b4dfdde207a44c6ff5da99201ee0642841ae9f2e07927e8d2ad523d55',
          balance: '10000000000000000000000',
        },
        // redistributor
        {
          privateKey: '0x34777daf03381f4666635bff0e03720a49f62ba28daa3ab6cabe0922e8574422',
          balance: '10000000000000000000000',
        },
        // pauser
        {
          privateKey: '0x4b2519006fefa239fcca606ab6f7d9d474023f6fa1bdab4a13d2fae44f97368d',
          balance: '10000000000000000000000',
        },
        // node_0
        {
          privateKey: '0x3d1870a4411478d65da5d44f167fba47f7a7d14d71ca4ae173f341243bb18a28',
          balance: '10000000000000000000000',
        },
        // node_1
        {
          privateKey: '0x4d6650dd904672e8f0202ccacea3e94b96d4f37b76fd97bc47d2cc5649fa05b6',
          balance: '10000000000000000000000',
        },
        // node_2
        {
          privateKey: '0x3e28b11c28c70bb31afe5adf046190dece269c86a923c3e8f168ce5091619cb9',
          balance: '10000000000000000000000',
        },
        // node_3
        {
          privateKey: '0x1336dd9d9cc32c9a75959bb170d6c84997d526cce10fdace47440cfe54f23bd4',
          balance: '10000000000000000000000',
        },
        // node_4
        {
          privateKey: '0x63b7e4fc762a676af3d8b1b69dc7e66ac063ed8ff9d57fcd659b0137182d6768',
          balance: '10000000000000000000000',
        }
      ],
      hardfork: 'merge',
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
