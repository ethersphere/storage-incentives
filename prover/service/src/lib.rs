//! Shared pieces of the prover service and the node simulator: contract bindings, round timing and the
//! HTTP message types nodes send to a prover.

use alloy::primitives::{Address, Bytes, B256};
use serde::{Deserialize, Serialize};

pub use swarm_vm::ROUND_LENGTH;

/// Round layout of Settlement.sol, in blocks from the round start.
pub const COMMIT_END: u64 = 16;
/// anchorRound is accepted in [COMMIT_END, ANCHOR_END); forceCommit until REVEAL_START.
pub const ANCHOR_END: u64 = 20;
pub const REVEAL_START: u64 = 24;
/// Off-chain reveals are accepted until REVEAL_ANCHOR_START; anchorReveals in [REVEAL_ANCHOR_START,
/// REVEAL_ANCHOR_END); forceReveal until REVEAL_END.
pub const REVEAL_ANCHOR_START: u64 = 40;
pub const REVEAL_ANCHOR_END: u64 = 44;
pub const REVEAL_END: u64 = 48;
pub use swarm_vm::SEED_OFFSET;
/// Claim witnesses are accepted from here to the end of the round.
pub const CLAIM_START: u64 = 49;
/// EIP-2935 serves this many past block hashes; after that a round's seed is gone for good.
pub const HISTORY_SERVE_WINDOW: u64 = 8191;

pub fn round_of(block: u64) -> u64 {
    block / ROUND_LENGTH
}

pub fn offset_of(block: u64) -> u64 {
    block % ROUND_LENGTH
}

pub fn seed_block(round: u64) -> u64 {
    round * ROUND_LENGTH + SEED_OFFSET
}

alloy::sol! {
    #[sol(rpc)]
    contract Settlement {
        function anchorRound(uint64 _round, bytes32 _commitsHash, uint32 _commitCount, bytes32 _dataRef) external;
        function anchorReveals(uint64 _round, bytes32 _revealsHash, uint32 _revealCount, bytes32 _dataRef) external;
        function forceCommit(uint64 _round, bytes32 _obfuscatedHash) external;
        function forceReveal(uint64 _round, bytes32 _overlay, uint8 _depth, bytes32 _hash, bytes32 _nonce) external;
        function forceClaim(uint64 _round, bytes calldata _witness) external;
        function settleRound(bytes calldata _publicValues, bytes calldata _proofBytes) external;

        function rounds(uint64) external view returns (
            bytes32 roundAnchor,
            bytes32 commitsHash,
            uint32 commitCount,
            bool anchored,
            bool settled,
            bytes32 forcedCommitsHash,
            uint32 forcedCommitCount,
            bytes32 forcedRevealsHash,
            uint32 forcedRevealCount,
            bytes32 forcedClaimsHash,
            uint32 forcedClaimCount,
            bytes32 revealsHash,
            uint32 revealCount,
            bool revealsAnchored
        );
        function roundAnchor(uint64 _round) external view returns (bytes32);
        function selectionSeed(uint64 _round) external view returns (bytes32);
        function commitDigest(uint64 _round, bytes32 _obfuscatedHash) external view returns (bytes32);
        function lastSettledRound() external view returns (uint64);
        function lastClaimRound() external view returns (uint64);
        function lastWinnerDepth() external view returns (uint8);
        function penaltyMultiplierDisagreement() external view returns (uint8);
        function penaltyMultiplierNonRevealed() external view returns (uint8);
        function penaltyRandomFactor() external view returns (uint8);
        function stakeAgeRounds() external view returns (uint8);
        function programVKey() external view returns (bytes32);
        function Stakes() external view returns (address);
        function OracleContract() external view returns (address);
        function PostageContract() external view returns (address);
        function sampleMaxValue() external view returns (uint256);
        function postageStateHash() external view returns (bytes32);
        function postageEventIndex() external view returns (uint64);
        function postageEventHash() external view returns (bytes32);
        function accruedPot() external view returns (uint256);

        event RoundAnchored(uint64 indexed round, bytes32 roundAnchor, bytes32 commitsHash, uint32 commitCount, bytes32 dataRef);
        event RevealsAnchored(uint64 indexed round, bytes32 revealsHash, uint32 revealCount, bytes32 dataRef);
        event CommitForced(uint64 indexed round, address indexed owner, bytes32 obfuscatedHash);
        event RevealForced(uint64 indexed round, bytes32 indexed overlay, uint8 depth, bytes32 hash, bytes32 nonce);
        event ClaimForced(uint64 indexed round, address indexed sender, bytes witness);
        event RoundSettled(
            uint64 indexed round,
            bool hasTruth,
            bytes32 truthHash,
            uint8 truthDepth,
            address winner,
            uint16 redundancy,
            uint256 payout,
            address prover,
            uint256 proverFee
        );
    }

    #[sol(rpc)]
    contract PostageStamp {
        function eventCount() external view returns (uint64);
        event PostageLog(
            uint64 indexed index,
            uint8 kind,
            bytes32 batchId,
            address owner,
            uint8 depth,
            uint8 bucketDepth,
            uint256 value,
            uint256 outpayment,
            uint64 blockNumber
        );
        function batches(bytes32 _batchId) external view returns (
            address owner,
            uint8 depth,
            uint8 bucketDepth,
            bool immutableFlag,
            uint256 normalisedBalance,
            uint256 lastUpdatedBlockNumber
        );
    }

    #[sol(rpc)]
    contract PriceOracle {
        function currentPrice() external view returns (uint32);
    }

    #[sol(rpc)]
    contract StakeRegistry {
        function stakes(address) external view returns (
            bytes32 overlay,
            uint256 committedStake,
            uint256 potentialStake,
            uint256 lastUpdatedBlockNumber,
            uint8 height
        );
        function overlayOfAddress(address _owner) external view returns (bytes32);
        function heightOfAddress(address _owner) external view returns (uint8);
        function nodeEffectiveStake(address _owner) external view returns (uint256);
        function lastUpdatedBlockNumberOfAddress(address _owner) external view returns (uint256);
    }
}

/// POST /v1/commit
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitMsg {
    pub round: u64,
    pub owner: Address,
    pub obfuscated_hash: B256,
    pub signature: Bytes,
}

/// POST /v1/reveal
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevealMsg {
    pub round: u64,
    pub overlay: B256,
    pub depth: u8,
    pub hash: B256,
    pub nonce: B256,
}

/// POST /v1/claim
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimMsg {
    pub round: u64,
    /// ABI-encoded `swarm_vm::claim::ClaimWitness`.
    pub witness: Bytes,
}

/// GET /v1/rounds/{round}/outcome, available after the seed block.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutcomeMsg {
    pub round: u64,
    pub has_truth: bool,
    pub truth_hash: B256,
    pub truth_depth: u8,
    pub winner: Address,
    pub round_anchor: B256,
    pub selection_seed: B256,
    /// A valid claim witness is already known for this round.
    pub claimed: bool,
}
