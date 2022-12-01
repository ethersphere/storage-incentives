import 'dotenv/config';
import { HardhatUserConfig } from 'hardhat/types';
import 'solidity-coverage';
import 'hardhat-deploy';
import 'hardhat-deploy-ethers';
import 'hardhat-tracer';
import '@nomiclabs/hardhat-etherscan';

const mnemonic = process.env.MNEMONIC === undefined ? 'undefined' : process.env.MNEMONIC;
if (mnemonic === 'undefined') {
  console.log('Please set your MNEMONIC in a .env file');
}

const infuraToken = process.env.INFURA_TOKEN === undefined ? 'undefined' : process.env.INFURA_TOKEN;
if (infuraToken === 'undefined') {
  console.log('Please set your INFURA_TOKEN in a .env file');
}

const mainnetEtherscanKey = process.env.MAINNET_ETHERSCAN_KEY;
const testnetEtherscanKey = process.env.TESTNET_ETHERSCAN_KEY;

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
          privateKey: '0x94a0fc3d873f4f33cfb2841fe2f177d4aac7e0d6f884244f51e23b1f4539c136',
          balance: '10000000000000000000000',
        },
        // node_1
        {
          privateKey: '0xc71550f728fccc9e392301d50bde558745ac2ed4c3b0ceb3e38d2047bda480fa',
          balance: '10000000000000000000000',
        },
        // node_2
        {
          privateKey: '0xb66c4187cc9779d6b76b91b1b7b3deb8bd8ef31633685a7f351c613f5cf31727',
          balance: '10000000000000000000000',
        },
        // node_3
        {
          privateKey: '0xcd6b1d6669b75582f59971b348eec6e37107fa765fcdb02ae4ad698e684c9803',
          balance: '10000000000000000000000',
        },
        // node_4
        {
          privateKey: '0xc1a7ca0bc39058d1fb6e331f8a6a3b65e81f171cfeddeec6cd0f32271496f45c',
          balance: '10000000000000000000000',
        },
      ],
      hardfork: 'merge',
    },
    localhost: {
      url: 'http://localhost:8545',
      accounts,
      chainId: 1,
    },
    testnet: {
      url: 'https://goerli.infura.io/v3/' + infuraToken,
      accounts,
      chainId: 5,
    },
    mainnet: {
      url: 'https://mainnet.infura.io/v3/' + infuraToken,
      accounts,
      chainId: 100,
    },
  },
  etherscan: {
    apiKey: {
      mainnet: '<goerli-api-key>',
      testnet: '<gnosis-api-key>',
    },
    customChains: [
      {
        network: 'testnet',
        chainId: 5,
        urls: {
          apiURL: 'https://api-goerli.etherscan.io/api',
          browserURL: 'https://goerli.etherscan.io/address/',
        },
      },
      {
        network: 'mainnet',
        chainId: 100,
        urls: {
          apiURL: 'https://gnosisscan.io/apis',
          browserURL: 'https://gnosisscan.io/address/',
        },
      },
    ],
  },
  paths: {
    sources: 'src',
  },
};

export default config;
