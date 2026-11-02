//! The storage evidence of `Redistribution.claim`: three chunk witnesses from the winner's reserve
//! sample, each with a BMT inclusion proof, a postage stamp, and optionally a single-owner-chunk (SOC)
//! attestation. Ported from `inclusionFunction`, `stampFunction`, `socFunction`, `checkOrder` and
//! `estimateSize` in src/Redistribution.sol.

use crate::{bmt, eth_signed_message_hash, in_proximity};
use alloy_primitives::{keccak256, Address, Signature, B256, U256};
use alloy_sol_types::{sol, SolValue};
use serde::{Deserialize, Serialize};

sol! {
    /// Same layout as `Redistribution.ChunkInclusionProof`.
    #[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
    struct ChunkInclusionProof {
        bytes32[] proofSegments;
        bytes32 proveSegment;
        bytes32[] proofSegments2;
        bytes32 proveSegment2;
        uint64 chunkSpan;
        bytes32[] proofSegments3;
        PostageProof postageProof;
        SOCProof[] socProof;
    }

    #[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
    struct SOCProof {
        address signer;
        bytes signature;
        bytes32 identifier;
        bytes32 chunkAddr;
    }

    #[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
    struct PostageProof {
        bytes signature;
        bytes32 postageId;
        uint64 index;
        uint64 timeStamp;
    }

    /// The three arguments of `Redistribution.claim`, ABI-encoded as one value. This is the byte format
    /// for `POST /v1/claim` and for `Settlement.forceClaim`.
    #[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
    struct ClaimWitness {
        ChunkInclusionProof proof1;
        ChunkInclusionProof proof2;
        ChunkInclusionProof proofLast;
    }
}

impl ClaimWitness {
    pub fn decode(bytes: &[u8]) -> Option<Self> {
        <ClaimWitness as SolValue>::abi_decode(bytes).ok()
    }

    pub fn encode(&self) -> Vec<u8> {
        SolValue::abi_encode(self)
    }

    /// Postage batch ids of the three witnesses, in the order Settlement binds them.
    pub fn batch_ids(&self) -> [B256; 3] {
        [
            self.proof1.postageProof.postageId,
            self.proof2.postageProof.postageId,
            self.proofLast.postageProof.postageId,
        ]
    }
}

/// A postage batch as the claim checks see it (from the replayed postage state; owner zero when expired).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BatchRecord {
    pub batch_id: B256,
    pub owner: Address,
    pub depth: u8,
    pub bucket_depth: u8,
}

/// The hash chain `Settlement.forceClaim` keeps: keccak256(abi.encodePacked(prev, keccak256(witness))).
pub fn forced_claims_hash(forced: &[alloy_primitives::Bytes]) -> B256 {
    forced.iter().fold(B256::ZERO, |acc, w| {
        let mut buf = [0u8; 64];
        buf[..32].copy_from_slice(acc.as_slice());
        buf[32..].copy_from_slice(keccak256(w).as_slice());
        keccak256(buf)
    })
}

/// Why a witness was rejected. The names follow the custom errors of Redistribution.sol.
#[derive(Debug, PartialEq, Eq)]
pub enum ClaimError {
    OutOfDepthClaim(u8),
    /// 1 = sample inclusion, 2 = first sister segment, 3 = original address, 4 = transformed address
    InclusionProofFailed(u8),
    MissingSegment,
    BatchDoesNotExist,
    IndexOutsideSet,
    BucketDiffers,
    SigRecoveryFailed,
    SocVerificationFailed,
    SocCalcNotMatching,
    RandomElementCheckFailed,
    LastElementCheckFailed,
    ReserveCheckFailed,
}

/// What a claim is checked against.
pub struct ClaimContext<'a> {
    /// `currentRevealRoundAnchor` of Redistribution: here the round anchor.
    pub anchor: B256,
    /// `seed` of Redistribution: here the selection seed.
    pub seed: B256,
    /// The winner's reveal (`winner.hash`, `winner.depth`): the truth.
    pub sample_hash: B256,
    pub depth: u8,
    pub batches: &'a [BatchRecord],
    pub sample_max_value: U256,
}

/// Indices in the sample of the two random witnesses: `seed % 15` and `seed % 14` (skipping the first).
pub fn witness_indices(seed: B256) -> (u64, u64) {
    let s = U256::from_be_bytes(seed.0);
    let i1 = (s % U256::from(15u8)).to::<u64>();
    let mut i2 = (s % U256::from(14u8)).to::<u64>();
    if i2 >= i1 {
        i2 += 1;
    }
    (i1, i2)
}

/// `seed % 128`: the segment of each witness chunk that is opened.
pub fn chunk_segment_index(seed: B256) -> u64 {
    (U256::from_be_bytes(seed.0) % U256::from(bmt::SEGMENTS)).to::<u64>()
}

/// `Redistribution.claim` minus the winner selection and the payout.
pub fn verify_claim(w: &ClaimWitness, ctx: &ClaimContext) -> Result<(), ClaimError> {
    let (i1, i2) = witness_indices(ctx.seed);

    if !in_proximity(w.proofLast.proveSegment, ctx.anchor, ctx.depth) {
        return Err(ClaimError::OutOfDepthClaim(3));
    }
    check_entry(&w.proofLast, 30, ctx)?;

    if !in_proximity(w.proof1.proveSegment, ctx.anchor, ctx.depth) {
        return Err(ClaimError::OutOfDepthClaim(2));
    }
    check_entry(&w.proof1, i1 * 2, ctx)?;

    if !in_proximity(w.proof2.proveSegment, ctx.anchor, ctx.depth) {
        return Err(ClaimError::OutOfDepthClaim(1));
    }
    check_entry(&w.proof2, i2 * 2, ctx)?;

    let tr1 = first(&w.proof1.proofSegments)?;
    let tr2 = first(&w.proof2.proofSegments)?;
    let tr_last = first(&w.proofLast.proofSegments)?;
    check_order(i1, i2, tr1, tr2, tr_last)?;

    if U256::from_be_bytes(tr_last.0) >= ctx.sample_max_value {
        return Err(ClaimError::ReserveCheckFailed);
    }
    Ok(())
}

fn check_entry(
    p: &ChunkInclusionProof,
    index_in_rc: u64,
    ctx: &ClaimContext,
) -> Result<(), ClaimError> {
    inclusion(p, index_in_rc, ctx)?;
    stamp(p, ctx)?;
    soc(p)
}

fn first(v: &[B256]) -> Result<B256, ClaimError> {
    v.first().copied().ok_or(ClaimError::MissingSegment)
}

/// `inclusionFunction`.
fn inclusion(
    p: &ChunkInclusionProof,
    index_in_rc: u64,
    ctx: &ClaimContext,
) -> Result<(), ClaimError> {
    let segment_index = chunk_segment_index(ctx.seed);
    let mut transformed = bmt::transformed_address_from_proof(
        &p.proofSegments3,
        p.proveSegment2,
        segment_index,
        p.chunkSpan,
        &ctx.anchor,
    );

    // The sample (reserve commitment) is a 32*32-byte chunk of (original, transformed) address pairs.
    if ctx.sample_hash
        != bmt::chunk_address_from_proof(&p.proofSegments, p.proveSegment, index_in_rc, 32 * 32)
    {
        return Err(ClaimError::InclusionProofFailed(1));
    }

    if first(&p.proofSegments2)? != first(&p.proofSegments3)? {
        return Err(ClaimError::InclusionProofFailed(2));
    }

    let original = match p.socProof.first() {
        Some(s) => s.chunkAddr,
        None => p.proveSegment,
    };
    if original
        != bmt::chunk_address_from_proof(
            &p.proofSegments2,
            p.proveSegment2,
            segment_index,
            p.chunkSpan,
        )
    {
        return Err(ClaimError::InclusionProofFailed(3));
    }

    // For a SOC the sample holds keccak256(abi.encode(socAddress, transformedAddress)).
    if !p.socProof.is_empty() {
        let mut buf = [0u8; 64];
        buf[..32].copy_from_slice(p.proveSegment.as_slice());
        buf[32..].copy_from_slice(transformed.as_slice());
        transformed = keccak256(buf);
    }

    if first(&p.proofSegments)? != transformed {
        return Err(ClaimError::InclusionProofFailed(4));
    }
    Ok(())
}

/// `stampFunction`.
fn stamp(p: &ChunkInclusionProof, ctx: &ClaimContext) -> Result<(), ClaimError> {
    let pp = &p.postageProof;
    let batch = ctx
        .batches
        .iter()
        .find(|b| b.batch_id == pp.postageId)
        .filter(|b| b.owner != Address::ZERO)
        .ok_or(ClaimError::BatchDoesNotExist)?;

    // 1 << (depth - bucketDepth). Solidity reverts on underflow; treat as outside the set.
    let max_index = batch
        .depth
        .checked_sub(batch.bucket_depth)
        .map(|d| 1u128 << d)
        .ok_or(ClaimError::IndexOutsideSet)?;
    let postage_index = pp.index as u32;
    if u128::from(postage_index) >= max_index {
        return Err(ClaimError::IndexOutsideSet);
    }

    let postage_bucket = (pp.index >> 32) as u32 as u64;
    if postage_bucket != address_to_bucket(p.proveSegment, batch.bucket_depth) as u64 {
        return Err(ClaimError::BucketDiffers);
    }

    let mut msg = [0u8; 32 + 32 + 8 + 8];
    msg[..32].copy_from_slice(p.proveSegment.as_slice());
    msg[32..64].copy_from_slice(pp.postageId.as_slice());
    msg[64..72].copy_from_slice(&pp.index.to_be_bytes());
    msg[72..].copy_from_slice(&pp.timeStamp.to_be_bytes());
    if ecrecover(eth_signed_message_hash(keccak256(msg)), &pp.signature) != Some(batch.owner) {
        return Err(ClaimError::SigRecoveryFailed);
    }
    Ok(())
}

/// `socFunction`.
fn soc(p: &ChunkInclusionProof) -> Result<(), ClaimError> {
    let Some(s) = p.socProof.first() else {
        return Ok(());
    };

    let mut msg = [0u8; 64];
    msg[..32].copy_from_slice(s.identifier.as_slice());
    msg[32..].copy_from_slice(s.chunkAddr.as_slice());
    if ecrecover(eth_signed_message_hash(keccak256(msg)), &s.signature) != Some(s.signer) {
        return Err(ClaimError::SocVerificationFailed);
    }

    if soc_address(s.identifier, s.signer) != p.proveSegment {
        return Err(ClaimError::SocCalcNotMatching);
    }
    Ok(())
}

/// `calculateSocAddress`: keccak256(abi.encodePacked(identifier, owner)).
pub fn soc_address(identifier: B256, owner: Address) -> B256 {
    let mut buf = [0u8; 52];
    buf[..32].copy_from_slice(identifier.as_slice());
    buf[32..].copy_from_slice(owner.as_slice());
    keccak256(buf)
}

/// `addressToBucket`: the first `bucketDepth` bits of the address. A uint32 shift by 32 is 0 in Solidity.
pub fn address_to_bucket(address: B256, bucket_depth: u8) -> u32 {
    let prefix = u32::from_be_bytes(address[..4].try_into().unwrap());
    prefix
        .checked_shr(32 - bucket_depth.min(32) as u32)
        .unwrap_or(0)
}

/// `checkOrder`.
fn check_order(a: u64, b: u64, tr1: B256, tr2: B256, tr_last: B256) -> Result<(), ClaimError> {
    let (lo, hi) = if a < b { (tr1, tr2) } else { (tr2, tr1) };
    if lo >= hi {
        return Err(ClaimError::RandomElementCheckFailed);
    }
    if hi >= tr_last {
        return Err(ClaimError::LastElementCheckFailed);
    }
    Ok(())
}

/// The EVM `ecrecover` precompile as Signatures.recoverSigner uses it: 65 bytes (r, s, v), v must be
/// 27 or 28. Returns None where ecrecover returns address(0).
pub fn ecrecover(hash: B256, sig: &[u8]) -> Option<Address> {
    if sig.len() != 65 {
        return None; // Signatures.splitSignature reverts
    }
    let parity = match sig[64] {
        27 => false,
        28 => true,
        _ => return None,
    };
    let sig = Signature::from_bytes_and_parity(&sig[..64], parity);
    sig.recover_address_from_prehash(&hash).ok()
}
