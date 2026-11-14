//! Messages of a round.

use alloy_primitives::{Address, B256};
use serde::{Deserialize, Serialize};

/// A commit posted on chain through `Settlement.forceCommit`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ForcedCommit {
    pub owner: Address,
    pub obfuscated_hash: B256,
}

/// The preimage of a commit. Sent off chain, or on chain through `Settlement.forceReveal`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Reveal {
    pub overlay: B256,
    pub depth: u8,
    pub hash: B256,
    pub nonce: B256,
}
