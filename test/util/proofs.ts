import { Chunk, getSpanValue, makeChunk, Utils as BmtUtils } from '@fairdatasociety/bmt-js';
import { BigNumber, Wallet } from 'ethers';
import { arrayify, hexlify } from 'ethers/lib/utils';
import { constructPostageStamp } from './postage';
import { equalBytes, SEGMENT_BYTE_LENGTH, SEGMENT_COUNT_IN_CHUNK, WITNESS_COUNT } from './tools';
import fs from 'fs';
import path from 'path';
import { ethers } from 'hardhat';
import { randomBytes } from 'crypto';

const { keccak256Hash } = BmtUtils;

/** Reserve estimation: max value for witnesses */
const SAMPLE_MAX_VALUE = BigNumber.from('1284401000000000000000000000000000000000000000000000000000000000000000000');
type Message = BmtUtils.Message;
type WitnessData = {
  nonce: number;
  transformedAddress: Uint8Array;
  socProofAttached?: SocProofAttachment;
};
type WitnessDataStore = {
  nonce: number;
  transformedAddress: string;
  socProofAttached?: SocProofAttachmentStore;
};
type WitnessChunks = { ogChunk: Chunk; transformedChunk: Chunk; socProofAttached?: SocProofAttachment };
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
  socProofAttached: SocProofAttachment[];
};
type SocProofAttachment = {
  signer: string; // signer Ethereum address to check against
  signature: string;
  identifier: Uint8Array;
  chunkAddr: Uint8Array; // wrapped chunk address
};
type SocProofAttachmentStore = {
  signer: string;
  signature: string;
  identifier: string;
  chunkAddr: string;
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
  let y = randomness.mod(14);
  if (y.gte(x)) {
    y = y.add(1);
  }

  return [x.toNumber(), y.toNumber()];
}

/** Returns required chunk objects of the given witness array for claim */
function getChunkObjectsForClaim(anchor1: Uint8Array, witnessesForProof: WitnessData[]): WitnessChunks[] {
  const hashFn = transformedHashFn(anchor1);

  return witnessesForProof.map((w) => {
    const witnessPayload = numberToArray(w.nonce);
    return {
      ogChunk: makeChunk(witnessPayload),
      transformedChunk: makeChunk(witnessPayload, { hashFn }),
      socProofAttached: w.socProofAttached,
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
  const ogAddress = proofWitnessChunk.socProofAttached
    ? calculateSocAddress(
        proofWitnessChunk.socProofAttached.identifier,
        arrayify(proofWitnessChunk.socProofAttached.signer)
      )
    : proofWitnessChunk.ogChunk.address();
  // sanity checks
  if (!equalBytes(ogAddress, proveSegment)) {
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
  // attached postage stamp data
  const chunkSpan = getSpanValue(proofWitnessChunk.ogChunk.span());
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
    socProofAttached: proofWitnessChunk.socProofAttached ? [proofWitnessChunk.socProofAttached] : [],
  };
}

export async function getSocProofAttachment(
  chunkAddr: Uint8Array,
  anchor: Uint8Array,
  depth: number
): Promise<SocProofAttachment> {
  let identifier: Uint8Array;
  const randomWallet = ethers.Wallet.createRandom();
  const owner = arrayify(randomWallet.address);

  // mine SOC address until neighbourhood
  while (true) {
    identifier = Uint8Array.from(randomBytes(32));
    const socAddress = calculateSocAddress(identifier, owner);
    if (inProximity(socAddress, anchor, depth)) {
      break;
    }
  }

  const digest = keccak256Hash(identifier, chunkAddr);
  const signature = await randomWallet.signMessage(digest);
  const signer = randomWallet.address;

  return {
    chunkAddr,
    identifier,
    signature,
    signer,
  };
}

export function calculateTransformedAddress(nonceBuf: Uint8Array, anchor: Uint8Array): Uint8Array {
  const chunk = makeChunk(nonceBuf, { hashFn: transformedHashFn(anchor) });
  return chunk.address();
}

function transformedHashFn(anchor: Uint8Array): (...messages: Message[]) => Uint8Array {
  return (...messages: Message[]) => keccak256Hash(anchor, ...messages);
}

export function mineCacWitness(anchor: Uint8Array, depth: number, startNonce = 0): WitnessData {
  let i = 0;
  while (true) {
    const nonce = i++ + startNonce;
    const nonceBuf = numberToArray(nonce);
    const transformedAddress = calculateTransformedAddress(nonceBuf, anchor);
    if (tAddressAcceptance(makeChunk(nonceBuf).address(), transformedAddress, anchor, depth)) {
      return { nonce, transformedAddress };
    }
  }
}

export async function mineSocWitness(anchor: Uint8Array, depth: number, startNonce = 0): Promise<WitnessData> {
  const randomWallet = ethers.Wallet.createRandom();
  const owner = arrayify(randomWallet.address);
  let j = startNonce;
  let socAddress, identifier: Uint8Array;
  // mine SOC address until neighbourhood
  while (true) {
    identifier = numberToArray(j++);
    socAddress = calculateSocAddress(identifier, owner);
    if (inProximity(socAddress, anchor, depth)) {
      break;
    }
  }

  // mine SOC payload to transformed address
  let i = 0;
  while (true) {
    const nonce = i++;
    const nonceBuf = numberToArray(nonce);
    const transformedAddress = keccak256Hash(socAddress, calculateTransformedAddress(nonceBuf, anchor));
    if (reserveSizeEstimationAcceptance(transformedAddress)) {
      const chunkAddr = makeChunk(nonceBuf).address();
      const digest = keccak256Hash(identifier, chunkAddr);
      const signature = await randomWallet.signMessage(digest);
      const signer = randomWallet.address;

      return {
        nonce,
        transformedAddress,
        socProofAttached: {
          chunkAddr,
          identifier,
          signature,
          signer,
        },
      };
    }
  }
}

/**
 * Checks whether the mined address satisfies the condition of the Redistribution contract
 *
 * @param ogChunkAddress original chunk address for witness
 * @param transformedAddress transformed chunk address for witness
 * @param anchor1 random number in the Redistribution contract
 * @param depth storageDepth to satisfy
 * @returns address is accepted by the Redistribution contract at claim
 */
function tAddressAcceptance(
  ogChunkAddress: Uint8Array,
  transformedAddress: Uint8Array,
  anchor1: Uint8Array,
  depth: number
): boolean {
  return reserveSizeEstimationAcceptance(transformedAddress) && inProximity(ogChunkAddress, anchor1, depth);
}

function reserveSizeEstimationAcceptance(transformedAddress: Uint8Array) {
  return BigNumber.from(transformedAddress).lt(SAMPLE_MAX_VALUE);
}

/**
 * Used function when new witnesses are required to be generated for tests.
 *
 * @param anchor used number around which the witnesses must be generated
 * @param depth how many leading bits must be equal between the transformed addresses and the anchor
 * @param socType if true then the witnesses will be single owner chunks. Default: false
 */
export async function mineWitnesses(anchor: Uint8Array, depth: number, socType = false): Promise<WitnessData[]> {
  let witnessChunks: WitnessData[] = [];
  let startNonce = 0;
  for (let i = 0; i < WITNESS_COUNT; i++) {
    console.log('mine witness', i);
    const witness = socType
      ? await mineSocWitness(anchor, depth, startNonce)
      : mineCacWitness(anchor, depth, startNonce);
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

export function loadWitnesses(filename: string): WitnessData[] {
  const witnessDataStore: WitnessDataStore[] = JSON.parse(
    new TextDecoder().decode(fs.readFileSync(path.join(__dirname, '..', 'mined-witnesses', `${filename}.json`)))
  ) as WitnessDataStore[];

  return witnessDataStore.map((e) => {
    const witnessData: WitnessData = {
      transformedAddress: arrayify(e.transformedAddress),
      nonce: e.nonce,
    };
    if (e.socProofAttached) {
      witnessData.socProofAttached = {
        chunkAddr: arrayify(e.socProofAttached.chunkAddr),
        identifier: arrayify(e.socProofAttached.identifier),
        signature: e.socProofAttached.signature,
        signer: e.socProofAttached.signer,
      };
    }

    return witnessData;
  });
}

export function saveWitnesses(witnessChunks: WitnessData[], filename: string) {
  console.log('save witnesses');
  fs.writeFileSync(
    path.join(__dirname, '..', 'mined-witnesses', `${filename}.json`),
    JSON.stringify(
      witnessChunks.map((a) => {
        const witnessData: WitnessDataStore = { transformedAddress: hexlify(a.transformedAddress), nonce: a.nonce };
        if (a.socProofAttached) {
          witnessData.socProofAttached = {
            chunkAddr: hexlify(a.socProofAttached.chunkAddr),
            identifier: hexlify(a.socProofAttached.identifier),
            signature: a.socProofAttached.signature,
            signer: a.socProofAttached.signer,
          };
        }
      })
    )
  );
}

/**
 * Loads or mine witnesses in the given depth of anchor
 *
 * @param suffix filename suffix for the mined chunk data
 * @param anchor random number in the Redistribution
 * @param depth storage depth
 * @param socType if true then the witnesses will be single owner chunks. Default: false
 * @returns loaded or mined witnesses
 */
export async function setWitnesses(
  suffix: string,
  anchor: Uint8Array,
  depth: number,
  socType = false
): Promise<WitnessData[]> {
  try {
    return loadWitnesses(suffix);
  } catch (e) {
    const witnessChunks = await mineWitnesses(anchor, Number(depth), socType);
    saveWitnesses(witnessChunks, suffix);

    return witnessChunks;
  }
}

export function makeSample(witnesses: WitnessData[], anchor: Uint8Array): Chunk {
  const payload = new Uint8Array(SEGMENT_BYTE_LENGTH * witnesses.length * 2);
  for (const [i, witness] of witnesses.entries()) {
    const originalChunk = makeChunk(numberToArray(witness.nonce));
    const transformedChunk = makeChunk(numberToArray(witness.nonce), { hashFn: transformedHashFn(anchor) });
    const payloadOffset = i * SEGMENT_BYTE_LENGTH * 2;
    const originalAddress = witness.socProofAttached
      ? calculateSocAddress(witness.socProofAttached.identifier, arrayify(witness.socProofAttached.signer))
      : originalChunk.address();
    payload.set(originalAddress, payloadOffset);
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
export function inProximity(a: Uint8Array, b: Uint8Array, minimum: number): boolean {
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

/**
 * Calculate Single Owner Chunks from its elements
 *
 * @param identifier 32 bytes of arbitrary identifier
 * @param owner 20 bytes of ethereum address
 * @returns 32 bytes of Single Owner Chunk Address
 */
function calculateSocAddress(identifier: Uint8Array, owner: Uint8Array): Uint8Array {
  return keccak256Hash(identifier, owner);
}
