import 'dotenv/config';
import { HardhatUserConfig } from 'hardhat/types';
import { task } from 'hardhat/config';
import 'solidity-coverage';
import 'hardhat-deploy';
import 'hardhat-deploy-ethers';
import 'hardhat-tracer';
import '@nomiclabs/hardhat-etherscan';
import 'hardhat-contract-sizer';
import 'hardhat-gas-reporter';
import { removeConsoleLog } from 'hardhat-preprocessor';
import './tasks';
import 'hardhat-flat-exporter';
import * as tdly from '@tenderly/hardhat-tenderly';
tdly.setup({ automaticVerifications: true });

// Set Private RPCs if added, otherwise use Public that are hardcoded in this config

const PRIVATE_RPC_MAINNET = !process.env.PRIVATE_RPC_MAINNET ? undefined : process.env.PRIVATE_RPC_MAINNET;
const PRIVATE_RPC_TESTNET = !process.env.PRIVATE_RPC_TESTNET ? undefined : process.env.PRIVATE_RPC_TESTNET;

const walletSecret = process.env.WALLET_SECRET === undefined ? 'undefined' : process.env.WALLET_SECRET;
if (walletSecret === 'undefined') {
  console.log('Please set your WALLET_SECRET in a .env file');
}
const accounts = walletSecret.length === 64 ? [walletSecret] : { mnemonic: walletSecret };

const mainnetEtherscanKey = process.env.MAINNET_ETHERSCAN_KEY;
const testnetEtherscanKey = process.env.TESTNET_ETHERSCAN_KEY;

// Config for hardhat.
const config: HardhatUserConfig = {
  solidity: {
    version: '0.8.19',
    settings: {
      optimizer: {
        enabled: true,
        runs: 1000,
      },
    },
  },
  mocha: {
    timeout: Number.MAX_SAFE_INTEGER,
  },
  preprocess: {
    eachLine: removeConsoleLog((hre) => hre.network.name !== 'hardhat' && hre.network.name !== 'localhost'),
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
    node_5: 11,
    node_6: 12,
    node_7: 13,
  },
  defaultNetwork: 'hardhat',
  networks: {
    hardhat: {
      initialBaseFeePerGas: 0,
      accounts: [
        // deployer 0x3c8F39EE625fCF97cB6ee22bCe25BE1F1E5A5dE8
        {
          privateKey: '0x0d8f0a76e88539c4ceaa6ad01372cce44fb621b56b34b2cc614b4c77fb081f20',
          balance: '10000000000000000000000',
        },
        // admin 0x7E71bA1aB8AF3454a01CFafe358BEbb7691d02f8
        {
          privateKey: '0x8d56d322a1bb1e94c7d64ccd62aa2e5cc9760f59575eda0f7fd392bab8d6ba0d',
          balance: '10000000000000000000000',
        },
        // stamper 0xFCA295bC36F47A3Eb53F657b88f3f324374656C6
        {
          privateKey: '0x963893a36bd803209c07615b0650303706fb01158479a46fba4dea3fe8cf0734',
          balance: '10000000000000000000000',
        },
        // oracle 0xB5963cAcF590909407433024cD3BA0319542E99D
        {
          privateKey: '0xee65b03b4dfdde207a44c6ff5da99201ee0642841ae9f2e07927e8d2ad523d55',
          balance: '10000000000000000000000',
        },
        // redistributor 0x9C8EEad79edDC16594489d63E5A9F7530b642079
        {
          privateKey: '0x34777daf03381f4666635bff0e03720a49f62ba28daa3ab6cabe0922e8574422',
          balance: '10000000000000000000000',
        },
        // pauser 0x4e0B2f8C2210e9ea9341a401C4276549Ea9541c7
        {
          privateKey: '0x4b2519006fefa239fcca606ab6f7d9d474023f6fa1bdab4a13d2fae44f97368d',
          balance: '10000000000000000000000',
        },
        // node_0 0xbFC32C0779b9B17D2e2DCd916493528BF4561142
        {
          privateKey: '0x94a0fc3d873f4f33cfb2841fe2f177d4aac7e0d6f884244f51e23b1f4539c136',
          balance: '10000000000000000000000',
        },
        // node_1 0xb5CFb878581FD7c0bDC9854de707eD47065388c4
        {
          privateKey: '0xc71550f728fccc9e392301d50bde558745ac2ed4c3b0ceb3e38d2047bda480fa',
          balance: '10000000000000000000000',
        },
        // node_2 0x02c7d652018E232ECBe0145716FF061A5E8917E0
        {
          privateKey: '0xb66c4187cc9779d6b76b91b1b7b3deb8bd8ef31633685a7f351c613f5cf31727',
          balance: '10000000000000000000000',
        },
        // node_3 0xa8bF80107abAFC6eF2192AB1D7Ce3f9D777E1161
        {
          privateKey: '0xcd6b1d6669b75582f59971b348eec6e37107fa765fcdb02ae4ad698e684c9803',
          balance: '10000000000000000000000',
        },
        // node_4 0xB257DaAc87899038871E3FB280da58191eFB5Ca2
        {
          privateKey: '0xc1a7ca0bc39058d1fb6e331f8a6a3b65e81f171cfeddeec6cd0f32271496f45c',
          balance: '10000000000000000000000',
        },
        // node_5 - FDP Play Worker 1 node - swarm.key
        {
          privateKey: '0x195cf6324303f6941ad119d0a1d2e862d810078e1370b8d205552a543ff40aab',
          balance: '10000000000000000000000',
        },
        // node_6 0x77CbAdb1059dDC7334227e025fC940469f52FEd8
        {
          privateKey: '0xb65c0589ad60bc9985f0b6eafe5dd480b7ad63f073a7e9625dd23466a0d1947d',
          balance: '10000000000000000000000',
        },
        // node_7 0x4906632d6693733554EE11eA785EB718d2e2ffdA
        {
          privateKey: '0x9d715c14789abdc4c97fd775cf620196bebe991c60c614ba00fedbac943a5e67',
          balance: '10000000000000000000000',
        },
        // other_1
        {
          privateKey: 'f09baf4a06da707abeb96568a1419b4eec094774eaa85ef85517457ffe25b515',
          balance: '10000000000000000000000',
        },
        // other_2 0xb22D48A49c0Aa99AC94072E229E52687E97da253
        {
          privateKey: '5d6172133423006770002831e395aca9d2dad3bcf9257e38c2f19224b4aef78b',
          balance: '10000000000000000000000',
        },
      ],
      hardfork: 'merge',
      deploy: ['deploy/local/'],
    },
    localhost: {
      url: 'http://localhost:8545',
      chainId: 31337,
      deploy: ['deploy/local/'],
    },
    pretestnet: {
      url: PRIVATE_RPC_TESTNET ? PRIVATE_RPC_TESTNET : 'https://goerli.infura.io/v3/9aa3d95b3bc440fa88ea12eaa4456161',
      accounts,
      chainId: 5,
      deploy: ['deploy/test/'],
    },
    testnet: {
      url: PRIVATE_RPC_TESTNET ? PRIVATE_RPC_TESTNET : 'https://goerli.infura.io/v3/9aa3d95b3bc440fa88ea12eaa4456161',
      accounts,
      chainId: 5,
      deploy: ['deploy/test/'],
    },
    sepolia: {
      url: 'https://1rpc.io/sepolia',
      accounts,
      chainId: 11155111,
      deploy: ['deploy/test/'],
    },
    mainfork: {
      url: 'https://rpc.tenderly.co/fork/7e8ac429-5007-44b9-b627-68c2db68de29',
      accounts,
      chainId: 100,
      deploy: ['deploy/main/'],
    },
    mainnet: {
      url: PRIVATE_RPC_MAINNET ? PRIVATE_RPC_MAINNET : 'https://rpc.gnosischain.com',
      accounts,
      chainId: 100,
      deploy: ['deploy/main/'],
    },
  },
  etherscan: {
    apiKey: {
      mainnet: mainnetEtherscanKey || '',
      sepolia: mainnetEtherscanKey || '',
      testnet: testnetEtherscanKey || '',
    },
    customChains: [
      {
        network: 'sepolia',
        chainId: 11155111,
        urls: {
          apiURL: 'https://api-sepolia.etherscan.io/api',
          browserURL: 'https://sepolia.etherscan.io/address/',
        },
      },
      {
        network: 'pretestnet',
        chainId: 5,
        urls: {
          apiURL: 'https://api-goerli.etherscan.io/api',
          browserURL: 'https://goerli.etherscan.io/address/',
        },
      },
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
          apiURL: 'https://api.gnosisscan.io/',
          browserURL: 'https://gnosisscan.io/address/',
        },
      },
    ],
  },
  paths: {
    sources: 'src',
  },
  contractSizer: {
    runOnCompile: false,
  },
  gasReporter: {
    enabled: false,
    currency: 'USD',
    gasPriceApi: 'https://api.gnosisscan.io/api?module=proxy&action=eth_gasPrice', // https://docs.gnosischain.com/tools/oracles/gas-price
    token: 'GNO',
    onlyCalledMethods: true,
    // outputFile: 'gas-report.txt',
    // noColors: true,
    // gasPrice: 40,
    coinmarketcap: process.env.CMC_KEY,
  },
  tenderly: {
    username: 'SwarmDebug',
    project: 'Swarm',
    privateVerification: false,
  },
};

export default config;
