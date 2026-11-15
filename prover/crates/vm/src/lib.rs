//! Swarm Redistribution VM, SNARK version.
//!
//! The storage incentives Schelling game of `src/Redistribution.sol` (master) as a pure function. On
//! this branch a Groth16 circuit (`prover/snark`) proves the game and the postage accounting, and
//! `src/settlement/Settlement.sol` checks the proof and the claim witness. `snark` is the reference of
//! the circuit: it computes the result of a round and the circuit witness. See docs/SNARK-SETTLEMENT.md.
//!
//! `claim` (with `bmt` and `sample`) is the claim check that `ClaimVerifier.sol` does on chain. The
//! prover runs it to know whether a witness will pass.

pub mod bmt;
pub mod claim;
pub mod randomness;
pub mod sample;
pub mod snark;
mod types;

pub use snark::game::{
    commit_message, game_witness_json, run, stake_commitment, Caps, PublicValues, RoundInput,
    SignedCommit, SnarkError, Stake,
};
pub use snark::{game_key, sign, Point, Sig};
pub use types::*;

use alloy_primitives::{keccak256, B256, U256};

/// Blocks in a round. 64 x 12 s (Ethereum) is about the 760 s of the Gnosis round (152 x 5 s).
pub const ROUND_LENGTH: u64 = 64;
/// The seed block of a round, from its start (Settlement.SEED_OFFSET).
pub const SEED_OFFSET: u64 = 48;

/// EIP-191 personal_sign hash of a 32-byte digest (postage stamps and single-owner chunks).
pub fn eth_signed_message_hash(digest: B256) -> B256 {
    let mut buf = [0u8; 60];
    buf[..28].copy_from_slice(b"\x19Ethereum Signed Message:\n32");
    buf[28..].copy_from_slice(digest.as_slice());
    keccak256(buf)
}

/// `Redistribution.inProximity`.
pub fn in_proximity(a: B256, b: B256, minimum: u8) -> bool {
    if minimum == 0 {
        return true;
    }
    let x = U256::from_be_bytes((a ^ b).0);
    x < (U256::from(1u8) << (256 - minimum as usize))
}

/// `Redistribution.currentMinimumDepth`, with currentCommitRound = round and currentClaimRound =
/// lastClaimRound.
pub fn minimum_depth(round: u64, last_claim_round: u64, last_winner_depth: u8) -> u8 {
    let difference = round.saturating_sub(last_claim_round);
    let skipped = (if difference > 254 {
        254
    } else {
        difference as u8
    }) + 1;
    if skipped >= last_winner_depth {
        0
    } else {
        last_winner_depth - skipped
    }
}

/// The obfuscated commit hash, `Settlement.wrapCommit`: MiMC(overlay, depth, hash, nonce) as 32 bytes.
pub fn wrap_commit(overlay: B256, depth: u8, hash: B256, nonce: B256) -> B256 {
    snark::fr_bytes(snark::game::reveal_hash(&Reveal {
        overlay,
        depth,
        hash,
        nonce,
    }))
}

/// Leaf of the anchored commit list: MiMC(owner, obfuscatedHash, R.x, R.y, S).
pub fn commit_leaf(c: &SignedCommit) -> B256 {
    snark::fr_bytes(snark::game::commit_leaf(c))
}

/// Leaf of the anchored reveal list: the obfuscated hash of the reveal.
pub fn reveal_leaf(r: &Reveal) -> B256 {
    snark::fr_bytes(snark::game::reveal_hash(r))
}

fn frs(leaves: &[B256]) -> Vec<snark::Fr> {
    leaves.iter().map(|l| U256::from_be_bytes(l.0)).collect()
}

/// Root of a list as `Settlement.anchorCommits` and `anchorReveals` take it: a MiMC Merkle tree of depth
/// 8 with the leaves in list order. Zero for an empty list (the contract stores no root for it).
pub fn list_root(leaves: &[B256]) -> B256 {
    if leaves.is_empty() {
        return B256::ZERO;
    }
    snark::fr_bytes(snark::list_root(&frs(leaves)))
}

/// Sibling hashes from leaf `index` to the root (leaf level first).
pub fn list_proof(leaves: &[B256], index: usize) -> Vec<B256> {
    snark::list_proof(&frs(leaves), index)
        .into_iter()
        .map(snark::fr_bytes)
        .collect()
}

/// Does `leaf` sit at `index` of a list with `count` entries and this root?
pub fn list_verify(root: B256, count: u32, index: usize, leaf: B256, proof: &[B256]) -> bool {
    index < count as usize
        && snark::list_verify(
            U256::from_be_bytes(root.0),
            index,
            U256::from_be_bytes(leaf.0),
            &frs(proof),
        )
}

pub fn commits_hash(commits: &[SignedCommit]) -> B256 {
    list_root(&commits.iter().map(commit_leaf).collect::<Vec<_>>())
}

pub fn reveals_hash(reveals: &[Reveal]) -> B256 {
    list_root(&reveals.iter().map(reveal_leaf).collect::<Vec<_>>())
}

/// The hash chain `Settlement.forceCommit` keeps.
pub fn forced_commits_hash(forced: &[ForcedCommit]) -> B256 {
    snark::fr_bytes(snark::game::forced_commits_hash(forced))
}

/// The hash chain `Settlement.forceReveal` keeps.
pub fn forced_reveals_hash(forced: &[Reveal]) -> B256 {
    snark::fr_bytes(snark::game::forced_reveals_hash(forced))
}
