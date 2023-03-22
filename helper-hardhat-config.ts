export interface networkConfigItem {
  bzzAddress?: string;
  deployedBlock?: number;
  blockConfirmations?: number;
}

export interface networkConfigInfo {
  [key: string]: networkConfigItem;
}

export const networkConfig: networkConfigInfo = {
  localhost: {},
  hardhat: {},
  testnet: {
    bzzAddress: '0x2aC3c1d3e24b45c6C310534Bc2Dd84B5ed576335',
    deployedBlock: 4224739,
    blockConfirmations: 6,
  },
  mainnet: {
    bzzAddress: '0xdBF3Ea6F5beE45c02255B2c26a16F300502F68da',
    deployedBlock: 16514506,
    blockConfirmations: 6,
  },
};

export const developmentChains = ['hardhat', 'localhost'];
