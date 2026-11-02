//! Swarm Binary Merkle Tree (BMT) chunk hashing, plain and "transformed" (keyed with the round anchor).
//!
//! Verification functions are ports of `src/Util/ChunkProof.sol` (BMTChunk) and
//! `src/Util/TransformedChunkProof.sol` (TransformedBMTChunk). The builders below them make chunk
//! addresses and inclusion proofs; node-sim and the tests use them, the zkVM program does not.

use alloy_primitives::{keccak256, B256};

/// Bytes in a chunk payload.
pub const CHUNK_SIZE: usize = 4096;
/// Bytes in a BMT segment.
pub const SEGMENT_SIZE: usize = 32;
/// Segments in a chunk (leaves of the BMT).
pub const SEGMENTS: usize = CHUNK_SIZE / SEGMENT_SIZE;
/// Levels above the leaves; also the length of every inclusion proof.
pub const DEPTH: usize = 7;

fn hash_pair(key: Option<&B256>, left: &B256, right: &B256) -> B256 {
    match key {
        None => {
            let mut buf = [0u8; 64];
            buf[..32].copy_from_slice(left.as_slice());
            buf[32..].copy_from_slice(right.as_slice());
            keccak256(buf)
        }
        Some(k) => {
            let mut buf = [0u8; 96];
            buf[..32].copy_from_slice(k.as_slice());
            buf[32..64].copy_from_slice(left.as_slice());
            buf[64..].copy_from_slice(right.as_slice());
            keccak256(buf)
        }
    }
}

/// `rootHashFromInclusionProof` / `transformedRootHashFromInclusionProof`.
pub fn root_from_proof(key: Option<&B256>, proof: &[B256], segment: B256, mut index: u64) -> B256 {
    let mut h = segment;
    for sister in proof {
        // mergeFromRight == (index is even): the running hash is the left child.
        h = if index % 2 == 0 {
            hash_pair(key, &h, sister)
        } else {
            hash_pair(key, sister, &h)
        };
        index >>= 1;
    }
    h
}

/// keccak256(abi.encodePacked([key,] reverseUint64(span), root)): the span is little-endian.
pub fn address_from_root(key: Option<&B256>, span: u64, root: &B256) -> B256 {
    let mut buf = Vec::with_capacity(72);
    if let Some(k) = key {
        buf.extend_from_slice(k.as_slice());
    }
    buf.extend_from_slice(&span.to_le_bytes());
    buf.extend_from_slice(root.as_slice());
    keccak256(buf)
}

/// `BMTChunk.chunkAddressFromInclusionProof`.
pub fn chunk_address_from_proof(proof: &[B256], segment: B256, index: u64, span: u64) -> B256 {
    address_from_root(None, span, &root_from_proof(None, proof, segment, index))
}

/// `TransformedBMTChunk.transformedChunkAddressFromInclusionProof`.
pub fn transformed_address_from_proof(
    proof: &[B256],
    segment: B256,
    index: u64,
    span: u64,
    key: &B256,
) -> B256 {
    address_from_root(
        Some(key),
        span,
        &root_from_proof(Some(key), proof, segment, index),
    )
}

// ----------------------------------------------------------------------------------------------
// Builders (not used in the zkVM program)
// ----------------------------------------------------------------------------------------------

/// A chunk's full BMT: `levels[0]` are the 128 leaf segments, `levels[DEPTH]` is the root.
pub struct Tree {
    key: Option<B256>,
    span: u64,
    levels: Vec<Vec<B256>>,
}

impl Tree {
    /// Build the BMT of `payload` (at most 4096 bytes, zero padded), plain or keyed.
    pub fn new(payload: &[u8], key: Option<B256>) -> Self {
        assert!(payload.len() <= CHUNK_SIZE);
        let mut data = [0u8; CHUNK_SIZE];
        data[..payload.len()].copy_from_slice(payload);
        let mut level: Vec<B256> = data.chunks(SEGMENT_SIZE).map(B256::from_slice).collect();
        let mut levels = vec![level.clone()];
        while level.len() > 1 {
            level = level
                .chunks(2)
                .map(|p| hash_pair(key.as_ref(), &p[0], &p[1]))
                .collect();
            levels.push(level.clone());
        }
        Tree {
            key,
            span: payload.len() as u64,
            levels,
        }
    }

    pub fn address(&self) -> B256 {
        address_from_root(self.key.as_ref(), self.span, &self.levels[DEPTH][0])
    }

    pub fn segment(&self, index: usize) -> B256 {
        self.levels[0][index]
    }

    /// Sister hashes from the leaf up, as `rootHashFromInclusionProof` expects.
    pub fn proof(&self, mut index: usize) -> Vec<B256> {
        let mut out = Vec::with_capacity(DEPTH);
        for level in &self.levels[..DEPTH] {
            out.push(level[index ^ 1]);
            index >>= 1;
        }
        out
    }
}

/// Address of a chunk whose payload is one 32-byte segment, computed with 8 hashes instead of 128.
/// The other 127 leaves are zero, so their subtrees are constant for a given key. `zero` must come
/// from `zero_subtrees(key)`. node-sim uses this to sample a large simulated reserve every round.
pub fn single_segment_address(
    key: Option<&B256>,
    zero: &[B256; DEPTH],
    segment: B256,
    span: u64,
) -> B256 {
    let mut h = segment;
    for z in zero.iter() {
        h = hash_pair(key, &h, z);
    }
    address_from_root(key, span, &h)
}

/// Hash of an all-zero subtree at each level 0..DEPTH-1 (level 0 = a zero segment).
pub fn zero_subtrees(key: Option<&B256>) -> [B256; DEPTH] {
    let mut out = [B256::ZERO; DEPTH];
    for i in 1..DEPTH {
        out[i] = hash_pair(key, &out[i - 1], &out[i - 1]);
    }
    out
}
