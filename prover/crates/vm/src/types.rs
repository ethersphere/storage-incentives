//! Inputs and outputs of one round of the Redistribution VM.

use alloy_primitives::{Address, Bytes, B256, U256};
use alloy_sol_types::sol;
use serde::{Deserialize, Serialize};

sol! {
    /// Public inputs: re-derived or read on chain and compared by Settlement.
    #[derive(Debug, PartialEq, Eq)]
    struct PublicInputs {
        uint256 chainId;
        address settlement;
        uint64 round;
        bytes32 roundAnchor;
        bytes32 selectionSeed;
        bytes32 commitsHash;
        uint32 commitCount;
        bytes32 forcedCommitsHash;
        bytes32 forcedRevealsHash;
        uint64 lastClaimRound;
        uint8 lastWinnerDepth;
        uint8 penaltyMultiplierDisagreement;
        uint8 penaltyMultiplierNonRevealed;
        uint8 penaltyRandomFactor;
        address[] participants;
        bytes32 stakeDigest;
        uint32 stakePrice;
        bytes32 forcedClaimsHash;
        bytes32[] batchIds;
        bytes32 batchDigest;
        uint256 sampleMaxValue;
    }

    /// Outputs: executed by Settlement.
    #[derive(Debug, PartialEq, Eq)]
    struct Outcome {
        bool hasTruth;
        bytes32 truthHash;
        uint8 truthDepth;
        address winner;
        bytes32 winnerOverlay;
        uint256 winnerStakeDensity;
        uint16 redundancy;
        address[] freezeOwners;
        uint256[] freezeDurations;
        bool unclaimed;
    }

    /// What the proof commits to. Must match `Settlement.PublicValues`.
    #[derive(Debug, PartialEq, Eq)]
    struct PublicValues {
        PublicInputs inputs;
        Outcome outcome;
    }
}

/// A commit sent off chain to a prover, signed by the node's staking address.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignedCommit {
    pub owner: Address,
    pub obfuscated_hash: B256,
    /// 65-byte (r, s, v) signature over `commit_digest`, EIP-191 prefixed.
    pub signature: Bytes,
}

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

/// A node's raw StakeRegistry.stakes record as Settlement reads it at settlement time.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StakeRecord {
    pub owner: Address,
    pub overlay: B256,
    pub committed_stake: U256,
    pub potential_stake: U256,
    pub height: u8,
    pub last_updated: U256,
}

/// Everything the VM needs for one round. The public parts are echoed into `PublicValues` and checked
/// against the chain by Settlement; the rest (signatures, off-chain reveals) stays private.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoundInput {
    pub chain_id: U256,
    pub settlement: Address,
    pub round: u64,
    pub round_anchor: B256,
    pub selection_seed: B256,
    /// Anchored off-chain commits, sorted by owner, as hashed into `commitsHash`.
    pub commits: Vec<SignedCommit>,
    /// `CommitForced` events of the round, in chain order.
    pub forced_commits: Vec<ForcedCommit>,
    /// Off-chain reveals the prover received, any order.
    pub reveals: Vec<Reveal>,
    /// `RevealForced` events of the round, in chain order.
    pub forced_reveals: Vec<Reveal>,
    /// One record per participant, in canonical commit order (see `canonical_commits`).
    pub stakes: Vec<StakeRecord>,
    /// PriceOracle.currentPrice() at settlement, for effective stake.
    pub stake_price: u32,
    pub last_claim_round: u64,
    pub last_winner_depth: u8,
    pub penalty_multiplier_disagreement: u8,
    pub penalty_multiplier_non_revealed: u8,
    pub penalty_random_factor: u8,
    /// The claim witness the prover received off chain: an ABI-encoded `ClaimWitness`.
    pub claim: Option<Bytes>,
    /// `ClaimForced` events of the round, in chain order.
    pub forced_claims: Vec<Bytes>,
    /// PostageStamp records for every batch the claim witnesses reference (see `claim_batch_ids`).
    pub batches: Vec<crate::claim::BatchRecord>,
    /// Settlement.sampleMaxValue (Redistribution's reserve size estimate bound).
    pub sample_max_value: U256,
}
