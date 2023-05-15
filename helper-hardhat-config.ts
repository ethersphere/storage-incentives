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
      '0x6080604052600436106100fb5763ffffffff7c010000000000000000000000000000000000000000000000000000000060003504166306fdde038114610100578063095ea7b31461018a57806318160ddd146101d757806323b872dd146101fe578063313ce56714610241578063355274ea1461026c578063395093511461028157806340c10f19146102ba57806342966c68146102f357806370a082311461031f57806379cc67901461035257806395d89b411461038b578063983b2d56146103a057806398650275146103d3578063a457c2d7146103e8578063a9059cbb14610421578063aa271e1a1461045a578063dd62ed3e1461048d575b600080fd5b34801561010c57600080fd5b506101156104c8565b6040805160208082528351818301528351919283929083019185019080838360005b8381101561014f578181015183820152602001610137565b50505050905090810190601f16801561017c5780820380516001836020036101000a031916815260200191505b509250505060405180910390f35b34801561019657600080fd5b506101c3600480360360408110156101ad57600080fd5b50600160a060020a03813516906020013561055e565b604080519115158252519081900360200190f35b3480156101e357600080fd5b506101ec61057b565b60408051918252519081900360200190f35b34801561020a57600080fd5b506101c36004803603606081101561022157600080fd5b50600160a060020a03813581169160208101359091169060400135610581565b34801561024d57600080fd5b50610256610660565b6040805160ff9092168252519081900360200190f35b34801561027857600080fd5b506101ec610669565b34801561028d57600080fd5b506101c3600480360360408110156102a457600080fd5b50600160a060020a03813516906020013561066f565b3480156102c657600080fd5b506101c3600480360360408110156102dd57600080fd5b50600160a060020a0381351690602001356106c3565b3480156102ff57600080fd5b5061031d6004803603602081101561031657600080fd5b503561075b565b005b34801561032b57600080fd5b506101ec6004803603602081101561034257600080fd5b5035600160a060020a03166107f6565b34801561035e57600080fd5b5061031d6004803603604081101561037557600080fd5b50600160a060020a038135169060200135610811565b34801561039757600080fd5b506101156108a6565b3480156103ac57600080fd5b5061031d600480360360208110156103c357600080fd5b5035600160a060020a0316610906565b3480156103df57600080fd5b5061031d610996565b3480156103f457600080fd5b506101c36004803603604081101561040b57600080fd5b50600160a060020a0381351690602001356109a8565b34801561042d57600080fd5b506101c36004803603604081101561044457600080fd5b50600160a060020a038135169060200135610a5a565b34801561046657600080fd5b506101c36004803603602081101561047d57600080fd5b5035600160a060020a0316610a6e565b34801561049957600080fd5b506101ec600480360360408110156104b057600080fd5b50600160a060020a0381358116916020013516610a87565b60008054604080516020601f60026000196101006001881615020190951694909404938401819004810282018101909252828152606093909290918301828280156105545780601f1061052957610100808354040283529160200191610554565b820191906000526020600020905b81548152906001019060200180831161053757829003601f168201915b5050505050905090565b600061057261056b610ab2565b8484610ab6565b50600192915050565b60055490565b600061058e848484610c23565b6106568461059a610ab2565b61065185606060405190810160405280602881526020017f45524332303a207472616e7366657220616d6f756e742065786365656473206181526020017f6c6c6f77616e6365000000000000000000000000000000000000000000000000815250600460008b600160a060020a0316600160a060020a03168152602001908152602001600020600061062a610ab2565b600160a060020a03168152602081019190915260400160002054919063ffffffff610e4716565b610ab6565b5060019392505050565b60025460ff1690565b60075490565b600061057261067c610ab2565b84610651856004600061068d610ab2565b600160a060020a03908116825260208083019390935260409182016000908120918c16815292529020549063ffffffff610ee116565b60006106d56106d0610ab2565b610a6e565b1515610751576040805160e560020a62461bcd02815260206004820152603060248201527f4d696e746572526f6c653a2063616c6c657220646f6573206e6f74206861766560448201527f20746865204d696e74657220726f6c6500000000000000000000000000000000606482015290519081900360840190fd5b6105728383610f45565b6107666106d0610ab2565b15156107e2576040805160e560020a62461bcd02815260206004820152603060248201527f4d696e746572526f6c653a2063616c6c657220646f6573206e6f74206861766560448201527f20746865204d696e74657220726f6c6500000000000000000000000000000000606482015290519081900360840190fd5b6107f36107ed610ab2565b82610fc0565b50565b600160a060020a031660009081526003602052604090205490565b61081c6106d0610ab2565b1515610898576040805160e560020a62461bcd02815260206004820152603060248201527f4d696e746572526f6c653a2063616c6c657220646f6573206e6f74206861766560448201527f20746865204d696e74657220726f6c6500000000000000000000000000000000606482015290519081900360840190fd5b6108a28282611141565b5050565b60018054604080516020601f600260001961010087891615020190951694909404938401819004810282018101909252828152606093909290918301828280156105545780601f1061052957610100808354040283529160200191610554565b6109116106d0610ab2565b151561098d576040805160e560020a62461bcd02815260206004820152603060248201527f4d696e746572526f6c653a2063616c6c657220646f6573206e6f74206861766560448201527f20746865204d696e74657220726f6c6500000000000000000000000000000000606482015290519081900360840190fd5b6107f3816111e7565b6109a66109a1610ab2565b61122f565b565b60006105726109b5610ab2565b8461065185606060405190810160405280602581526020017f45524332303a2064656372656173656420616c6c6f77616e63652062656c6f7781526020017f207a65726f00000000000000000000000000000000000000000000000000000081525060046000610a23610ab2565b600160a060020a03908116825260208083019390935260409182016000908120918d1681529252902054919063ffffffff610e4716565b6000610572610a67610ab2565b8484610c23565b6000610a8160068363ffffffff61127716565b92915050565b600160a060020a03918216600090815260046020908152604080832093909416825291909152205490565b3390565b600160a060020a0383161515610b3b576040805160e560020a62461bcd028152602060048201526024808201527f45524332303a20617070726f76652066726f6d20746865207a65726f2061646460448201527f7265737300000000000000000000000000000000000000000000000000000000606482015290519081900360840190fd5b600160a060020a0382161515610bc1576040805160e560020a62461bcd02815260206004820152602260248201527f45524332303a20617070726f766520746f20746865207a65726f20616464726560448201527f7373000000000000000000000000000000000000000000000000000000000000606482015290519081900360840190fd5b600160a060020a03808416600081815260046020908152604080832094871680845294825291829020859055815185815291517f8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b9259281900390910190a3505050565b600160a060020a0383161515610ca9576040805160e560020a62461bcd02815260206004820152602560248201527f45524332303a207472616e736665722066726f6d20746865207a65726f20616460448201527f6472657373000000000000000000000000000000000000000000000000000000606482015290519081900360840190fd5b600160a060020a0382161515610d2f576040805160e560020a62461bcd02815260206004820152602360248201527f45524332303a207472616e7366657220746f20746865207a65726f206164647260448201527f6573730000000000000000000000000000000000000000000000000000000000606482015290519081900360840190fd5b60408051606081018252602681527f45524332303a207472616e7366657220616d6f756e74206578636565647320626020808301919091527f616c616e6365000000000000000000000000000000000000000000000000000082840152600160a060020a038616600090815260039091529190912054610db691839063ffffffff610e4716565b600160a060020a038085166000908152600360205260408082209390935590841681522054610deb908263ffffffff610ee116565b600160a060020a0380841660008181526003602090815260409182902094909455805185815290519193928716927fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef92918290030190a3505050565b60008184841115610ed95760405160e560020a62461bcd0281526004018080602001828103825283818151815260200191508051906020019080838360005b83811015610e9e578181015183820152602001610e86565b50505050905090810190601f168015610ecb5780820380516001836020036101000a031916815260200191505b509250505060405180910390fd5b505050900390565b600082820183811015610f3e576040805160e560020a62461bcd02815260206004820152601b60248201527f536166654d6174683a206164646974696f6e206f766572666c6f770000000000604482015290519081900360640190fd5b9392505050565b600754610f6082610f5461057b565b9063ffffffff610ee116565b1115610fb6576040805160e560020a62461bcd02815260206004820152601960248201527f45524332304361707065643a2063617020657863656564656400000000000000604482015290519081900360640190fd5b6108a2828261131f565b600160a060020a0382161515611046576040805160e560020a62461bcd02815260206004820152602160248201527f45524332303a206275726e2066726f6d20746865207a65726f2061646472657360448201527f7300000000000000000000000000000000000000000000000000000000000000606482015290519081900360840190fd5b60408051606081018252602281527f45524332303a206275726e20616d6f756e7420657863656564732062616c616e6020808301919091527f636500000000000000000000000000000000000000000000000000000000000082840152600160a060020a0385166000908152600390915291909120546110cd91839063ffffffff610e4716565b600160a060020a0383166000908152600360205260409020556005546110f9908263ffffffff61141616565b600555604080518281529051600091600160a060020a038516917fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef9181900360200190a35050565b61114b8282610fc0565b6108a282611157610ab2565b61065184606060405190810160405280602481526020017f45524332303a206275726e20616d6f756e74206578636565647320616c6c6f7781526020017f616e6365000000000000000000000000000000000000000000000000000000008152506004600089600160a060020a0316600160a060020a03168152602001908152602001600020600061062a610ab2565b6111f860068263ffffffff61145816565b604051600160a060020a038216907f6ae172837ea30b801fbfcdd4108aa1d5bf8ff775444fd70256b44e6bf3dfc3f690600090a250565b61124060068263ffffffff6114dc16565b604051600160a060020a038216907fe94479a9f7e1952cc78f2d6baab678adc1b772d936c6583def489e524cb6669290600090a250565b6000600160a060020a03821615156112ff576040805160e560020a62461bcd02815260206004820152602260248201527f526f6c65733a206163636f756e7420697320746865207a65726f20616464726560448201527f7373000000000000000000000000000000000000000000000000000000000000606482015290519081900360840190fd5b50600160a060020a03166000908152602091909152604090205460ff1690565b600160a060020a038216151561137f576040805160e560020a62461bcd02815260206004820152601f60248201527f45524332303a206d696e7420746f20746865207a65726f206164647265737300604482015290519081900360640190fd5b600554611392908263ffffffff610ee116565b600555600160a060020a0382166000908152600360205260409020546113be908263ffffffff610ee116565b600160a060020a03831660008181526003602090815260408083209490945583518581529351929391927fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef9281900390910190a35050565b6000610f3e83836040805190810160405280601e81526020017f536166654d6174683a207375627472616374696f6e206f766572666c6f770000815250610e47565b6114628282611277565b156114b7576040805160e560020a62461bcd02815260206004820152601f60248201527f526f6c65733a206163636f756e7420616c72656164792068617320726f6c6500604482015290519081900360640190fd5b600160a060020a0316600090815260209190915260409020805460ff19166001179055565b6114e68282611277565b1515611562576040805160e560020a62461bcd02815260206004820152602160248201527f526f6c65733a206163636f756e7420646f6573206e6f74206861766520726f6c60448201527f6500000000000000000000000000000000000000000000000000000000000000606482015290519081900360840190fd5b600160a060020a0316600090815260209190915260409020805460ff1916905556fea165627a7a72305820f3ccb9c3a7fce0e9a355f437aa5db3828f263d44cea2728d65969d3288f818cb0029',
    address: '0x2aC3c1d3e24b45c6C310534Bc2Dd84B5ed576335',
    block: 4224739,
    url: 'https://goerli.etherscan.io/address/0x2ac3c1d3e24b45c6c310534bc2dd84b5ed576335',
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
