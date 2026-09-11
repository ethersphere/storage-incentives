// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.19;

/**
 * @dev Single owner chunk attestation, used when the stamped chunk is a SOC.
 */
struct SOCProof {
    address signer; // signer Ethereum address to check against
    bytes signature;
    bytes32 identifier;
    bytes32 chunkAddr; // wrapped chunk address
}

/**
 * @dev The chunk half of one STS-1 stamp witness: enough to recompute both the ordinary and the
 * first anchor transformed address of the stamped chunk from the same opened segment.
 */
struct ChunkDataProof {
    // Chunk address, or the SOC address when socProof is present.
    bytes32 proveSegment;
    // Inclusion proof of the opened segment under the ordinary address.
    bytes32[] proofSegments2;
    // The opened segment data itself.
    bytes32 proveSegment2;
    uint64 chunkSpan;
    // Inclusion proof of the same segment under the transformed address.
    bytes32[] proofSegments3;
    SOCProof[] socProof;
}

/**
 * @dev One opened position of the 16 entry stamp sample, with everything needed to bind it to a
 * real batch and to this participant's own chunk root.
 */
struct StampProof {
    // Inclusion of the transformed stamp value at sampleIndex in the committed stamp sample.
    bytes32[] proofSegments;
    bytes32 leftValue;
    bytes32[] leftProofSegments;
    bytes32 rightValue;
    bytes32[] rightProofSegments;
    bool hasLeftValue;
    bool hasRightValue;
    uint32 sampleIndex;
    bytes32 chunkAddress;
    bytes32 postageId;
    uint64 index;
    uint64 timeStamp;
    bytes signature;
    ChunkDataProof chunkProof;
    // Membership of the transformed chunk address in chunkTransformRoot.
    bytes32[] chunkTransformProofSegments;
}
