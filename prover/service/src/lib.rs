//! Shared pieces of the prover service and the node simulator: contract bindings, round timing and the
//! HTTP message types nodes send to a prover.

use alloy::primitives::{Address, Bytes, B256};
use serde::{Deserialize, Serialize};

pub use swarm_vm::ROUND_LENGTH;

/// Round layout of Settlement.sol, in blocks from the round start.
pub const COMMIT_END: u64 = 38;
pub const ANCHOR_END: u64 = 57;
pub const REVEAL_END: u64 = 114;
pub const SEED_OFFSET: u64 = 114;
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
        function forceCommit(uint64 _round, bytes32 _obfuscatedHash) external;
        function forceReveal(uint64 _round, bytes32 _overlay, uint8 _depth, bytes32 _hash, bytes32 _nonce) external;
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
            uint32 forcedRevealCount
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
        function programVKey() external view returns (bytes32);
        function Stakes() external view returns (address);
        function OracleContract() external view returns (address);

        event RoundAnchored(uint64 indexed round, bytes32 roundAnchor, bytes32 commitsHash, uint32 commitCount, bytes32 dataRef);
        event CommitForced(uint64 indexed round, address indexed owner, bytes32 obfuscatedHash);
        event RevealForced(uint64 indexed round, bytes32 indexed overlay, uint8 depth, bytes32 hash, bytes32 nonce);
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
