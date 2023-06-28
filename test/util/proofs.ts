import { Chunk, getSpanValue, makeChunk, Utils as BmtUtils } from '@fairdatasociety/bmt-js';
import { BigNumber, Wallet } from 'ethers';
import { arrayify } from 'ethers/lib/utils';
import { constructPostageStamp } from './postage';
import { equalBytes, SEGMENT_BYTE_LENGTH, SEGMENT_COUNT_IN_CHUNK, WITNESS_COUNT } from './tools';

const { keccak256Hash } = BmtUtils;

/** Reserve estimation: max value for witnesses */
const SAMPLE_MAX_VALUE = BigNumber.from('1284401000000000000000000000000000000000000000000000000000000000000000000');
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
  chunkSpan: number;
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
  // sanity checks
  if (!equalBytes(proofWitnessChunk.ogChunk.address(), proveSegment)) {
    throw new Error(
      `Address of the OG witness chunk does not match the one in the sample at witness index ${witnessIndex}`
    );
  }
  if (!equalBytes(proofWitnessChunk.transformedChunk.address(), proofSegments[0])) {
    throw new Error(
      `Address of the transformed witness chunk does not match the one in the sample at witness index ${witnessIndex}`
    );
  }
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
  const chunkSpan = getSpanValue(proofWitnessChunk.ogChunk.span());
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

function calculateTransformedAddress(nonceBuf: Uint8Array, anchor: Uint8Array): Uint8Array {
  const chunk = makeChunk(nonceBuf, { hashFn: TransformedHashFn(anchor) });
  return chunk.address();
}

function TransformedHashFn(anchor: Uint8Array): (...messages: Message[]) => Uint8Array {
  return (...messages: Message[]) => keccak256Hash(anchor, ...messages);
}

export function mineWitness(anchor: Uint8Array, depth: number, startNonce = 0): WitnessData {
  let i = 0;
  while (true) {
    const nonce = i++ + startNonce;
    const nonceBuf = numberToArray(nonce);
    const transformedAddress = calculateTransformedAddress(nonceBuf, anchor);
    if (inProximity(transformedAddress, anchor, depth) && BigNumber.from(transformedAddress).lt(SAMPLE_MAX_VALUE)) {
      return { nonce, transformedAddress };
    }
  }
}

/**
 * Used function when new witnesses are required to be generated for tests.
 *
 * @param anchor used number around which the witnesses must be generated
 * @param depth how many leading bits must be equal between the transformed addresses and the anchor
 */
export function mineWitnesses(anchor: Uint8Array, depth: number): WitnessData[] {
  let witnessChunks: ReturnType<typeof mineWitness>[] = [];
  let startNonce = 0;
  for (let i = 0; i < WITNESS_COUNT; i++) {
    console.log('mine witness', i);
    const witness = mineWitness(anchor, depth, startNonce);
    witnessChunks.push(witness);
    startNonce = witness.nonce + 1;
  }
  // sort witness chunks to be descendant
  witnessChunks = witnessChunks.sort((a, b) => {
    const aBn = BigNumber.from(a.transformedAddress);
    const bBn = BigNumber.from(b.transformedAddress);
    if (aBn.lt(bBn)) {
      return -1;
    }
    if (bBn.lt(aBn)) {
      return 1;
    }
    return 0;
  });

  return witnessChunks;
}

export function makeSample(witnesses: WitnessData[], anchor: Uint8Array): Chunk {
  const payload = new Uint8Array(SEGMENT_BYTE_LENGTH * witnesses.length * 2);
  for (const [i, witness] of witnesses.entries()) {
    const originalChunk = makeChunk(numberToArray(witness.nonce));
    const transformedChunk = makeChunk(numberToArray(witness.nonce), { hashFn: TransformedHashFn(anchor) });
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
 * @returns serialized number in 32 bytes for chunk payload
 */
export function numberToArray(n: number): Uint8Array {
  const buff = Buffer.alloc(32);
  buff.writeUint32BE(n);

  return Uint8Array.from(buff);
}
