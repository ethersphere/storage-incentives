export interface networkConfigItem {
  blockConfirmations?: number;
  swarmNetworkId?: number;
  multisig?: string;
  minimumValidityBlocks?: number;
}
export interface networkConfigInfo {
  [key: string]: networkConfigItem;
}

export const networkConfig: networkConfigInfo = {
  localhost: {
    swarmNetworkId: 0,
    multisig: '0x62cab2b3b55f341f10348720ca18063cdb779ad5',
    minimumValidityBlocks: 17280, // ~24h for 5s blocks (Gnosis)
  },
  hardhat: {
    swarmNetworkId: 0,
    multisig: '0x62cab2b3b55f341f10348720ca18063cdb779ad5',
    minimumValidityBlocks: 17280, // ~24h for 5s blocks (Gnosis)
  },
  localcluster: {
    swarmNetworkId: 0,
    multisig: '0x62cab2b3b55f341f10348720ca18063cdb779ad5',
    minimumValidityBlocks: 17280, // ~24h for 5s blocks (Gnosis)
  },
  testnetlight: {
    blockConfirmations: 6,
    swarmNetworkId: 5,
    multisig: '0xb1C7F17Ed88189Abf269Bf68A3B2Ed83C5276aAe',
    minimumValidityBlocks: 7200, // ~24h for 12s blocks (Sepolia)
  },
  testnet: {
    blockConfirmations: 6,
    swarmNetworkId: 10,
    multisig: '0xb1C7F17Ed88189Abf269Bf68A3B2Ed83C5276aAe',
    minimumValidityBlocks: 7200, // ~24h for 12s blocks (Sepolia)
  },
  tenderly: {
    blockConfirmations: 1,
    swarmNetworkId: 1,
    multisig: '0xb1C7F17Ed88189Abf269Bf68A3B2Ed83C5276aAe',
    minimumValidityBlocks: 17280, // ~24h for 5s blocks (Gnosis)
  },
  mainnet: {
    blockConfirmations: 6,
    swarmNetworkId: 1,
    multisig: '0xD5C070FEb5EA883063c183eDFF10BA6836cf9816',
    minimumValidityBlocks: 17280, // ~24h for 5s blocks (Gnosis)
  },
};

export const developmentChains = ['hardhat', 'localhost'];
