import { Chunk, makeChunk, Utils as BmtUtils } from '@fairdatasociety/bmt-js';
import { BigNumber, Wallet } from 'ethers';
import { arrayify } from 'ethers/lib/utils';
import { constructPostageStamp } from './postage';
import { SEGMENT_BYTE_LENGTH, SEGMENT_COUNT_IN_CHUNK } from './tools';
const { keccak256Hash } = BmtUtils;

type Message = BmtUtils.Message;
type WitnessData = {
  nonce: number;
  transformedAddress: Uint8Array;
};
type WitnessChunks = { ogChunk: Chunk; transformedChunk: Chunk };
type WitnessProof = {
  proofSegments: Uint8Array[];
  proveSegment: Uint8Array;
  proofSegments2: Uint8Array[];
  proveSegment2: Uint8Array;
  proofSegments3: Uint8Array[];
  chunkSpan: Uint8Array;
  signer: Uint8Array; // address of the uploader
  signature: Uint8Array;
  chunkAddr: Uint8Array; //chunk address that must be signed with postage stamp
  postageId: Uint8Array;
  index: Uint8Array;
  timeStamp: number;
  socProofAttached: [];
};

/**
 * Gives back the witness incides that must be proved at claim
 *
 * @param anchor random hex string after the first reveal
 * @returns indices of the witnesses for proving
 */
function witnessProofRequired(anchor: string | Uint8Array): number[] {
  const randomness = BigNumber.from(anchor);
  // rand(14)
  const x = randomness.mod(15);
  // rand(13)
  const y = randomness.mod(14);
  if (y >= x) {
    y.add(1);
  }

  return [x.toNumber(), y.toNumber()];
}

/** Returns required chunk objects of the given witness array for claim */
function getChunkObjectsForClaim(anchor1: Uint8Array, witnessesForProof: WitnessData[]): WitnessChunks[] {
  const hashFn = TransformedHashFn(anchor1);

  return witnessesForProof.map((w) => {
    const witnessPayload = numberToArray(w.nonce);
    return {
      ogChunk: makeChunk(witnessPayload),
      transformedChunk: makeChunk(witnessPayload, { hashFn }),
    };
  });
}

export async function getClaimProofs(
  witnesses: WitnessData[],
  sampleChunk: Chunk,
  anchor1: Uint8Array,
  anchor2: string | Uint8Array,
  postageWallet: Wallet,
  postageBatchId: string
) {
  const postageBatchIdBuffer = Buffer.from(arrayify(postageBatchId));
  const witnessIndices = witnessProofRequired(anchor2);
  const witnessesForProof = [
    witnesses[witnessIndices[0]],
    witnesses[witnessIndices[1]],
    witnesses[witnesses.length - 1],
  ];
  const proofWitnessChunks = getChunkObjectsForClaim(anchor1, witnessesForProof);
  const randomChunkSegmentIndex = BigNumber.from(anchor2).mod(SEGMENT_COUNT_IN_CHUNK).toNumber();
  const proof1 = await getClaimProof(
    proofWitnessChunks[0],
    witnessIndices[0],
    sampleChunk,
    postageWallet,
    postageBatchIdBuffer,
    randomChunkSegmentIndex
  );
  const proof2 = await getClaimProof(
    proofWitnessChunks[1],
    witnessIndices[1],
    sampleChunk,
    postageWallet,
    postageBatchIdBuffer,
    randomChunkSegmentIndex
  );
  const proofLast = await getClaimProof(
    proofWitnessChunks[2],
    witnesses.length - 1,
    sampleChunk,
    postageWallet,
    postageBatchIdBuffer,
    randomChunkSegmentIndex
  );

  return {
    proofParams: { proof1, proof2, proofLast },
    witnessIndices,
    proofWitnessChunks,
  };
}

export async function getClaimProof(
  proofWitnessChunk: WitnessChunks,
  witnessIndex: number,
  sampleChunk: Chunk,
  postageWallet: Wallet,
  postageId: Buffer,
  randomChunkSegmentIndex: number
): Promise<WitnessProof> {
  // inclusion proof in reserve commitment for the chunk in question
  const proofSegments = sampleChunk.inclusionProof(witnessIndex * 2);
  const proveSegment = sampleChunk.payload.slice(
    witnessIndex * 2 * SEGMENT_BYTE_LENGTH,
    witnessIndex * 2 * SEGMENT_BYTE_LENGTH + SEGMENT_BYTE_LENGTH
  );
  // inclusion proof in OG chunk
  const proofSegments2 = proofWitnessChunk.ogChunk.inclusionProof(randomChunkSegmentIndex);
  const proveSegment2 = proofWitnessChunk.ogChunk
    .data()
    .slice(
      randomChunkSegmentIndex * SEGMENT_BYTE_LENGTH,
      randomChunkSegmentIndex * SEGMENT_BYTE_LENGTH + SEGMENT_BYTE_LENGTH
    );
  // inclusion proof in transformed chunk
  const proofSegments3 = proofWitnessChunk.transformedChunk.inclusionProof(randomChunkSegmentIndex);
  const chunkSpan = proofWitnessChunk.ogChunk.span();
  // TODO generate postage stamp data
  const chunkAddr = Buffer.from(proveSegment);
  const timeStamp = Math.round(new Date('1993-12-09T00:00:00').getTime() / 1000); // milisec to sec
  // creating postage signature and index
  const { index, signature } = await constructPostageStamp(postageId, chunkAddr, postageWallet, timeStamp);

  return {
    proofSegments,
    proveSegment,
    proofSegments2,
    proveSegment2,
    proofSegments3,
    chunkSpan,
    signer: arrayify(postageWallet.address),
    signature,
    chunkAddr,
    postageId,
    index,
    timeStamp,
    socProofAttached: [],
  };
}

function calculateTransformedAddress(nonceBuf: Buffer, anchor: Uint8Array): Uint8Array {
  const chunk = makeChunk(nonceBuf, { hashFn: TransformedHashFn(anchor) });
  return chunk.address();
}

function TransformedHashFn(anchor: Uint8Array): (...messages: Message[]) => Uint8Array {
  return (...messages: Message[]) => keccak256Hash(anchor, ...messages);
}

export function mineWitness(anchor: Uint8Array, depth: number, startNonce = 0, maxAttempts = 10000): WitnessData {
  let i = 0;
  const nonceBuf = Buffer.alloc(32);
  while (true) {
    const nonce = i + startNonce;
    nonceBuf.writeUint32BE(nonce);
    const transformedAddress = calculateTransformedAddress(nonceBuf, anchor);
    if (inProximity(transformedAddress, anchor, depth)) {
      return { nonce, transformedAddress };
    }

    if (maxAttempts == i + 1) {
      throw new Error(`failed with max ${maxAttempts} attempts`);
    }
    i += 1;
  }
}

export function makeSample(witnesses: WitnessData[], anchor: Uint8Array): Chunk {
  const payload = new Uint8Array(SEGMENT_BYTE_LENGTH * witnesses.length * 2);
  for (const [i, witness] of witnesses.entries()) {
    const originalChunk = makeChunk(new Uint8Array([witness.nonce]));
    const transformedChunk = makeChunk(new Uint8Array([witness.nonce]), { hashFn: TransformedHashFn(anchor) });
    const payloadOffset = i * SEGMENT_BYTE_LENGTH * 2;
    payload.set(originalChunk.address(), payloadOffset);
    payload.set(transformedChunk.address(), payloadOffset + SEGMENT_BYTE_LENGTH);
  }

  return makeChunk(payload);
}

/**
 * @notice Returns true if the segment A is within proximity order minimum of B
 * @param a 32 bytes.
 * @param b 32 bytes.
 * @param minimum Minimum proximity order.
 */
function inProximity(a: Uint8Array, b: Uint8Array, minimum: number): boolean {
  if (a.length !== b.length || a.length !== 32) throw new Error('Lengths are incorrect at proximity check');

  let byteIndex = 0;
  let remaningBits = minimum;
  while (remaningBits > 0) {
    if (remaningBits >= 8) {
      if (a[byteIndex] !== b[byteIndex]) return false;
      byteIndex++;
      remaningBits -= 8;
    } else {
      const aBits = a[byteIndex] >>> (8 - remaningBits);
      const bBits = b[byteIndex] >>> (8 - remaningBits);
      return aBits === bBits;
    }
  }

  return true; // minimum === 0
}

/**
 * Number to byte array conversion mostly for mining chunks
 *
 * @param n number to be serialized (max uint32)
 * @returns serialized number for chunk payload
 */
export function numberToArray(n: number): Uint8Array {
  const buff = Buffer.alloc(32);
  buff.writeUint32BE(n);

  return Uint8Array.from(buff);
}
