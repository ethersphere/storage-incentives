export interface networkConfigItem {
  blockConfirmations?: number;
  swarmNetworkId?: number;
  multisig?: string;
  sp1VerifierGateway?: string;
}
export interface networkConfigInfo {
  [key: string]: networkConfigItem;
}

export const networkConfig: networkConfigInfo = {
  localhost: { swarmNetworkId: 0, multisig: '0x62cab2b3b55f341f10348720ca18063cdb779ad5' },
  hardhat: { swarmNetworkId: 0, multisig: '0x62cab2b3b55f341f10348720ca18063cdb779ad5' },
  localcluster: { swarmNetworkId: 0, multisig: '0x62cab2b3b55f341f10348720ca18063cdb779ad5' },
  testnetlight: {
    blockConfirmations: 6,
    swarmNetworkId: 5,
    multisig: '0xb1C7F17Ed88189Abf269Bf68A3B2Ed83C5276aAe',
  },
  testnet: {
    blockConfirmations: 6,
    swarmNetworkId: 10,
    multisig: '0xb1C7F17Ed88189Abf269Bf68A3B2Ed83C5276aAe',
  },
  zklocal: { blockConfirmations: 1, swarmNetworkId: 0 },
  sepoliazk: {
    blockConfirmations: 2,
    swarmNetworkId: 10,
    // SP1 Groth16 verifier gateway, succinctlabs/sp1-contracts deployments/11155111.json
    sp1VerifierGateway: '0x397A5f7f3dBd538f23DE225B51f532c34448dA9B',
  },
  tenderly: {
    blockConfirmations: 1,
    swarmNetworkId: 1,
    multisig: '0xb1C7F17Ed88189Abf269Bf68A3B2Ed83C5276aAe',
  },
  mainnet: {
    blockConfirmations: 6,
    swarmNetworkId: 1,
    multisig: '0xD5C070FEb5EA883063c183eDFF10BA6836cf9816',
  },
};

export const developmentChains = ['hardhat', 'localhost'];
