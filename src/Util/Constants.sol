// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.19;

/**
 * @title Protocol-wide constants for Swarm storage incentives.
 */
library Constants {
    /// @notice Length of a round in blocks (~12.7 minutes at 5s/block).
    uint256 internal constant ROUND_LENGTH = 152;

    /// @notice Length of a single round phase in blocks (commit, reveal, or claim).
    uint256 internal constant PHASE_LENGTH = ROUND_LENGTH / 4;

    /// @notice Minimum BZZ at staking height 0 (`MIN_STAKE * 2**height` for higher heights).
    uint256 internal constant MIN_STAKE = 10 * 1e16;

    /// @notice Maximum chunk payload size in bytes.
    uint256 internal constant MAX_CHUNK_PAYLOAD_SIZE = 4096;

    /// @notice Segment byte size in BMT chunk proofs.
    uint256 internal constant SEGMENT_SIZE = 32;

    /// @notice Number of segments in a max-size chunk (`MAX_CHUNK_PAYLOAD_SIZE / SEGMENT_SIZE`).
    uint256 internal constant SEGMENTS_PER_CHUNK = MAX_CHUNK_PAYLOAD_SIZE / SEGMENT_SIZE;
}
