export interface networkConfigItem {
  blockConfirmations?: number;
  swarmNetworkId?: number;
  multisig?: string;
  roundLength?: number; // Length of a round in blocks
  minimumValidityBlocks?: number; // Minimum validity period in blocks (24h)
}
export interface networkConfigInfo {
  [key: string]: networkConfigItem;
}

export const networkConfig: networkConfigInfo = {
  localhost: {
    swarmNetworkId: 0,
    multisig: '0x62cab2b3b55f341f10348720ca18063cdb779ad5',
    roundLength: 152, // 5s blocks
    minimumValidityBlocks: 17280, // 24h with 5s blocks
  },
  hardhat: {
    swarmNetworkId: 0,
    multisig: '0x62cab2b3b55f341f10348720ca18063cdb779ad5',
    roundLength: 152, // 5s blocks
    minimumValidityBlocks: 17280, // 24h with 5s blocks
  },
  localcluster: {
    swarmNetworkId: 0,
    multisig: '0x62cab2b3b55f341f10348720ca18063cdb779ad5',
    roundLength: 152, // 5s blocks
    minimumValidityBlocks: 17280, // 24h with 5s blocks
  },
  testnetlight: {
    blockConfirmations: 6,
    swarmNetworkId: 5,
    multisig: '0xb1C7F17Ed88189Abf269Bf68A3B2Ed83C5276aAe',
    roundLength: 63, // 12s blocks on Sepolia = 756s (~12.6 min, matches Gnosis timing)
    minimumValidityBlocks: 7200, // 24h with 12s blocks
  },
  testnet: {
    blockConfirmations: 6,
    swarmNetworkId: 10,
    multisig: '0xb1C7F17Ed88189Abf269Bf68A3B2Ed83C5276aAe',
    roundLength: 63, // 12s blocks on Sepolia = 756s (~12.6 min, matches Gnosis timing)
    minimumValidityBlocks: 7200, // 24h with 12s blocks
  },
  tenderly: {
    blockConfirmations: 1,
    swarmNetworkId: 1,
    multisig: '0xb1C7F17Ed88189Abf269Bf68A3B2Ed83C5276aAe',
    roundLength: 152, // 5s blocks
    minimumValidityBlocks: 17280, // 24h with 5s blocks
  },
  mainnet: {
    blockConfirmations: 6,
    swarmNetworkId: 1,
    multisig: '0xD5C070FEb5EA883063c183eDFF10BA6836cf9816',
    roundLength: 152, // 5s blocks on Gnosis
    minimumValidityBlocks: 17280, // 24h with 5s blocks
  },
  base: {
    blockConfirmations: 6,
    swarmNetworkId: 2,
    multisig: '0xD5C070FEb5EA883063c183eDFF10BA6836cf9816',
    roundLength: 380, // 2s blocks on Base = 760s (same duration as Gnosis)
    minimumValidityBlocks: 43200, // 24h with 2s blocks
  },
};

export const developmentChains = ['hardhat', 'localhost'];
