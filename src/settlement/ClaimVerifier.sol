// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.19;

import "../Util/TransformedChunkProof.sol";
import "../Util/ChunkProof.sol";
import "../Util/Signatures.sol";

interface IClaimPostage {
    function batches(
        bytes32 batchId
    )
        external
        view
        returns (
            address owner,
            uint8 depth,
            uint8 bucketDepth,
            bool immutableFlag,
            uint256 normalisedBalance,
            uint256 lastUpdatedBlockNumber
        );

    function isBatchAlive(bytes32 batchId) external view returns (bool);
}

/**
 * @title The claim checks of Redistribution, for the SNARK settlement
 * @notice `Redistribution.claim` minus the winner selection and the payout: the three chunk inclusion
 * proofs of the truth's reserve sample, the postage stamp of each chunk, the single-owner chunk
 * signatures, and the reserve size estimate. The checks use keccak256 and ecrecover, which are cheap on
 * chain and expensive in a circuit. So `Settlement` does them here, and the circuit proves the rest of
 * the round. The code follows `src/Redistribution.sol`.
 *
 * `verify` reverts when the witness is not valid. `Settlement` calls it with try/catch.
 */
contract ClaimVerifier {
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

    struct SOCProof {
        address signer;
        bytes signature;
        bytes32 identifier;
        bytes32 chunkAddr;
    }

    struct PostageProof {
        bytes signature;
        bytes32 postageId;
        uint64 index;
        uint64 timeStamp;
    }

    /// The three arguments of `Redistribution.claim`, ABI-encoded as one value.
    struct ClaimWitness {
        ChunkInclusionProof proof1;
        ChunkInclusionProof proof2;
        ChunkInclusionProof proofLast;
    }

    /// What a claim is checked against.
    struct Context {
        bytes32 anchor; // the round anchor
        bytes32 seed; // the selection seed
        bytes32 truthHash; // the truth: the reserve commitment
        uint8 depth; // the truth's depth
        uint256 sampleMaxValue;
        IClaimPostage postage;
    }

    error OutOfDepthClaim(uint8 which);
    error InclusionProofFailed(uint8 which);
    error BatchNotAlive(bytes32 batchId);
    error IndexOutsideSet(bytes32 batchId);
    error BucketDiffers(bytes32 batchId);
    error SigRecoveryFailed(bytes32 batchId);
    error SocVerificationFailed(bytes32 chunkAddr);
    error SocCalcNotMatching(bytes32 chunkAddr);
    error RandomElementCheckFailed();
    error LastElementCheckFailed();
    error ReserveCheckFailed();

    function verify(bytes calldata witness, Context calldata ctx) external view {
        ClaimWitness memory w = abi.decode(witness, (ClaimWitness));

        uint256 indexInRC1 = uint256(ctx.seed) % 15;
        uint256 indexInRC2 = uint256(ctx.seed) % 14;
        if (indexInRC2 >= indexInRC1) indexInRC2++;

        if (!inProximity(w.proofLast.proveSegment, ctx.anchor, ctx.depth)) revert OutOfDepthClaim(3);
        _entry(w.proofLast, 30, ctx);
        if (!inProximity(w.proof1.proveSegment, ctx.anchor, ctx.depth)) revert OutOfDepthClaim(2);
        _entry(w.proof1, indexInRC1 * 2, ctx);
        if (!inProximity(w.proof2.proveSegment, ctx.anchor, ctx.depth)) revert OutOfDepthClaim(1);
        _entry(w.proof2, indexInRC2 * 2, ctx);

        bytes32 tr1 = w.proof1.proofSegments[0];
        bytes32 tr2 = w.proof2.proofSegments[0];
        bytes32 trLast = w.proofLast.proofSegments[0];
        if (indexInRC1 < indexInRC2) {
            if (uint256(tr1) >= uint256(tr2)) revert RandomElementCheckFailed();
            if (uint256(tr2) >= uint256(trLast)) revert LastElementCheckFailed();
        } else {
            if (uint256(tr2) >= uint256(tr1)) revert RandomElementCheckFailed();
            if (uint256(tr1) >= uint256(trLast)) revert LastElementCheckFailed();
        }
        if (uint256(trLast) >= ctx.sampleMaxValue) revert ReserveCheckFailed();
    }

    function inProximity(bytes32 a, bytes32 b, uint8 minimum) public pure returns (bool) {
        if (minimum == 0) return true;
        return uint256(a ^ b) < uint256(2 ** (256 - uint256(minimum)));
    }

    function _entry(ChunkInclusionProof memory p, uint256 indexInRC, Context calldata ctx) internal view {
        _inclusion(p, indexInRC, ctx);
        _stamp(p, ctx.postage);
        _soc(p);
    }

    /// `inclusionFunction`.
    function _inclusion(ChunkInclusionProof memory p, uint256 indexInRC, Context calldata ctx) internal pure {
        uint256 segmentIndex = uint256(ctx.seed) % 128;
        bytes32 transformed = TransformedBMTChunk.transformedChunkAddressFromInclusionProof(
            p.proofSegments3,
            p.proveSegment2,
            segmentIndex,
            p.chunkSpan,
            ctx.anchor
        );
        if (
            ctx.truthHash !=
            BMTChunk.chunkAddressFromInclusionProof(p.proofSegments, p.proveSegment, indexInRC, 32 * 32)
        ) revert InclusionProofFailed(1);
        if (p.proofSegments2[0] != p.proofSegments3[0]) revert InclusionProofFailed(2);

        bytes32 original = p.socProof.length > 0 ? p.socProof[0].chunkAddr : p.proveSegment;
        if (
            original !=
            BMTChunk.chunkAddressFromInclusionProof(p.proofSegments2, p.proveSegment2, segmentIndex, p.chunkSpan)
        ) revert InclusionProofFailed(3);

        // For a single-owner chunk, the sample holds the hash of its address and its transformed address.
        if (p.socProof.length > 0) transformed = keccak256(abi.encode(p.proveSegment, transformed));
        if (p.proofSegments[0] != transformed) revert InclusionProofFailed(4);
    }

    /// `stampFunction`. A batch is alive when it has balance left at the time of the settlement.
    function _stamp(ChunkInclusionProof memory p, IClaimPostage postage) internal view {
        bytes32 id = p.postageProof.postageId;
        (address owner, uint8 depth, uint8 bucketDepth, , , ) = postage.batches(id);
        if (owner == address(0) || !postage.isBatchAlive(id)) revert BatchNotAlive(id);

        uint32 postageIndex = uint32(p.postageProof.index);
        if (postageIndex >= (uint256(1) << (depth - bucketDepth))) revert IndexOutsideSet(id);

        uint64 postageBucket = uint32(p.postageProof.index >> 32);
        uint32 prefix = uint32(uint256(p.proveSegment) >> (256 - 32));
        if (postageBucket != uint64(prefix >> (32 - bucketDepth))) revert BucketDiffers(id);

        if (
            !Signatures.postageVerify(
                owner,
                p.postageProof.signature,
                p.proveSegment,
                id,
                p.postageProof.index,
                p.postageProof.timeStamp
            )
        ) revert SigRecoveryFailed(id);
    }

    /// `socFunction`.
    function _soc(ChunkInclusionProof memory p) internal pure {
        if (p.socProof.length == 0) return;
        SOCProof memory s = p.socProof[0];
        if (!Signatures.socVerify(s.signer, s.signature, s.identifier, s.chunkAddr)) {
            revert SocVerificationFailed(s.chunkAddr);
        }
        if (keccak256(abi.encodePacked(s.identifier, s.signer)) != p.proveSegment) {
            revert SocCalcNotMatching(s.chunkAddr);
        }
    }
}
