// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

library TransformedBMTChunk {
    // max chunk payload size
    uint256 public constant MAX_CHUNK_PAYLOAD_SIZE = 4096;
    // segment byte size
    uint256 public constant SEGMENT_SIZE = 32;

    /** Calculates the root hash from the provided inclusion proof segments and its corresponding segment index
     * @param _proofSegments Proof segments.
     * @param _proveSegment Segment to prove.
     * @param _proveSegmentIndex Prove segment index
     * @return _calculatedHash chunk hash
     */
    function transformedRootHashFromInclusionProof(
        bytes32[] memory _proofSegments,
        bytes32 _proveSegment,
        uint256 _proveSegmentIndex,
        bytes32 key
    ) internal pure returns (bytes32 _calculatedHash) {
        _calculatedHash = _proveSegment;
        for (uint256 i = 0; i < _proofSegments.length; i++) {
            bool mergeFromRight = _proveSegmentIndex % 2 == 0 ? true : false;
            _calculatedHash = transformedMergeSegment(_calculatedHash, _proofSegments[i], mergeFromRight, key);
            _proveSegmentIndex >>= 1;
        }

        return _calculatedHash;
    }

    /**
     * @notice          Changes the endianness of a uint64.
     * @dev             https://graphics.stanford.edu/~seander/bithacks.html#ReverseParallel
     * @param _b        The unsigned integer to reverse
     * @return          v - The reversed value
     */
    function reverseUint64(uint64 _b) public pure returns (uint64) {
        uint256 v = _b;

        // swap bytes
        v =
            ((v >> 8) & 0x00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF) |
            ((v & 0x00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF) << 8);
        // swap 2-byte long pairs
        v =
            ((v >> 16) & 0x0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF) |
            ((v & 0x0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF) << 16);
        // swap 4-byte long pairs
        v =
            ((v >> 32) & 0x00000000FFFFFFFF00000000FFFFFFFF00000000FFFFFFFF00000000FFFFFFFF) |
            ((v & 0x00000000FFFFFFFF00000000FFFFFFFF00000000FFFFFFFF00000000FFFFFFFF) << 32);

        return uint64(v);
    }

    /**
     * Calculate the chunk address from the Binary Merkle Tree of the chunk data
     *
     * The BMT chunk address is the hash of the 8 byte span and the root
     * hash of a binary Merkle tree (BMT) built on the 32-byte segments
     * of the underlying data.
     * @param _proofSegments Proof segments.
     * @param _proveSegment Segment to prove.
     * @param _proveSegmentIndex Prove segment index
     * @param _chunkSpan chunk bytes length
     * @return _chunkHash chunk hash
     */
    function transformedChunkAddressFromInclusionProof(
        bytes32[] memory _proofSegments,
        bytes32 _proveSegment,
        uint256 _proveSegmentIndex,
        uint64 _chunkSpan,
        bytes32 key
    ) internal pure returns (bytes32) {
        bytes32 rootHash = transformedRootHashFromInclusionProof(
            _proofSegments,
            _proveSegment,
            _proveSegmentIndex,
            key
        );
        return keccak256(abi.encodePacked(key, reverseUint64(_chunkSpan), rootHash));
    }

    function transformedMergeSegment(
        bytes32 _calculatedHash,
        bytes32 _proofSegment,
        bool mergeFromRight,
        bytes32 key
    ) internal pure returns (bytes32 res) {
        if (mergeFromRight) {
            res = keccak256(abi.encode(key, _calculatedHash, _proofSegment));
        } else {
            res = keccak256(abi.encode(key, _proofSegment, _calculatedHash));
        }
        return res;
    }
}
