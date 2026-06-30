export interface networkConfigItem {
  blockConfirmations?: number;
  swarmNetworkId?: number;
  multisig?: string;
  stakeWaitBase?: number;
  stakeWaitOverlayChange?: number;
  stakeWaitWithdrawal?: number;
}
export interface networkConfigInfo {
  [key: string]: networkConfigItem;
}

const ROUNDS_PER_DAY = 114;
const WITHDRAWAL_WAIT_ROUNDS = ROUNDS_PER_DAY * 28;

export const networkConfig: networkConfigInfo = {
  localhost: {
    swarmNetworkId: 0,
    multisig: '0x62cab2b3b55f341f10348720ca18063cdb779ad5',
    stakeWaitBase: 2,
    stakeWaitOverlayChange: 2,
    stakeWaitWithdrawal: 2,
  },
  hardhat: {
    swarmNetworkId: 0,
    multisig: '0x62cab2b3b55f341f10348720ca18063cdb779ad5',
    stakeWaitBase: 2,
    stakeWaitOverlayChange: 2,
    stakeWaitWithdrawal: 2,
  },
  localcluster: {
    swarmNetworkId: 0,
    multisig: '0x62cab2b3b55f341f10348720ca18063cdb779ad5',
    stakeWaitBase: 2,
    stakeWaitOverlayChange: 2,
    stakeWaitWithdrawal: 2,
  },
  testnetlight: {
    blockConfirmations: 6,
    swarmNetworkId: 5,
    multisig: '0xb1C7F17Ed88189Abf269Bf68A3B2Ed83C5276aAe',
    stakeWaitBase: 2,
    stakeWaitOverlayChange: 2,
    stakeWaitWithdrawal: WITHDRAWAL_WAIT_ROUNDS,
  },
  testnet: {
    blockConfirmations: 6,
    swarmNetworkId: 10,
    multisig: '0xb1C7F17Ed88189Abf269Bf68A3B2Ed83C5276aAe',
    stakeWaitBase: 2,
    stakeWaitOverlayChange: 2,
    stakeWaitWithdrawal: WITHDRAWAL_WAIT_ROUNDS,
  },
  tenderly: {
    blockConfirmations: 1,
    swarmNetworkId: 1,
    multisig: '0xb1C7F17Ed88189Abf269Bf68A3B2Ed83C5276aAe',
    stakeWaitBase: 2,
    stakeWaitOverlayChange: 2,
    stakeWaitWithdrawal: WITHDRAWAL_WAIT_ROUNDS,
  },
  mainnet: {
    blockConfirmations: 6,
    swarmNetworkId: 1,
    multisig: '0xD5C070FEb5EA883063c183eDFF10BA6836cf9816',
    stakeWaitBase: 2,
    stakeWaitOverlayChange: 2,
    stakeWaitWithdrawal: WITHDRAWAL_WAIT_ROUNDS,
  },
};

export const developmentChains = ['hardhat', 'localhost'];
