export interface networkConfigItem {
  blockConfirmations?: number;
  swarmNetworkId?: number;
  multisig?: string;
}
export interface networkConfigInfo {
  [key: string]: networkConfigItem;
}

export const networkConfig: networkConfigInfo = {
  localhost: { swarmNetworkId: 0, multisig: '0x3c8F39EE625fCF97cB6ee22bCe25BE1F1E5A5dE8' },
  hardhat: { swarmNetworkId: 0, multisig: '0x3c8F39EE625fCF97cB6ee22bCe25BE1F1E5A5dE8' },
  testnet: {
    blockConfirmations: 6,
    swarmNetworkId: 10,
    multisig: '0xb1C7F17Ed88189Abf269Bf68A3B2Ed83C5276aAe',
  },
  mainnet: {
    blockConfirmations: 6,
    swarmNetworkId: 1,
    multisig: '0xD5C070FEb5EA883063c183eDFF10BA6836cf9816',
  },
};

export const developmentChains = ['hardhat', 'localhost'];

export const deployedBzzData = {
  testnet: {
    abi: [
      {
        inputs: [
          {
            internalType: 'string',
            name: 'name',
            type: 'string',
          },
          {
            internalType: 'string',
            name: 'symbol',
            type: 'string',
          },
          {
            internalType: 'uint256',
            name: 'initialSupply',
            type: 'uint256',
          },
          {
            internalType: 'address',
            name: 'multisig',
            type: 'address',
          },
        ],
        stateMutability: 'nonpayable',
        type: 'constructor',
      },
      {
        anonymous: false,
        inputs: [
          {
            indexed: true,
            internalType: 'address',
            name: 'owner',
            type: 'address',
          },
          {
            indexed: true,
            internalType: 'address',
            name: 'spender',
            type: 'address',
          },
          {
            indexed: false,
            internalType: 'uint256',
            name: 'value',
            type: 'uint256',
          },
        ],
        name: 'Approval',
        type: 'event',
      },
      {
        anonymous: false,
        inputs: [
          {
            indexed: false,
            internalType: 'address',
            name: 'account',
            type: 'address',
          },
        ],
        name: 'Paused',
        type: 'event',
      },
      {
        anonymous: false,
        inputs: [
          {
            indexed: true,
            internalType: 'bytes32',
            name: 'role',
            type: 'bytes32',
          },
          {
            indexed: true,
            internalType: 'bytes32',
            name: 'previousAdminRole',
            type: 'bytes32',
          },
          {
            indexed: true,
            internalType: 'bytes32',
            name: 'newAdminRole',
            type: 'bytes32',
          },
        ],
        name: 'RoleAdminChanged',
        type: 'event',
      },
      {
        anonymous: false,
        inputs: [
          {
            indexed: true,
            internalType: 'bytes32',
            name: 'role',
            type: 'bytes32',
          },
          {
            indexed: true,
            internalType: 'address',
            name: 'account',
            type: 'address',
          },
          {
            indexed: true,
            internalType: 'address',
            name: 'sender',
            type: 'address',
          },
        ],
        name: 'RoleGranted',
        type: 'event',
      },
      {
        anonymous: false,
        inputs: [
          {
            indexed: true,
            internalType: 'bytes32',
            name: 'role',
            type: 'bytes32',
          },
          {
            indexed: true,
            internalType: 'address',
            name: 'account',
            type: 'address',
          },
          {
            indexed: true,
            internalType: 'address',
            name: 'sender',
            type: 'address',
          },
        ],
        name: 'RoleRevoked',
        type: 'event',
      },
      {
        anonymous: false,
        inputs: [
          {
            indexed: true,
            internalType: 'address',
            name: 'from',
            type: 'address',
          },
          {
            indexed: true,
            internalType: 'address',
            name: 'to',
            type: 'address',
          },
          {
            indexed: false,
            internalType: 'uint256',
            name: 'value',
            type: 'uint256',
          },
        ],
        name: 'Transfer',
        type: 'event',
      },
      {
        anonymous: false,
        inputs: [
          {
            indexed: false,
            internalType: 'address',
            name: 'account',
            type: 'address',
          },
        ],
        name: 'Unpaused',
        type: 'event',
      },
      {
        inputs: [],
        name: 'DEFAULT_ADMIN_ROLE',
        outputs: [
          {
            internalType: 'bytes32',
            name: '',
            type: 'bytes32',
          },
        ],
        stateMutability: 'view',
        type: 'function',
      },
      {
        inputs: [],
        name: 'MINTER_ROLE',
        outputs: [
          {
            internalType: 'bytes32',
            name: '',
            type: 'bytes32',
          },
        ],
        stateMutability: 'view',
        type: 'function',
      },
      {
        inputs: [],
        name: 'PAUSER_ROLE',
        outputs: [
          {
            internalType: 'bytes32',
            name: '',
            type: 'bytes32',
          },
        ],
        stateMutability: 'view',
        type: 'function',
      },
      {
        inputs: [
          {
            internalType: 'address',
            name: 'owner',
            type: 'address',
          },
          {
            internalType: 'address',
            name: 'spender',
            type: 'address',
          },
        ],
        name: 'allowance',
        outputs: [
          {
            internalType: 'uint256',
            name: '',
            type: 'uint256',
          },
        ],
        stateMutability: 'view',
        type: 'function',
      },
      {
        inputs: [
          {
            internalType: 'address',
            name: 'spender',
            type: 'address',
          },
          {
            internalType: 'uint256',
            name: 'amount',
            type: 'uint256',
          },
        ],
        name: 'approve',
        outputs: [
          {
            internalType: 'bool',
            name: '',
            type: 'bool',
          },
        ],
        stateMutability: 'nonpayable',
        type: 'function',
      },
      {
        inputs: [
          {
            internalType: 'address',
            name: 'account',
            type: 'address',
          },
        ],
        name: 'balanceOf',
        outputs: [
          {
            internalType: 'uint256',
            name: '',
            type: 'uint256',
          },
        ],
        stateMutability: 'view',
        type: 'function',
      },
      {
        inputs: [
          {
            internalType: 'uint256',
            name: 'amount',
            type: 'uint256',
          },
        ],
        name: 'burn',
        outputs: [],
        stateMutability: 'nonpayable',
        type: 'function',
      },
      {
        inputs: [
          {
            internalType: 'address',
            name: 'account',
            type: 'address',
          },
          {
            internalType: 'uint256',
            name: 'amount',
            type: 'uint256',
          },
        ],
        name: 'burnFrom',
        outputs: [],
        stateMutability: 'nonpayable',
        type: 'function',
      },
      {
        inputs: [],
        name: 'decimals',
        outputs: [
          {
            internalType: 'uint8',
            name: '',
            type: 'uint8',
          },
        ],
        stateMutability: 'view',
        type: 'function',
      },
      {
        inputs: [
          {
            internalType: 'address',
            name: 'spender',
            type: 'address',
          },
          {
            internalType: 'uint256',
            name: 'subtractedValue',
            type: 'uint256',
          },
        ],
        name: 'decreaseAllowance',
        outputs: [
          {
            internalType: 'bool',
            name: '',
            type: 'bool',
          },
        ],
        stateMutability: 'nonpayable',
        type: 'function',
      },
      {
        inputs: [
          {
            internalType: 'bytes32',
            name: 'role',
            type: 'bytes32',
          },
        ],
        name: 'getRoleAdmin',
        outputs: [
          {
            internalType: 'bytes32',
            name: '',
            type: 'bytes32',
          },
        ],
        stateMutability: 'view',
        type: 'function',
      },
      {
        inputs: [
          {
            internalType: 'bytes32',
            name: 'role',
            type: 'bytes32',
          },
          {
            internalType: 'uint256',
            name: 'index',
            type: 'uint256',
          },
        ],
        name: 'getRoleMember',
        outputs: [
          {
            internalType: 'address',
            name: '',
            type: 'address',
          },
        ],
        stateMutability: 'view',
        type: 'function',
      },
      {
        inputs: [
          {
            internalType: 'bytes32',
            name: 'role',
            type: 'bytes32',
          },
        ],
        name: 'getRoleMemberCount',
        outputs: [
          {
            internalType: 'uint256',
            name: '',
            type: 'uint256',
          },
        ],
        stateMutability: 'view',
        type: 'function',
      },
      {
        inputs: [
          {
            internalType: 'bytes32',
            name: 'role',
            type: 'bytes32',
          },
          {
            internalType: 'address',
            name: 'account',
            type: 'address',
          },
        ],
        name: 'grantRole',
        outputs: [],
        stateMutability: 'nonpayable',
        type: 'function',
      },
      {
        inputs: [
          {
            internalType: 'bytes32',
            name: 'role',
            type: 'bytes32',
          },
          {
            internalType: 'address',
            name: 'account',
            type: 'address',
          },
        ],
        name: 'hasRole',
        outputs: [
          {
            internalType: 'bool',
            name: '',
            type: 'bool',
          },
        ],
        stateMutability: 'view',
        type: 'function',
      },
      {
        inputs: [
          {
            internalType: 'address',
            name: 'spender',
            type: 'address',
          },
          {
            internalType: 'uint256',
            name: 'addedValue',
            type: 'uint256',
          },
        ],
        name: 'increaseAllowance',
        outputs: [
          {
            internalType: 'bool',
            name: '',
            type: 'bool',
          },
        ],
        stateMutability: 'nonpayable',
        type: 'function',
      },
      {
        inputs: [
          {
            internalType: 'address',
            name: 'to',
            type: 'address',
          },
          {
            internalType: 'uint256',
            name: 'amount',
            type: 'uint256',
          },
        ],
        name: 'mint',
        outputs: [],
        stateMutability: 'nonpayable',
        type: 'function',
      },
      {
        inputs: [],
        name: 'name',
        outputs: [
          {
            internalType: 'string',
            name: '',
            type: 'string',
          },
        ],
        stateMutability: 'view',
        type: 'function',
      },
      {
        inputs: [],
        name: 'pause',
        outputs: [],
        stateMutability: 'nonpayable',
        type: 'function',
      },
      {
        inputs: [],
        name: 'paused',
        outputs: [
          {
            internalType: 'bool',
            name: '',
            type: 'bool',
          },
        ],
        stateMutability: 'view',
        type: 'function',
      },
      {
        inputs: [
          {
            internalType: 'bytes32',
            name: 'role',
            type: 'bytes32',
          },
          {
            internalType: 'address',
            name: 'account',
            type: 'address',
          },
        ],
        name: 'renounceRole',
        outputs: [],
        stateMutability: 'nonpayable',
        type: 'function',
      },
      {
        inputs: [
          {
            internalType: 'bytes32',
            name: 'role',
            type: 'bytes32',
          },
          {
            internalType: 'address',
            name: 'account',
            type: 'address',
          },
        ],
        name: 'revokeRole',
        outputs: [],
        stateMutability: 'nonpayable',
        type: 'function',
      },
      {
        inputs: [
          {
            internalType: 'bytes4',
            name: 'interfaceId',
            type: 'bytes4',
          },
        ],
        name: 'supportsInterface',
        outputs: [
          {
            internalType: 'bool',
            name: '',
            type: 'bool',
          },
        ],
        stateMutability: 'view',
        type: 'function',
      },
      {
        inputs: [],
        name: 'symbol',
        outputs: [
          {
            internalType: 'string',
            name: '',
            type: 'string',
          },
        ],
        stateMutability: 'view',
        type: 'function',
      },
      {
        inputs: [],
        name: 'totalSupply',
        outputs: [
          {
            internalType: 'uint256',
            name: '',
            type: 'uint256',
          },
        ],
        stateMutability: 'view',
        type: 'function',
      },
      {
        inputs: [
          {
            internalType: 'address',
            name: 'to',
            type: 'address',
          },
          {
            internalType: 'uint256',
            name: 'amount',
            type: 'uint256',
          },
        ],
        name: 'transfer',
        outputs: [
          {
            internalType: 'bool',
            name: '',
            type: 'bool',
          },
        ],
        stateMutability: 'nonpayable',
        type: 'function',
      },
      {
        inputs: [
          {
            internalType: 'address',
            name: 'from',
            type: 'address',
          },
          {
            internalType: 'address',
            name: 'to',
            type: 'address',
          },
          {
            internalType: 'uint256',
            name: 'amount',
            type: 'uint256',
          },
        ],
        name: 'transferFrom',
        outputs: [
          {
            internalType: 'bool',
            name: '',
            type: 'bool',
          },
        ],
        stateMutability: 'nonpayable',
        type: 'function',
      },
      {
        inputs: [],
        name: 'unpause',
        outputs: [],
        stateMutability: 'nonpayable',
        type: 'function',
      },
    ],
    bytecode:
      '0x608060405234801561001057600080fd5b50600436106101c45760003560e01c806370a08231116100f9578063a457c2d711610097578063d539139311610071578063d539139314610385578063d547741f1461038d578063dd62ed3e146103a0578063e63ab1e9146103b3576101c4565b8063a457c2d71461034c578063a9059cbb1461035f578063ca15c87314610372576101c4565b80639010d07c116100d35780639010d07c1461030957806391d148541461032957806395d89b411461033c578063a217fddf14610344576101c4565b806370a08231146102db57806379cc6790146102ee5780638456cb5914610301576101c4565b8063313ce567116101665780633f4ba83a116101405780633f4ba83a146102a557806340c10f19146102ad57806342966c68146102c05780635c975abb146102d3576101c4565b8063313ce5671461026a57806336568abe1461027f5780633950935114610292576101c4565b806318160ddd116101a257806318160ddd1461021a57806323b872dd1461022f578063248a9ca3146102425780632f2ff15d14610255576101c4565b806301ffc9a7146101c957806306fdde03146101f2578063095ea7b314610207575b600080fd5b6101dc6101d73660046113a0565b6103bb565b6040516101e99190611451565b60405180910390f35b6101fa6103e8565b6040516101e99190611465565b6101dc61021536600461131c565b61047a565b61022261049e565b6040516101e9919061145c565b6101dc61023d3660046112e1565b6104a4565b610222610250366004611345565b6104d2565b61026861026336600461135d565b6104e7565b005b610272610508565b6040516101e99190611958565b61026861028d36600461135d565b61050d565b6101dc6102a036600461131c565b61055c565b610268610588565b6102686102bb36600461131c565b6105da565b6102686102ce366004611345565b61062c565b6101dc610640565b6102226102e9366004611295565b610649565b6102686102fc36600461131c565b610664565b610268610680565b61031c61031736600461137f565b6106d0565b6040516101e9919061143d565b6101dc61033736600461135d565b6106ef565b6101fa610718565b610222610727565b6101dc61035a36600461131c565b61072c565b6101dc61036d36600461131c565b610774565b610222610380366004611345565b61078c565b6102226107a3565b61026861039b36600461135d565b6107c7565b6102226103ae3660046112af565b6107e3565b61022261080e565b60006001600160e01b03198216635a05180f60e01b14806103e057506103e0826108fc565b90505b919050565b6060600580546103f7906119f7565b80601f0160208091040260200160405190810160405280929190818152602001828054610423906119f7565b80156104705780601f1061044557610100808354040283529160200191610470565b820191906000526020600020905b81548152906001019060200180831161045357829003601f168201915b5050505050905090565b600080610485610921565b9050610492818585610925565b60019150505b92915050565b60045490565b6000806104af610921565b90506104bc8582856109d9565b6104c7858585610a23565b506001949350505050565b60009081526020819052604090206001015490565b6104f0826104d2565b6104f981610b24565b6105038383610b35565b505050565b601090565b610515610921565b6001600160a01b0316816001600160a01b03161461054e5760405162461bcd60e51b815260040161054590611888565b60405180910390fd5b6105588282610b57565b5050565b600080610567610921565b905061049281858561057985896107e3565b6105839190611966565b610925565b6105b47f65d7a28e3265b37a6474929f336521b332c1681b933f6cb9f3376673440d862a610337610921565b6105d05760405162461bcd60e51b815260040161054590611580565b6105d8610b79565b565b6106067f9f2df0fed2c77648de5860a4cc508cd0818c85b8b8a1ab4ceeef8d981c8956a6610337610921565b6106225760405162461bcd60e51b8152600401610545906116c6565b6105588282610bcb565b61063d610637610921565b82610c75565b50565b60075460ff1690565b6001600160a01b031660009081526002602052604090205490565b61067682610670610921565b836109d9565b6105588282610c75565b6106ac7f65d7a28e3265b37a6474929f336521b332c1681b933f6cb9f3376673440d862a610337610921565b6106c85760405162461bcd60e51b8152600401610545906117e6565b6105d8610d4c565b60008281526001602052604081206106e89083610d8a565b9392505050565b6000918252602082815260408084206001600160a01b0393909316845291905290205460ff1690565b6060600680546103f7906119f7565b600081565b600080610737610921565b9050600061074582866107e3565b9050838110156107675760405162461bcd60e51b815260040161054590611843565b6104c78286868403610925565b60008061077f610921565b9050610492818585610a23565b60008181526001602052604081206103e090610d96565b7f9f2df0fed2c77648de5860a4cc508cd0818c85b8b8a1ab4ceeef8d981c8956a681565b6107d0826104d2565b6107d981610b24565b6105038383610b57565b6001600160a01b03918216600090815260036020908152604080832093909416825291909152205490565b7f65d7a28e3265b37a6474929f336521b332c1681b933f6cb9f3376673440d862a81565b61083c82826106ef565b610558576000828152602081815260408083206001600160a01b03851684529091529020805460ff19166001179055610873610921565b6001600160a01b0316816001600160a01b0316837f2f8788117e7eff1d82e926ec794901d17c78024a50270940304540a733656f0d60405160405180910390a45050565b60006106e8836001600160a01b038416610da1565b6108d7838383610503565b6108df610640565b156105035760405162461bcd60e51b81526004016105459061190e565b60006001600160e01b03198216637965db0b60e01b14806103e057506103e082610deb565b3390565b6001600160a01b03831661094b5760405162461bcd60e51b8152600401610545906117a2565b6001600160a01b0382166109715760405162461bcd60e51b8152600401610545906115dd565b6001600160a01b0380841660008181526003602090815260408083209487168084529490915290819020849055517f8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925906109cc90859061145c565b60405180910390a3505050565b60006109e584846107e3565b90506000198114610a1d5781811015610a105760405162461bcd60e51b81526004016105459061161f565b610a1d8484848403610925565b50505050565b6001600160a01b038316610a495760405162461bcd60e51b81526004016105459061175d565b6001600160a01b038216610a6f5760405162461bcd60e51b8152600401610545906114cd565b610a7a838383610e04565b6001600160a01b03831660009081526002602052604090205481811015610ab35760405162461bcd60e51b815260040161054590611656565b6001600160a01b0380851660008181526002602052604080822086860390559286168082529083902080548601905591517fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef90610b1190869061145c565b60405180910390a3610a1d848484610503565b61063d81610b30610921565b610e0f565b610b3f8282610832565b600082815260016020526040902061050390826108b7565b610b618282610e68565b60008281526001602052604090206105039082610eeb565b610b81610f00565b6007805460ff191690557f5db9ee0a495bf2e6ff9c91a7834c1ba4fdd244a5e8aa4e537bd38aeae4b073aa610bb4610921565b604051610bc1919061143d565b60405180910390a1565b6001600160a01b038216610bf15760405162461bcd60e51b8152600401610545906118d7565b610bfd60008383610e04565b8060046000828254610c0f9190611966565b90915550506001600160a01b038216600081815260026020526040808220805485019055517fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef90610c6190859061145c565b60405180910390a361055860008383610503565b6001600160a01b038216610c9b5760405162461bcd60e51b81526004016105459061171c565b610ca782600083610e04565b6001600160a01b03821660009081526002602052604090205481811015610ce05760405162461bcd60e51b81526004016105459061153e565b6001600160a01b0383166000818152600260205260408082208585039055600480548690039055519091907fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef90610d3890869061145c565b60405180910390a361050383600084610503565b610d54610f24565b6007805460ff191660011790557f62e78cea01bee320cd4e420270b5ea74000d11b0c9f74754ebdbfc544b05a258610bb4610921565b60006106e88383610f49565b60006103e082610f81565b6000610dad8383610f85565b610de357508154600181810184556000848152602080822090930184905584548482528286019093526040902091909155610498565b506000610498565b6001600160e01b031981166301ffc9a760e01b14919050565b6105038383836108cc565b610e1982826106ef565b61055857610e2681610f9d565b610e31836020610faf565b604051602001610e429291906113c8565b60408051601f198184030181529082905262461bcd60e51b825261054591600401611465565b610e7282826106ef565b15610558576000828152602081815260408083206001600160a01b03851684529091529020805460ff19169055610ea7610921565b6001600160a01b0316816001600160a01b0316837ff6391f5c32d9c69d2a47ea670b442974b53935d1edc7fd64eb21e047a839171b60405160405180910390a45050565b60006106e8836001600160a01b038416611161565b610f08610640565b6105d85760405162461bcd60e51b815260040161054590611510565b610f2c610640565b156105d85760405162461bcd60e51b81526004016105459061169c565b6000826000018281548110610f6e57634e487b7160e01b600052603260045260246000fd5b9060005260206000200154905092915050565b5490565b60009081526001919091016020526040902054151590565b60606103e06001600160a01b03831660145b60606000610fbe83600261197e565b610fc9906002611966565b67ffffffffffffffff811115610fef57634e487b7160e01b600052604160045260246000fd5b6040519080825280601f01601f191660200182016040528015611019576020820181803683370190505b509050600360fc1b8160008151811061104257634e487b7160e01b600052603260045260246000fd5b60200101906001600160f81b031916908160001a905350600f60fb1b8160018151811061107f57634e487b7160e01b600052603260045260246000fd5b60200101906001600160f81b031916908160001a90535060006110a384600261197e565b6110ae906001611966565b90505b6001811115611142576f181899199a1a9b1b9c1cb0b131b232b360811b85600f16601081106110f057634e487b7160e01b600052603260045260246000fd5b1a60f81b82828151811061111457634e487b7160e01b600052603260045260246000fd5b60200101906001600160f81b031916908160001a90535060049490941c9361113b816119e0565b90506110b1565b5083156106e85760405162461bcd60e51b815260040161054590611498565b6000818152600183016020526040812054801561127457600061118560018361199d565b85549091506000906111999060019061199d565b905081811461121a5760008660000182815481106111c757634e487b7160e01b600052603260045260246000fd5b90600052602060002001549050808760000184815481106111f857634e487b7160e01b600052603260045260246000fd5b6000918252602080832090910192909255918252600188019052604090208390555b855486908061123957634e487b7160e01b600052603160045260246000fd5b600190038181906000526020600020016000905590558560010160008681526020019081526020016000206000905560019350505050610498565b6000915050610498565b80356001600160a01b03811681146103e357600080fd5b6000602082840312156112a6578081fd5b6106e88261127e565b600080604083850312156112c1578081fd5b6112ca8361127e565b91506112d86020840161127e565b90509250929050565b6000806000606084860312156112f5578081fd5b6112fe8461127e565b925061130c6020850161127e565b9150604084013590509250925092565b6000806040838503121561132e578182fd5b6113378361127e565b946020939093013593505050565b600060208284031215611356578081fd5b5035919050565b6000806040838503121561136f578182fd5b823591506112d86020840161127e565b60008060408385031215611391578182fd5b50508035926020909101359150565b6000602082840312156113b1578081fd5b81356001600160e01b0319811681146106e8578182fd5b60007f416363657373436f6e74726f6c3a206163636f756e7420000000000000000000825283516114008160178501602088016119b4565b7001034b99036b4b9b9b4b733903937b6329607d1b60179184019182015283516114318160288401602088016119b4565b01602801949350505050565b6001600160a01b0391909116815260200190565b901515815260200190565b90815260200190565b60006020825282518060208401526114848160408501602087016119b4565b601f01601f19169190910160400192915050565b6020808252818101527f537472696e67733a20686578206c656e67746820696e73756666696369656e74604082015260600190565b60208082526023908201527f45524332303a207472616e7366657220746f20746865207a65726f206164647260408201526265737360e81b606082015260800190565b60208082526014908201527314185d5cd8589b194e881b9bdd081c185d5cd95960621b604082015260600190565b60208082526022908201527f45524332303a206275726e20616d6f756e7420657863656564732062616c616e604082015261636560f01b606082015260800190565b60208082526039908201527f45524332305072657365744d696e7465725061757365723a206d75737420686160408201527f76652070617573657220726f6c6520746f20756e706175736500000000000000606082015260800190565b60208082526022908201527f45524332303a20617070726f766520746f20746865207a65726f206164647265604082015261737360f01b606082015260800190565b6020808252601d908201527f45524332303a20696e73756666696369656e7420616c6c6f77616e6365000000604082015260600190565b60208082526026908201527f45524332303a207472616e7366657220616d6f756e7420657863656564732062604082015265616c616e636560d01b606082015260800190565b60208082526010908201526f14185d5cd8589b194e881c185d5cd95960821b604082015260600190565b60208082526036908201527f45524332305072657365744d696e7465725061757365723a206d7573742068616040820152751d99481b5a5b9d195c881c9bdb19481d1bc81b5a5b9d60521b606082015260800190565b60208082526021908201527f45524332303a206275726e2066726f6d20746865207a65726f206164647265736040820152607360f81b606082015260800190565b60208082526025908201527f45524332303a207472616e736665722066726f6d20746865207a65726f206164604082015264647265737360d81b606082015260800190565b60208082526024908201527f45524332303a20617070726f76652066726f6d20746865207a65726f206164646040820152637265737360e01b606082015260800190565b60208082526037908201527f45524332305072657365744d696e7465725061757365723a206d75737420686160408201527f76652070617573657220726f6c6520746f207061757365000000000000000000606082015260800190565b60208082526025908201527f45524332303a2064656372656173656420616c6c6f77616e63652062656c6f77604082015264207a65726f60d81b606082015260800190565b6020808252602f908201527f416363657373436f6e74726f6c3a2063616e206f6e6c792072656e6f756e636560408201526e103937b632b9903337b91039b2b63360891b606082015260800190565b6020808252601f908201527f45524332303a206d696e7420746f20746865207a65726f206164647265737300604082015260600190565b6020808252602a908201527f45524332305061757361626c653a20746f6b656e207472616e736665722077686040820152691a5b19481c185d5cd95960b21b606082015260800190565b60ff91909116815260200190565b6000821982111561197957611979611a32565b500190565b600081600019048311821515161561199857611998611a32565b500290565b6000828210156119af576119af611a32565b500390565b60005b838110156119cf5781810151838201526020016119b7565b83811115610a1d5750506000910152565b6000816119ef576119ef611a32565b506000190190565b600281046001821680611a0b57607f821691505b60208210811415611a2c57634e487b7160e01b600052602260045260246000fd5b50919050565b634e487b7160e01b600052601160045260246000fdfea2646970667358221220ae75141a4ad6bac0b7a6d6ad11ec816375a11c769f485f4a6c845b289c54f11864736f6c63430008010033',
    address: '0xa66be4A7De4DfA5478Cb2308469D90115C45aA23',
    block: 3539674,
    url: 'https://sepolia.etherscan.io/address/0xa66be4A7De4DfA5478Cb2308469D90115C45aA23',
  },
  mainnet: {
    abi: [
      {
        constant: true,
        inputs: [],
        name: 'name',
        outputs: [
          {
            name: '',
            type: 'string',
          },
        ],
        payable: false,
        stateMutability: 'view',
        type: 'function',
      },
      {
        constant: false,
        inputs: [
          {
            name: 'spender',
            type: 'address',
          },
          {
            name: 'amount',
            type: 'uint256',
          },
        ],
        name: 'approve',
        outputs: [
          {
            name: '',
            type: 'bool',
          },
        ],
        payable: false,
        stateMutability: 'nonpayable',
        type: 'function',
      },
      {
        constant: true,
        inputs: [],
        name: 'totalSupply',
        outputs: [
          {
            name: '',
            type: 'uint256',
          },
        ],
        payable: false,
        stateMutability: 'view',
        type: 'function',
      },
      {
        constant: false,
        inputs: [
          {
            name: 'sender',
            type: 'address',
          },
          {
            name: 'recipient',
            type: 'address',
          },
          {
            name: 'amount',
            type: 'uint256',
          },
        ],
        name: 'transferFrom',
        outputs: [
          {
            name: '',
            type: 'bool',
          },
        ],
        payable: false,
        stateMutability: 'nonpayable',
        type: 'function',
      },
      {
        constant: true,
        inputs: [],
        name: 'decimals',
        outputs: [
          {
            name: '',
            type: 'uint8',
          },
        ],
        payable: false,
        stateMutability: 'view',
        type: 'function',
      },
      {
        constant: true,
        inputs: [],
        name: 'cap',
        outputs: [
          {
            name: '',
            type: 'uint256',
          },
        ],
        payable: false,
        stateMutability: 'view',
        type: 'function',
      },
      {
        constant: false,
        inputs: [
          {
            name: 'spender',
            type: 'address',
          },
          {
            name: 'addedValue',
            type: 'uint256',
          },
        ],
        name: 'increaseAllowance',
        outputs: [
          {
            name: '',
            type: 'bool',
          },
        ],
        payable: false,
        stateMutability: 'nonpayable',
        type: 'function',
      },
      {
        constant: false,
        inputs: [
          {
            name: 'account',
            type: 'address',
          },
          {
            name: 'amount',
            type: 'uint256',
          },
        ],
        name: 'mint',
        outputs: [
          {
            name: '',
            type: 'bool',
          },
        ],
        payable: false,
        stateMutability: 'nonpayable',
        type: 'function',
      },
      {
        constant: false,
        inputs: [
          {
            name: 'amount',
            type: 'uint256',
          },
        ],
        name: 'burn',
        outputs: [],
        payable: false,
        stateMutability: 'nonpayable',
        type: 'function',
      },
      {
        constant: true,
        inputs: [
          {
            name: 'account',
            type: 'address',
          },
        ],
        name: 'balanceOf',
        outputs: [
          {
            name: '',
            type: 'uint256',
          },
        ],
        payable: false,
        stateMutability: 'view',
        type: 'function',
      },
      {
        constant: false,
        inputs: [
          {
            name: 'account',
            type: 'address',
          },
          {
            name: 'amount',
            type: 'uint256',
          },
        ],
        name: 'burnFrom',
        outputs: [],
        payable: false,
        stateMutability: 'nonpayable',
        type: 'function',
      },
      {
        constant: true,
        inputs: [],
        name: 'symbol',
        outputs: [
          {
            name: '',
            type: 'string',
          },
        ],
        payable: false,
        stateMutability: 'view',
        type: 'function',
      },
      {
        constant: false,
        inputs: [
          {
            name: 'account',
            type: 'address',
          },
        ],
        name: 'addMinter',
        outputs: [],
        payable: false,
        stateMutability: 'nonpayable',
        type: 'function',
      },
      {
        constant: false,
        inputs: [],
        name: 'renounceMinter',
        outputs: [],
        payable: false,
        stateMutability: 'nonpayable',
        type: 'function',
      },
      {
        constant: false,
        inputs: [
          {
            name: 'spender',
            type: 'address',
          },
          {
            name: 'subtractedValue',
            type: 'uint256',
          },
        ],
        name: 'decreaseAllowance',
        outputs: [
          {
            name: '',
            type: 'bool',
          },
        ],
        payable: false,
        stateMutability: 'nonpayable',
        type: 'function',
      },
      {
        constant: false,
        inputs: [
          {
            name: 'recipient',
            type: 'address',
          },
          {
            name: 'amount',
            type: 'uint256',
          },
        ],
        name: 'transfer',
        outputs: [
          {
            name: '',
            type: 'bool',
          },
        ],
        payable: false,
        stateMutability: 'nonpayable',
        type: 'function',
      },
      {
        constant: true,
        inputs: [
          {
            name: 'account',
            type: 'address',
          },
        ],
        name: 'isMinter',
        outputs: [
          {
            name: '',
            type: 'bool',
          },
        ],
        payable: false,
        stateMutability: 'view',
        type: 'function',
      },
      {
        constant: true,
        inputs: [
          {
            name: 'owner',
            type: 'address',
          },
          {
            name: 'spender',
            type: 'address',
          },
        ],
        name: 'allowance',
        outputs: [
          {
            name: '',
            type: 'uint256',
          },
        ],
        payable: false,
        stateMutability: 'view',
        type: 'function',
      },
      {
        inputs: [
          {
            name: '_name',
            type: 'string',
          },
          {
            name: '_symbol',
            type: 'string',
          },
          {
            name: '_decimals',
            type: 'uint8',
          },
          {
            name: '_cap',
            type: 'uint256',
          },
        ],
        payable: false,
        stateMutability: 'nonpayable',
        type: 'constructor',
      },
      {
        anonymous: false,
        inputs: [
          {
            indexed: true,
            name: 'account',
            type: 'address',
          },
        ],
        name: 'MinterAdded',
        type: 'event',
      },
      {
        anonymous: false,
        inputs: [
          {
            indexed: true,
            name: 'account',
            type: 'address',
          },
        ],
        name: 'MinterRemoved',
        type: 'event',
      },
      {
        anonymous: false,
        inputs: [
          {
            indexed: true,
            name: 'from',
            type: 'address',
          },
          {
            indexed: true,
            name: 'to',
            type: 'address',
          },
          {
            indexed: false,
            name: 'value',
            type: 'uint256',
          },
        ],
        name: 'Transfer',
        type: 'event',
      },
      {
        anonymous: false,
        inputs: [
          {
            indexed: true,
            name: 'owner',
            type: 'address',
          },
          {
            indexed: true,
            name: 'spender',
            type: 'address',
          },
          {
            indexed: false,
            name: 'value',
            type: 'uint256',
          },
        ],
        name: 'Approval',
        type: 'event',
      },
    ],
    bytecode:
      '0x000500004ac82b41bd819dd871590b510316f2385cb196fb000000000001314d88ad09518695c6c3712ac10a214be5109a655671f6a78083ca3e2a662d6dd1703c939c8ace2e268d000f424001010001642ae87cdd00000000000000000000000019062190b1925b5b6689d7073fdfc8c2976ef8cb00000000000000000000000000000000000000000000000000000000000000c000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000f32251e502a3734460a7a711248a84385e19aa4b000000000000000000000000000000000000000000000000002386f26fc100000000000000000000000000000000000000000000000000000000000000000003425a5a00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003425a5a0000000000000000000000000000000000000000000000000000000000',
    address: '0xdBF3Ea6F5beE45c02255B2c26a16F300502F68da',
    block: 16514506,
    url: 'https://gnosisscan.io/address/0xdBF3Ea6F5beE45c02255B2c26a16F300502F68da',
  },
};
