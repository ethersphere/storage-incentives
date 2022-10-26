import { ethers } from 'hardhat';
import { keccak256 } from '@ethersproject/keccak256';
import { arrayify, hexlify } from '@ethersproject/bytes';

function computeBatchId(sender: string, nonce: string): string {
  const abi = new ethers.utils.AbiCoder();
  const encoded = abi.encode(['address', 'bytes32'], [sender, nonce]);
  return ethers.utils.keccak256(encoded);
}

async function mineNBlocks(n: number) {
  for (let index = 0; index < n; index++) {
    await ethers.provider.send('evm_mine', []);
  }
}

async function getBlockNumber() {
  const blockNumber = await ethers.provider.send('eth_blockNumber', []);
  return parseInt(blockNumber);
}

async function setPrevRandDAO(randVal:string) {
  await ethers.provider.send('hardhat_setPrevRandao', [randVal]);
}

async function mintAndApprove(deployer: string, payee: string, beneficiary: string, transferAmount: string) {
  const minterTokenInstance = await ethers.getContract('TestToken', deployer);
  await minterTokenInstance.mint(payee, transferAmount);
  const payeeTokenInstance = await ethers.getContract('TestToken', payee);
  await payeeTokenInstance.approve(beneficiary, transferAmount);
}

function encodeAndHash(overlay_1: string, depth_1: string, hash_1: string, reveal_nonce_1: string) {
  const encoded = new Uint8Array(97);
  encoded.set(arrayify(overlay_1));
  encoded.set(arrayify(depth_1), 32);
  encoded.set(arrayify(hash_1), 33);
  encoded.set(arrayify(reveal_nonce_1), 65);
  return keccak256(hexlify(encoded));
}

//dev purposes only
async function createOverlay(address: string, networkID: string, nonce: string) {
  const encoded = new Uint8Array(60);
  encoded.set(arrayify(address));
  encoded.set(arrayify(networkID).reverse(), 20);
  encoded.set(arrayify(nonce), 28);
  return keccak256(hexlify(encoded));
}

function hexToBinaryArray(h: string) {
  h = h.substring(2);
  const o = [];
  for (let i = 0; i < h.length; i++) {
    const byte = h.substring(i, i + 1);
    const binary = parseInt(byte, 16).toString(2).padStart(4, '0');
    for (let j = 0; j < binary.length; j++) {
      o.push(parseInt(binary[j]));
    }
  }
  return o;
}

function compareHexAsBinary(_a: string, _b: string, d: number) {
  const a = hexToBinaryArray(_a);
  const b = hexToBinaryArray(_b);
  const match = false;
  for (let i = 0; i < d; i++) {
    if (a[i] != b[i]) {
      return false;
    }
  }
  return true;
}

// example: mineOverlaysInDepth("0xac33", "0x00", 6, 10000);
async function mineOverlaysInDepth(prefix: string, nonce: string, networkID: string, depth: number, maxAttempts: number) {
  let found = false;
  let w, o;
  let i = 0;
  while (found == false) {
    w = ethers.Wallet.createRandom();
    o = await createOverlay(w.address, networkID, nonce);
    found = compareHexAsBinary(o, prefix.padEnd(66, '0'), depth);
    console.log(i, o.substring(0, 8), prefix.padEnd(66, '0').substring(0, 8));
    if (maxAttempts == i + 1) {
      console.log('failed with max attempts', maxAttempts);
      return;
    }
    i++;
  }
  if (w !== undefined) {
    console.log(`found in ${i} attempts`, 'o a p', o, w.address, w.privateKey);
  }
}

export {
  computeBatchId,
  mineNBlocks,
  getBlockNumber,
  setPrevRandDAO,
  mintAndApprove,
  encodeAndHash,
  createOverlay,
  hexToBinaryArray,
  compareHexAsBinary,
  mineOverlaysInDepth,
};
