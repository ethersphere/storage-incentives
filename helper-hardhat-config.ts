// Chain IDs are often the same but could be different https://chainid.network/chains_mini.json

export interface networkConfigItem {
  bzzAddress?: string;
  deployedBlock?: number;
  blockConfirmations?: number;
  networkID?: number;
  chainID?: number;
  scanLink?: string;
}

export interface networkConfigInfo {
  [key: string]: networkConfigItem;
}

export const networkConfig: networkConfigInfo = {
  localhost: {
    networkID: 0,
    chainID: 0,
    scanLink: "https://goerli.etherscan.io/address/",
  },
  hardhat: {
    networkID: 0,
    chainID: 0,
    scanLink: "https://goerli.etherscan.io/address/",
  },
  testnet: {
    bzzAddress: '0x2aC3c1d3e24b45c6C310534Bc2Dd84B5ed576335',
    deployedBlock: 4224739,
    blockConfirmations: 6,
    networkID: 5,
    chainID: 5,
    scanLink: "https://goerli.etherscan.io/address/",
  },
  mainnet: {
    bzzAddress: '0xdBF3Ea6F5beE45c02255B2c26a16F300502F68da',
    deployedBlock: 16514506,
    blockConfirmations: 6,
    networkID: 100,
    chainID: 100,
    scanLink: "https://gnosisscan.io/address/",
  },
};

export const developmentChains = ['hardhat', 'localhost'];
