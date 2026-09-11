import { Chunk, getSpanValue, makeChunk, Utils as BmtUtils } from '@fairdatasociety/bmt-js';
import { BigNumber, Wallet } from 'ethers';
import { arrayify, hexlify, solidityKeccak256, keccak256, concat } from 'ethers/lib/utils';
import { createSignature } from './postage';

// Helpers for building SWIP-050 STS-1 round material in tests: the 16 entry stamp sample, the
// participant specific chunk transform root, and the per witness proofs that bind a stamp to a
// chunk the participant actually holds.

const { keccak256Hash } = BmtUtils;

export const SEGMENT_BYTES = 32;
export const STAMP_SAMPLE_SIZE = 16;
export const SEGMENTS_IN_CHUNK = 128;

/** transformedStampValue = keccak256(abi.encodePacked(stampAnchor, batchId, fullStampIndex)) */
export function transformedStampValue(stampAnchor: string, batchId: string, fullIndex: BigNumber): string {
  return solidityKeccak256(['bytes32', 'bytes32', 'uint64'], [stampAnchor, batchId, fullIndex]);
}

/** Pack a postage bucket and a within-bucket index into the signed uint64 stamp index. */
export function fullStampIndex(bucket: number, withinBucketIndex: number): BigNumber {
  return BigNumber.from(bucket).mul(BigNumber.from(2).pow(32)).add(withinBucketIndex);
}

export function fullStampIndexBuffer(bucket: number, withinBucketIndex: number): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32BE(bucket, 0);
  buffer.writeUInt32BE(withinBucketIndex, 4);
  return buffer;
}

/** Top `bucketDepth` bits of a chunk address, the batch bucket the chunk must be stamped in. */
export function addressToBucket(address: Uint8Array, bucketDepth: number): number {
  return Buffer.from(address).readUInt32BE(0) >>> (32 - bucketDepth);
}

/**
 * The committed stamp sample: 16 transformed stamp values as one 512 byte chunk. Its BMT chunk
 * address is the stampSampleHash, and inclusionProof(i) opens position i, which is exactly what
 * StsWitness verifies.
 */
export function makeStampSampleChunk(sortedValues: string[]): Chunk {
  if (sortedValues.length !== STAMP_SAMPLE_SIZE) {
    throw new Error(`stamp sample must hold ${STAMP_SAMPLE_SIZE} values, got ${sortedValues.length}`);
  }
  const payload = new Uint8Array(SEGMENT_BYTES * STAMP_SAMPLE_SIZE);
  sortedValues.forEach((value, i) => payload.set(arrayify(value), i * SEGMENT_BYTES));
  return makeChunk(payload);
}

/**
 * OpenZeppelin MerkleProof tree: pairs are hashed in sorted order, so the tree commits to a set
 * rather than to a list and carries no leaf index. Bee must build chunkTransformRoot the same
 * way. See docs/SWIP-49-50-SCRUTINY.md 2.9.
 */
export class SortedPairMerkleTree {
  private readonly layers: string[][] = [];
  private readonly index = new Map<string, number>();

  constructor(leaves: string[]) {
    if (leaves.length === 0) throw new Error('cannot build a tree with no leaves');
    // Leaves are held in canonical order so the root does not depend on the order they were
    // discovered in. STS-1 fixes chunkTransformRoot in stage one and only re-derives the stamp
    // indexes later, so the root has to be stable across that re-derivation.
    const ordered = [...leaves].sort((a, b) => (BigNumber.from(a).lt(BigNumber.from(b)) ? -1 : 1));
    ordered.forEach((leaf, i) => this.index.set(leaf.toLowerCase(), i));
    this.layers.push(ordered);
    while (this.layers[this.layers.length - 1].length > 1) {
      const previous = this.layers[this.layers.length - 1];
      const next: string[] = [];
      for (let i = 0; i < previous.length; i += 2) {
        next.push(i + 1 < previous.length ? hashPair(previous[i], previous[i + 1]) : previous[i]);
      }
      this.layers.push(next);
    }
  }

  get root(): string {
    return this.layers[this.layers.length - 1][0];
  }

  proofForLeaf(leaf: string): string[] {
    const leafIndex = this.index.get(leaf.toLowerCase());
    if (leafIndex === undefined) throw new Error(`leaf ${leaf} is not in this tree`);
    return this.proofFor(leafIndex);
  }

  proofFor(leafIndex: number): string[] {
    const proof: string[] = [];
    let index = leafIndex;
    for (let level = 0; level < this.layers.length - 1; level++) {
      const layer = this.layers[level];
      const siblingIndex = index % 2 === 0 ? index + 1 : index - 1;
      if (siblingIndex < layer.length) proof.push(layer[siblingIndex]);
      index = Math.floor(index / 2);
    }
    return proof;
  }
}

function hashPair(a: string, b: string): string {
  const [left, right] = BigNumber.from(a).lt(BigNumber.from(b)) ? [a, b] : [b, a];
  return keccak256(concat([left, right]));
}

/** First-anchor transformed address of a chunk, the leaf form used by chunkTransformRoot. */
export function transformedChunkAddress(payload: Uint8Array, roundAnchor: Uint8Array): Uint8Array {
  return makeChunk(payload, { hashFn: (...messages) => keccak256Hash(roundAnchor, ...messages) }).address();
}

/** The chunk segment each witness must open, as StsWitness derives it. */
export function stsChunkSegmentIndex(proofSeed: string, chunkAddress: string): number {
  const hash = solidityKeccak256(
    ['bytes32', 'bytes32', 'bytes32'],
    [proofSeed, chunkAddress, '0x' + Buffer.from('STS1_CHUNK_SEGMENT').toString('hex').padEnd(64, '0')]
  );
  return BigNumber.from(hash).mod(SEGMENTS_IN_CHUNK).toNumber();
}

export type StampEntry = {
  /** Chunk payload; the chunk itself is makeChunk(payload). */
  payload: Uint8Array;
  chunkAddress: string;
  bucket: number;
  withinBucketIndex: number;
  fullIndex: BigNumber;
  transformedStampValue: string;
  transformedChunkAddress: string;
};

/**
 * Build the 16 stamp entries a participant commits to for one round.
 *
 * Each entry is a real chunk inside the reported depth of the round anchor, stamped at a
 * within-bucket index chosen so its transformed stamp value falls under the sample ceiling.
 * Entries are returned sorted ascending by transformed stamp value, which is the order the
 * contract's local ordering check expects.
 */
export function buildStampSample(params: {
  roundAnchor: string;
  stampAnchor: string;
  batchId: string;
  batchDepth: number;
  bucketDepth: number;
  claimedDepth: number;
  sampleMaxValue: BigNumber;
  startNonce?: number;
}): StampEntry[] {
  const {
    roundAnchor,
    stampAnchor,
    batchId,
    batchDepth,
    bucketDepth,
    claimedDepth,
    sampleMaxValue,
    startNonce = 0,
  } = params;

  const anchorBytes = arrayify(roundAnchor);
  const slotsPerBucket = 2 ** (batchDepth - bucketDepth);
  const entries: StampEntry[] = [];
  const usedIndexes = new Set<string>();

  let nonce = startNonce;
  while (entries.length < STAMP_SAMPLE_SIZE) {
    const payload = numberToArray(nonce++);
    const chunk = makeChunk(payload);
    const address = chunk.address();

    // The stamped chunk must sit inside the reported depth of the round anchor.
    if (!inProximity(address, anchorBytes, claimedDepth)) continue;

    const bucket = addressToBucket(address, bucketDepth);

    // Find a free slot in this chunk's bucket whose transformed stamp value is dense enough to
    // be a usable sample entry.
    let found = false;
    for (let withinBucketIndex = 0; withinBucketIndex < slotsPerBucket; withinBucketIndex++) {
      const key = `${bucket}:${withinBucketIndex}`;
      if (usedIndexes.has(key)) continue;

      const fullIndex = fullStampIndex(bucket, withinBucketIndex);
      const value = transformedStampValue(stampAnchor, batchId, fullIndex);
      if (BigNumber.from(value).gte(sampleMaxValue)) continue;

      usedIndexes.add(key);
      entries.push({
        payload,
        chunkAddress: hexlify(address),
        bucket,
        withinBucketIndex,
        fullIndex,
        transformedStampValue: value,
        transformedChunkAddress: hexlify(transformedChunkAddress(payload, anchorBytes)),
      });
      found = true;
      break;
    }

    if (!found && nonce > startNonce + 200000) {
      throw new Error('could not build a dense enough stamp sample');
    }
  }

  entries.sort((a, b) =>
    BigNumber.from(a.transformedStampValue).lt(BigNumber.from(b.transformedStampValue)) ? -1 : 1
  );
  return entries;
}

/**
 * Assemble the StampProof calldata for one opened sample position.
 */
export async function buildStampProof(params: {
  entries: StampEntry[];
  sampleChunk: Chunk;
  sampleIndex: number;
  roundAnchor: string;
  proofSeed: string;
  batchId: string;
  batchOwner: Wallet;
  transformTree: SortedPairMerkleTree;
  timeStamp?: number;
}) {
  const { entries, sampleChunk, sampleIndex, roundAnchor, proofSeed, batchId, batchOwner, transformTree } = params;
  const entry = entries[sampleIndex];
  const timeStamp = params.timeStamp ?? Math.round(new Date('1993-12-09T00:00:00').getTime() / 1000);

  const indexBuffer = fullStampIndexBuffer(entry.bucket, entry.withinBucketIndex);
  const signature = await createSignature(
    Buffer.from(arrayify(entry.chunkAddress)),
    batchOwner,
    Buffer.from(arrayify(batchId)),
    indexBuffer,
    timeStamp
  );

  const segmentIndex = stsChunkSegmentIndex(proofSeed, entry.chunkAddress);
  const ogChunk = makeChunk(entry.payload);
  const trChunk = makeChunk(entry.payload, {
    hashFn: (...messages) => keccak256Hash(arrayify(roundAnchor), ...messages),
  });

  const hasLeft = sampleIndex > 0;
  const hasRight = sampleIndex + 1 < STAMP_SAMPLE_SIZE;

  return {
    proofSegments: sampleChunk.inclusionProof(sampleIndex).map((segment) => hexlify(segment)),
    leftValue: hasLeft ? entries[sampleIndex - 1].transformedStampValue : ZERO32,
    leftProofSegments: hasLeft ? sampleChunk.inclusionProof(sampleIndex - 1).map((segment) => hexlify(segment)) : [],
    rightValue: hasRight ? entries[sampleIndex + 1].transformedStampValue : ZERO32,
    rightProofSegments: hasRight ? sampleChunk.inclusionProof(sampleIndex + 1).map((segment) => hexlify(segment)) : [],
    hasLeftValue: hasLeft,
    hasRightValue: hasRight,
    sampleIndex,
    chunkAddress: entry.chunkAddress,
    postageId: batchId,
    index: hexlify(indexBuffer),
    timeStamp,
    signature: hexlify(signature),
    chunkProof: {
      proveSegment: entry.chunkAddress,
      proofSegments2: ogChunk.inclusionProof(segmentIndex).map((segment) => hexlify(segment)),
      proveSegment2: hexlify(
        ogChunk.data().slice(segmentIndex * SEGMENT_BYTES, segmentIndex * SEGMENT_BYTES + SEGMENT_BYTES)
      ),
      chunkSpan: getSpanValue(ogChunk.span()),
      proofSegments3: trChunk.inclusionProof(segmentIndex).map((segment) => hexlify(segment)),
      socProof: [],
    },
    chunkTransformProofSegments: transformTree.proofForLeaf(entry.transformedChunkAddress),
  };
}

export const ZERO32 = '0x0000000000000000000000000000000000000000000000000000000000000000';

/**
 * A full 4096 byte chunk payload with distinct data in every segment, derived from `n`.
 * Real data matters here: STS-1 opens one unpredictable segment per witness, and an all-zero
 * payload would make that opening vacuous.
 */
export function numberToArray(n: number): Uint8Array {
  const payload = new Uint8Array(SEGMENT_BYTES * SEGMENTS_IN_CHUNK);
  for (let segment = 0; segment < SEGMENTS_IN_CHUNK; segment++) {
    const digest = solidityKeccak256(['uint256', 'uint256'], [n, segment]);
    payload.set(arrayify(digest), segment * SEGMENT_BYTES);
  }
  return payload;
}

/** Returns true when address A is within proximity order `minimum` of B. */
export function inProximity(a: Uint8Array, b: Uint8Array, minimum: number): boolean {
  if (minimum === 0) return true;
  let remaining = minimum;
  let byteIndex = 0;
  while (remaining > 0) {
    if (remaining >= 8) {
      if (a[byteIndex] !== b[byteIndex]) return false;
      byteIndex++;
      remaining -= 8;
    } else {
      const mask = (0xff << (8 - remaining)) & 0xff;
      return (a[byteIndex] & mask) === (b[byteIndex] & mask);
    }
  }
  return true;
}
