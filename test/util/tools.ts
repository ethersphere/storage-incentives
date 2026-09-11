import { ethers } from 'hardhat';
import { keccak256 } from '@ethersproject/keccak256';
import { ContractTransaction } from 'ethers';
import { arrayify, hexlify } from '@ethersproject/bytes';
import { BigNumber, Wallet } from 'ethers';
import { Utils as BmtUtils } from '@fairdatasociety/bmt-js';

export const equalBytes = BmtUtils.equalBytes;

export const ZERO_32_BYTES = '0x' + '0'.repeat(64);
export const PHASE_LENGTH = 38;
export const ROUND_LENGTH = 152;
export const WITNESS_COUNT = 16;
export const SEGMENT_COUNT_IN_CHUNK = 128;
export const SEGMENT_BYTE_LENGTH = 32;
const zeroAddress = '0x0000000000000000000000000000000000000000';

type AwaitedTransaction = ContractTransaction & {
  blockNumber: number;
};

/** returns byte representation of the hex string */
export function hexToBytes(hex: string): Uint8Array {
  if (hex.startsWith('0x')) {
    hex = hex.slice(2);
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    const hexByte = hex.substr(i * 2, 2);
    bytes[i] = parseInt(hexByte, 16);
  }

  return bytes;
}

/** returns the Proximity Order of the two hex strings */
export function proximity(hexA: string, hexB: string): number {
  const one = hexToBytes(hexA);
  const other = hexToBytes(hexB);

  const b = one.length < other.length ? one.length : other.length;
  const m = 8;
  for (let i = 0; i < b; i++) {
    const oxo = one[i] ^ other[i];
    for (let j = 0; j < m; j++) {
      if (((oxo >> (7 - j)) & 0x01) != 0) {
        return i * 8 + j;
      }
    }
  }
  return b * 8;
}

function computeBatchId(sender: string, nonce: string): string {
  const abi = new ethers.utils.AbiCoder();
  const encoded = abi.encode(['address', 'bytes32'], [sender, nonce]);
  return ethers.utils.keccak256(encoded);
}

async function mineNBlocks(n: number): Promise<undefined> {
  for (let index = 0; index < n; index++) {
    await ethers.provider.send('evm_mine', []);
  }
  return;
}

/**
 * Attempts to mine overlays to match the given prefix up to a certain depth.
 *
 * @async
 * @function
 * @param {string} prefix -First N bytes of anchor hash to match with overlay hash per depth. E.g. depth 6 is first 6 bits of Anchor which is 0xfc
 * @param {string} nonce - The nonce of the overlay to match.
 * @param {string} networkID - The networkID of the overlay to match.
 * @param {number} depth - Number of bits to match.
 * @param {number} maxAttempts - Maximum number of attempts to find a match.
 * @returns {Promise<undefined>} Resolves when a match is found or maximum attempts are reached.
 * @example
 * mineOverlaysInDepth("0xa92b32", "0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33", "0x00", 6, 10000);
 */
async function mineOverlaysInDepth(
  prefix: string,
  nonce: string,
  networkID: string,
  depth: number,
  maxAttempts: number
): Promise<undefined> {
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
    return;
  }
}

async function skippedRoundsIncrease(
  skippedRounds: number,
  currentPriceUpScaled: number,
  priceBase: number,
  maxIncreaseRate: number
): Promise<number> {
  for (let index = 0; index < skippedRounds; index++) {
    currentPriceUpScaled = (maxIncreaseRate * currentPriceUpScaled) / priceBase;
  }

  return currentPriceUpScaled >> 10;
}

async function getBlockNumber(): Promise<number> {
  const blockNumber = await ethers.provider.send('eth_blockNumber', []);
  return parseInt(blockNumber);
}

async function mintAndApprove(
  deployer: string,
  payee: string,
  beneficiary: string,
  transferAmount: string
): Promise<undefined> {
  const minterTokenInstance = await ethers.getContract('TestToken', deployer);
  await minterTokenInstance.mint(payee, transferAmount);
  const payeeTokenInstance = await ethers.getContract('TestToken', payee);
  await payeeTokenInstance.approve(beneficiary, transferAmount);
  return;
}

/**
 * SWIP-050 stage one commitment pre-image: the round binding stops a commitment prepared for one
 * round being opened in another, and chunkTransformRoot is fixed here, while the stamp anchor and
 * proof seed are still unknown.
 */
function encodeAndHash(
  commitRound: number,
  overlay_1: string,
  depth_1: string,
  hash_1: string,
  chunkTransformRoot: string,
  reveal_nonce_1: string
): string {
  const encoded = new Uint8Array(137);
  const roundBuf = Buffer.alloc(8);
  roundBuf.writeUInt32BE(Math.floor(commitRound / 2 ** 32), 0);
  roundBuf.writeUInt32BE(commitRound >>> 0, 4);
  encoded.set(roundBuf, 0);
  encoded.set(arrayify(overlay_1), 8);
  encoded.set(arrayify(depth_1), 40);
  encoded.set(arrayify(hash_1), 41);
  encoded.set(arrayify(chunkTransformRoot), 73);
  encoded.set(arrayify(reveal_nonce_1), 105);
  return keccak256(hexlify(encoded));
}

/**
 * SWIP-050 stage two commitment pre-image. It does not recommit the depth, chunk sample hash or
 * chunk transform root: those were fixed by stage one and are read from the stored reveal.
 */
function encodeAndHashStampCommit(
  commitRound: number,
  overlay_1: string,
  stampSampleHash: string,
  reveal_nonce_1: string
): string {
  const encoded = new Uint8Array(104);
  const roundBuf = Buffer.alloc(8);
  roundBuf.writeUInt32BE(Math.floor(commitRound / 2 ** 32), 0);
  roundBuf.writeUInt32BE(commitRound >>> 0, 4);
  encoded.set(roundBuf, 0);
  encoded.set(arrayify(overlay_1), 8);
  encoded.set(arrayify(stampSampleHash), 40);
  encoded.set(arrayify(reveal_nonce_1), 72);
  return keccak256(hexlify(encoded));
}

// SWIP-050 six phase schedule, inclusive start offsets within a 152 block round.
const STS_PHASES = {
  chunkCommit: 0,
  chunkReveal: 38,
  stampCommit: 57,
  stampReveal: 95,
  proof: 114,
  claim: 133,
};

/**
 * Mine until the current block sits exactly on the given phase boundary of this round.
 * Views then read that phase, and a transaction sent next lands one block in, which is still
 * inside it: the shortest SWIP-050 phase is 19 blocks.
 */
async function mineToPhase(offset: number): Promise<void> {
  const current = await getBlockNumber();
  const within = current % ROUND_LENGTH;
  const target = offset === 0 ? ROUND_LENGTH : offset;
  if (within >= target && offset !== 0) {
    throw new Error(`phase offset ${offset} already passed in this round (at ${within})`);
  }
  await mineNBlocks(target - within);
}

//dev purposes only
function createOverlay(address: string, networkID: string, nonce: string): string {
  const encoded = new Uint8Array(60);
  encoded.set(arrayify(address));
  encoded.set(arrayify(networkID).reverse(), 20);
  encoded.set(arrayify(nonce), 28);
  return keccak256(hexlify(encoded));
}

function hexToBinaryArray(h: string): number[] {
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

function compareHexAsBinary(_a: string, _b: string, d: number): boolean {
  const a = hexToBinaryArray(_a);
  const b = hexToBinaryArray(_b);
  for (let i = 0; i < d; i++) {
    if (a[i] != b[i]) {
      return false;
    }
  }
  return true;
}

/**
 * checks whether there is enough blocks for the 1st phase and if not it mines blocks until the next round
 *
 * @param txNo how many transactions needs to be executed in the 1st phase (e.g. commits)
 */
export async function startRoundFixture(txNo = 0) {
  const currentBlockNumber = await getBlockNumber();
  const roundBlocks = currentBlockNumber % ROUND_LENGTH;
  // 1 is for the last block of the phase is forbidden
  if (roundBlocks >= PHASE_LENGTH - txNo - 1) {
    await mineNBlocks(ROUND_LENGTH - roundBlocks); // beginning of the round
  }
}

export function calculateStakeDensity(stake: string, depth: number): string {
  return ethers.BigNumber.from(stake)
    .mul(ethers.BigNumber.from(2).pow(ethers.BigNumber.from(depth)))
    .toString();
}

/**
 * checks whether there is enough blocks for the 1st phase and if not it mines blocks until the next round
 */
export async function mineToRevealPhase() {
  const currentBlockNumber = await getBlockNumber();
  const roundBlocks = currentBlockNumber % ROUND_LENGTH;
  // 1 is for the last block of the phase is forbidden
  if (roundBlocks >= PHASE_LENGTH - 1) {
    await mineNBlocks(ROUND_LENGTH - roundBlocks); // beginning of the round
  } else {
    await mineNBlocks(PHASE_LENGTH - roundBlocks);
  }
}

/**
 * copies batch used for creating fixtures onto the blockchain
 */
export async function copyBatchForClaim(
  deployer: string,
  batchId: string
): Promise<{
  tx: AwaitedTransaction;
  postageDepth: number;
  initialBalance: number;
  batchId: string;
  batchOwner: Wallet;
}> {
  // migrate batch with which the chunk was signed
  const postageAdmin = await ethers.getContract('PostageStamp', deployer);
  // set minimum required blocks for postage stamp lifetime to 0 for tests

  await postageAdmin.setMinimumValidityBlocks(912);
  const initialBalance = 100_000_000;
  const postageDepth = 27;
  const bzzFund = BigNumber.from(initialBalance).mul(BigNumber.from(2).pow(postageDepth));
  await mintAndApprove(deployer, deployer, postageAdmin.address, bzzFund.toString());
  const batchOwner = getWalletOfFdpPlayQueen();

  const tx = await postageAdmin.copyBatch(
    batchOwner.address, // batch owner
    initialBalance, // initial balance per chunk
    postageDepth, // depth
    16, // bucketdepth
    batchId,
    true // immutable
  );
  await tx.wait();

  return {
    tx,
    postageDepth,
    initialBalance,
    batchId,
    batchOwner,
  };
}
export function nextAnchorIfNoReveal(previousAnchor: string, difference = 1): string {
  const differenceString = '0x' + (difference - 1).toString(16).padStart(64, '0');
  const currentAnchor = ethers.utils.keccak256(
    new Uint8Array([...ethers.utils.arrayify(previousAnchor), ...ethers.utils.arrayify(differenceString)])
  );

  return currentAnchor;
}

/**
 * Returns the wallet object of FDP Play - queen bee node
 * Can be used for sign migrated Chunks
 */
export function getWalletOfFdpPlayQueen(): Wallet {
  return new Wallet('0x566058308ad5fa3888173c741a1fb902c9f1f19559b11fc2738dfc53637ce4e9');
}

export {
  STS_PHASES,
  mineToPhase,
  encodeAndHashStampCommit,
  zeroAddress,
  computeBatchId,
  mineNBlocks,
  getBlockNumber,
  mintAndApprove,
  encodeAndHash,
  createOverlay,
  hexToBinaryArray,
  compareHexAsBinary,
  mineOverlaysInDepth,
  skippedRoundsIncrease,
};
