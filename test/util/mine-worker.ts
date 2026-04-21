import { parentPort, workerData } from 'worker_threads';
import { makeChunk, Utils as BmtUtils } from '@fairdatasociety/bmt-js';
import { BigNumber } from 'ethers';

const { keccak256Hash } = BmtUtils;
type Message = BmtUtils.Message;

const SAMPLE_MAX_VALUE = BigNumber.from(
  '1284401000000000000000000000000000000000000000000000000000000000000000000'
);

function numberToArray(n: number): Uint8Array {
  const buff = Buffer.alloc(32);
  buff.writeUint32BE(n);
  return Uint8Array.from(buff);
}

function transformedHashFn(anchor: Uint8Array): (...messages: Message[]) => Uint8Array {
  return (...messages: Message[]) => keccak256Hash(anchor, ...messages);
}

function calculateTransformedAddress(nonceBuf: Uint8Array, anchor: Uint8Array): Uint8Array {
  const chunk = makeChunk(nonceBuf, { hashFn: transformedHashFn(anchor) });
  return chunk.address();
}

function inProximity(a: Uint8Array, b: Uint8Array, minimum: number): boolean {
  let byteIndex = 0;
  let remainingBits = minimum;
  while (remainingBits > 0) {
    if (remainingBits >= 8) {
      if (a[byteIndex] !== b[byteIndex]) return false;
      byteIndex++;
      remainingBits -= 8;
    } else {
      const aBits = a[byteIndex] >>> (8 - remainingBits);
      const bBits = b[byteIndex] >>> (8 - remainingBits);
      return aBits === bBits;
    }
  }
  return true;
}

function reserveSizeEstimationAcceptance(transformedAddress: Uint8Array): boolean {
  return BigNumber.from(transformedAddress).lt(SAMPLE_MAX_VALUE);
}

function tAddressAcceptance(
  ogChunkAddress: Uint8Array,
  transformedAddress: Uint8Array,
  anchor: Uint8Array,
  depth: number
): boolean {
  return reserveSizeEstimationAcceptance(transformedAddress) && inProximity(ogChunkAddress, anchor, depth);
}

function mineCacWitness(
  anchor: Uint8Array,
  depth: number,
  startNonce: number
): { nonce: number; transformedAddress: string } {
  let i = 0;
  while (true) {
    const nonce = i++ + startNonce;
    const nonceBuf = numberToArray(nonce);
    const transformedAddress = calculateTransformedAddress(nonceBuf, anchor);
    if (tAddressAcceptance(makeChunk(nonceBuf).address(), transformedAddress, anchor, depth)) {
      return {
        nonce,
        transformedAddress: '0x' + Buffer.from(transformedAddress).toString('hex'),
      };
    }
  }
}

if (workerData) {
  const { anchor, depth, startNonce, witnessIndex } = workerData as {
    anchor: number[];
    depth: number;
    startNonce: number;
    witnessIndex: number;
  };

  const anchorBuf = new Uint8Array(anchor);
  const result = mineCacWitness(anchorBuf, depth, startNonce);
  parentPort?.postMessage({ witnessIndex, ...result });
}
