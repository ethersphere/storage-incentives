//! Reserve sample and claim witness builders, the node side of `claim.rs`. node-sim and the tests use
//! these; the zkVM program does not. Content-addressed chunks (CAC) only; single-owner chunks are
//! covered by the Bee-generated test vectors.

use crate::bmt::{self, Tree};
use crate::claim::{chunk_segment_index, witness_indices, ChunkInclusionProof, ClaimWitness, PostageProof};
use alloy_primitives::B256;

/// Witnesses in a reserve sample (`WITNESS_COUNT` in the tests).
pub const SAMPLE_SIZE: usize = 16;

/// One chunk of the sample: its payload, plain address and transformed (anchor-keyed) address.
#[derive(Clone, Debug)]
pub struct SampleEntry {
    pub payload: Vec<u8>,
    pub original: B256,
    pub transformed: B256,
}

impl SampleEntry {
    pub fn new(payload: Vec<u8>, anchor: &B256) -> Self {
        let original = Tree::new(&payload, None).address();
        let transformed = Tree::new(&payload, Some(*anchor)).address();
        SampleEntry { payload, original, transformed }
    }
}

/// A reserve sample: the 16 chunks with the smallest transformed addresses, sorted ascending.
pub struct Sample {
    pub entries: Vec<SampleEntry>,
    tree: Tree,
}

impl Sample {
    /// `entries` must be the 16 chosen chunks; they are sorted here.
    pub fn new(mut entries: Vec<SampleEntry>) -> Self {
        assert_eq!(entries.len(), SAMPLE_SIZE);
        entries.sort_by(|a, b| a.transformed.cmp(&b.transformed));
        let mut payload = Vec::with_capacity(SAMPLE_SIZE * 64);
        for e in &entries {
            payload.extend_from_slice(e.original.as_slice());
            payload.extend_from_slice(e.transformed.as_slice());
        }
        Sample { tree: Tree::new(&payload, None), entries }
    }

    /// The reserve commitment hash a node commits to and reveals.
    pub fn hash(&self) -> B256 {
        self.tree.address()
    }

    /// The three claim proofs for a selection seed. `stamp` returns the postage proof for a chunk
    /// address (the batch owner signs it).
    pub fn witness(&self, anchor: &B256, seed: B256, mut stamp: impl FnMut(B256) -> PostageProof) -> ClaimWitness {
        let (i1, i2) = witness_indices(seed);
        let segment = chunk_segment_index(seed) as usize;
        let mut proof = |k: usize| {
            let e = &self.entries[k];
            let og = Tree::new(&e.payload, None);
            let tr = Tree::new(&e.payload, Some(*anchor));
            ChunkInclusionProof {
                proofSegments: self.tree.proof(k * 2),
                proveSegment: self.tree.segment(k * 2),
                proofSegments2: og.proof(segment),
                proveSegment2: og.segment(segment),
                chunkSpan: e.payload.len() as u64,
                proofSegments3: tr.proof(segment),
                postageProof: stamp(e.original),
                socProof: vec![],
            }
        };
        ClaimWitness {
            proof1: proof(i1 as usize),
            proof2: proof(i2 as usize),
            proofLast: proof(SAMPLE_SIZE - 1),
        }
    }
}

/// Fast addresses for a 32-byte payload: (original, transformed). Used to scan a large reserve.
pub struct FastHasher {
    anchor: B256,
    zero_plain: [B256; bmt::DEPTH],
    zero_keyed: [B256; bmt::DEPTH],
}

impl FastHasher {
    pub fn new(anchor: B256) -> Self {
        FastHasher { anchor, zero_plain: bmt::zero_subtrees(None), zero_keyed: bmt::zero_subtrees(Some(&anchor)) }
    }

    pub fn original(&self, segment: B256) -> B256 {
        bmt::single_segment_address(None, &self.zero_plain, segment, 32)
    }

    pub fn transformed(&self, segment: B256) -> B256 {
        bmt::single_segment_address(Some(&self.anchor), &self.zero_keyed, segment, 32)
    }
}
