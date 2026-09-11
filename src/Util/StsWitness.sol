// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import "./TransformedChunkProof.sol";
import "./ChunkProof.sol";
import "./Signatures.sol";
import "./StsMath.sol";
import "./StsTypes.sol";
import "../interface/IPostageStamp.sol";

/**
 * @title STS-1 stamp witness verification
 * @author The Swarm Authors
 * @dev SWIP-050 Appendix A.7 and A.8. Split out of Redistribution as a deployed library: the
 * contract exceeds the EIP-170 24 KiB limit with this code inlined, at every optimizer setting.
 *
 * Functions here report failure through a code in {Result} rather than reverting. The revert is
 * raised by Redistribution, so every custom error stays in the redistribution contract's own ABI
 * and remains decodable by clients that only know that contract.
 */
library StsWitness {
    // Failure codes. FAIL_NONE means the witness passed.
    uint8 internal constant FAIL_NONE = 0;
    uint8 internal constant FAIL_POSITION = 1; // opened position outside the sample
    uint8 internal constant FAIL_INCLUSION = 2; // stamp sample inclusion proof failed
    uint8 internal constant FAIL_ORDER = 3; // not ordered against an immediate neighbour
    uint8 internal constant FAIL_BALANCE = 4; // batch below the round's fixed balance threshold
    uint8 internal constant FAIL_INDEX = 5; // index outside the range that existed at sampling start
    uint8 internal constant FAIL_BUCKET = 6; // postage bucket differs from the chunk address bucket
    uint8 internal constant FAIL_SIGNATURE = 7; // batch owner signature recovery failed
    uint8 internal constant FAIL_PROXIMITY = 8; // stamped chunk outside the reported depth
    uint8 internal constant FAIL_SISTER_SEGMENT = 9; // first sister segment differs between the two proofs
    uint8 internal constant FAIL_ORIGINAL_ADDRESS = 10; // opened data does not hash to the ordinary address
    uint8 internal constant FAIL_CHUNK_MISMATCH = 11; // ordinary address is not the stamped chunk address
    uint8 internal constant FAIL_SOC_SIGNATURE = 12; // SOC attestation signature failed
    uint8 internal constant FAIL_SOC_ADDRESS = 13; // SOC address does not match the attestation
    uint8 internal constant FAIL_MEMBERSHIP = 14; // transformed chunk address is not in chunkTransformRoot

    uint32 internal constant STAMP_SAMPLE_SIZE = 16;

    /**
     * @dev Everything about the round that the witness is judged against. All of it is fixed
     * before the participant can choose what to open.
     */
    struct Context {
        // Orders transformed stamp values; created by the first stage one reveal of this round.
        bytes32 stampAnchor;
        // The round anchor this round consumes; transforms chunk addresses.
        bytes32 roundAnchor;
        // Selects the chunk segment each witness must open; created by the first stage two reveal.
        bytes32 proofSeed;
        // The participant's committed stamp sample hash.
        bytes32 stampHash;
        // The participant's committed chunk transform root.
        bytes32 chunkTransformRoot;
        uint8 claimedDepth;
        uint256 samplingStart;
        uint256 requiredNormalisedBalance;
        IPostageStamp postageContract;
    }

    struct Result {
        uint8 failure;
        // Batch id for postage failures, transformed chunk address for binding failures.
        bytes32 subject;
        bytes32 transformedStamp;
        uint256 indexRatioQ64;
    }

    /**
     * @notice Apply the two STS-1 coefficients to a base stake density.
     * @dev Returns zero when the density witness is not below the sample ceiling, which the
     * caller turns into a rejected proof. Deployed here rather than inlined so the cube root
     * search does not count against the redistribution contract's EIP-170 budget.
     */
    function weightFor(
        uint256 baseStakeDensity,
        uint256 densityValue,
        uint256 densityLimit,
        uint256 sumIndexRatioQ64,
        uint256 witnessCount
    ) public pure returns (uint256) {
        uint256 densityCoefficient = StsMath.stampDensityCoefficientQ64(densityValue, densityLimit);
        if (densityCoefficient == 0) {
            return 0;
        }

        uint256 weight = StsMath.applyCoefficient(baseStakeDensity, densityCoefficient);
        return StsMath.applyCoefficient(weight, StsMath.utilizationCoefficientQ64(sumIndexRatioQ64, witnessCount));
    }

    /**
     * @notice Verify one opened stamp witness end to end.
     * @dev Four links, in order: the transformed stamp value sits at the opened position of the
     * committed sample and is ordered against its neighbours; the batch and index were inside
     * this round's SWIP-049 scope and the batch owner signed for this chunk address; the first
     * anchor transformed chunk address comes from the same opened data as that chunk address;
     * and that transformed address was already a leaf of the stage one chunk transform root.
     */
    function verifyWitness(StampProof calldata proof, Context memory ctx) public view returns (Result memory result) {
        result.transformedStamp = keccak256(abi.encodePacked(ctx.stampAnchor, proof.postageId, proof.index));

        result.failure = _verifyElement(ctx.stampHash, result.transformedStamp, proof.proofSegments, proof.sampleIndex);
        if (result.failure != FAIL_NONE) return result;

        result.failure = _verifyLocalOrder(ctx.stampHash, result.transformedStamp, proof);
        if (result.failure != FAIL_NONE) return result;

        uint256 slotsPerBucket;
        (result.failure, result.subject, slotsPerBucket) = _verifyPostage(proof, ctx);
        if (result.failure != FAIL_NONE) return result;

        bytes32 transformedChunkAddress;
        (result.failure, transformedChunkAddress) = _verifyChunkBinding(proof, ctx);
        if (result.failure != FAIL_NONE) {
            result.subject = transformedChunkAddress;
            return result;
        }

        result.indexRatioQ64 = StsMath.mulDivUp(uint256(uint32(proof.index)) + 1, StsMath.Q64, slotsPerBucket);
    }

    /**
     * @notice Prove one value sits at one position of the committed 16 entry stamp sample.
     */
    function _verifyElement(
        bytes32 root,
        bytes32 value,
        bytes32[] calldata proofSegments,
        uint32 sampleIndex
    ) private pure returns (uint8) {
        if (sampleIndex >= STAMP_SAMPLE_SIZE) {
            return FAIL_POSITION;
        }

        bytes32 calculated = BMTChunk.chunkAddressFromInclusionProof(
            proofSegments,
            value,
            sampleIndex,
            uint64(STAMP_SAMPLE_SIZE) * 32
        );

        return calculated == root ? FAIL_NONE : FAIL_INCLUSION;
    }

    /**
     * @notice Prove the opened value is ordered against its immediate neighbours in the sample.
     * @dev Local only. With three opened positions at most eight of sixteen slots are
     * constrained, so this is not a proof that the whole sample is sorted. It mirrors what the
     * chunk side order check already does.
     */
    function _verifyLocalOrder(bytes32 root, bytes32 value, StampProof calldata proof) private pure returns (uint8) {
        if (proof.sampleIndex > 0) {
            if (!proof.hasLeftValue || uint256(proof.leftValue) >= uint256(value)) {
                return FAIL_ORDER;
            }
            uint8 failure = _verifyElement(root, proof.leftValue, proof.leftProofSegments, proof.sampleIndex - 1);
            if (failure != FAIL_NONE) return failure;
        }

        if (proof.sampleIndex + 1 < STAMP_SAMPLE_SIZE) {
            if (!proof.hasRightValue || uint256(value) >= uint256(proof.rightValue)) {
                return FAIL_ORDER;
            }
            uint8 failure = _verifyElement(root, proof.rightValue, proof.rightProofSegments, proof.sampleIndex + 1);
            if (failure != FAIL_NONE) return failure;
        }

        return FAIL_NONE;
    }

    /**
     * @notice Ordinary stamp checks, all made against this round's SWIP-049 fixed scope.
     * @dev SWIP-050 Appendix A.8 also rejects a batch whose bucket depth is below the claimed
     * depth. That is dropped: bucket depth is fixed at creation and is 16 for essentially every
     * live batch, so the check would reject every real batch at any realistic storage depth, and
     * the neighbourhood binding it appears to reach for is already provided by the bucket
     * alignment check plus the proximity check below. See docs/SWIP-49-50-SCRUTINY.md 2.3.
     */
    function _verifyPostage(
        StampProof calldata proof,
        Context memory ctx
    ) private view returns (uint8, bytes32, uint256 slotsPerBucket) {
        // Reverts on an absent, expired, or not-yet-existing batch; that is SWIP-049's own error
        // surface and is deliberately passed straight through.
        (address batchOwner, uint8 depthAtSamplingStart, uint8 bucketDepth, uint256 normalisedBalance) = ctx
            .postageContract
            .redistributionBatchAt(proof.postageId, ctx.samplingStart);

        if (normalisedBalance < ctx.requiredNormalisedBalance) {
            return (FAIL_BALANCE, proof.postageId, 0);
        }

        slotsPerBucket = 1 << (depthAtSamplingStart - bucketDepth);
        if (uint256(uint32(proof.index)) >= slotsPerBucket) {
            return (FAIL_INDEX, proof.postageId, 0);
        }

        uint32 addressBucket = uint32(uint256(proof.chunkAddress) >> (256 - 32)) >> (32 - bucketDepth);
        if (uint32(proof.index >> 32) != addressBucket) {
            return (FAIL_BUCKET, proof.postageId, 0);
        }

        if (
            !Signatures.postageVerify(
                batchOwner,
                proof.signature,
                proof.chunkAddress,
                proof.postageId,
                proof.index,
                proof.timeStamp
            )
        ) {
            return (FAIL_SIGNATURE, proof.postageId, 0);
        }

        if (ctx.claimedDepth != 0) {
            if (uint256(proof.chunkAddress ^ ctx.roundAnchor) >= uint256(2 ** (256 - ctx.claimedDepth))) {
                return (FAIL_PROXIMITY, proof.postageId, 0);
            }
        }

        return (FAIL_NONE, proof.postageId, slotsPerBucket);
    }

    /**
     * @notice Bind the stamped chunk into this participant's own stage one chunk root.
     * @dev The stamp proves an ordinary chunk address. This proves the same-data relation: one
     * segment of the chunk, opened at a position the participant could not predict when it fixed
     * its root, hashes to that ordinary address under the plain BMT and to the transformed
     * address under the round's first anchor. Only that transformed result may then be offered
     * as a chunk root leaf.
     */
    function _verifyChunkBinding(
        StampProof calldata proof,
        Context memory ctx
    ) private pure returns (uint8, bytes32 transformedChunkAddress) {
        ChunkDataProof calldata chunkProof = proof.chunkProof;

        uint256 segmentIndex = uint256(
            keccak256(abi.encodePacked(ctx.proofSeed, proof.chunkAddress, bytes32("STS1_CHUNK_SEGMENT")))
        ) % 128;

        transformedChunkAddress = TransformedBMTChunk.transformedChunkAddressFromInclusionProof(
            chunkProof.proofSegments3,
            chunkProof.proveSegment2,
            segmentIndex,
            chunkProof.chunkSpan,
            ctx.roundAnchor
        );

        if (chunkProof.proofSegments2[0] != chunkProof.proofSegments3[0]) {
            return (FAIL_SISTER_SEGMENT, transformedChunkAddress);
        }

        bytes32 ordinaryChunkAddress = chunkProof.socProof.length > 0
            ? chunkProof.socProof[0].chunkAddr
            : chunkProof.proveSegment;

        if (
            ordinaryChunkAddress !=
            BMTChunk.chunkAddressFromInclusionProof(
                chunkProof.proofSegments2,
                chunkProof.proveSegment2,
                segmentIndex,
                chunkProof.chunkSpan
            )
        ) {
            return (FAIL_ORIGINAL_ADDRESS, transformedChunkAddress);
        }

        if (ordinaryChunkAddress != proof.chunkAddress) {
            return (FAIL_CHUNK_MISMATCH, transformedChunkAddress);
        }

        if (chunkProof.socProof.length > 0) {
            if (
                !Signatures.socVerify(
                    chunkProof.socProof[0].signer,
                    chunkProof.socProof[0].signature,
                    chunkProof.socProof[0].identifier,
                    chunkProof.socProof[0].chunkAddr
                )
            ) {
                return (FAIL_SOC_SIGNATURE, chunkProof.socProof[0].chunkAddr);
            }

            if (
                keccak256(abi.encodePacked(chunkProof.socProof[0].identifier, chunkProof.socProof[0].signer)) !=
                chunkProof.proveSegment
            ) {
                return (FAIL_SOC_ADDRESS, chunkProof.socProof[0].chunkAddr);
            }

            // For a SOC the transformed value is hashed together with the SOC address, matching
            // how the sample itself is constructed.
            transformedChunkAddress = keccak256(abi.encode(chunkProof.proveSegment, transformedChunkAddress));
        }

        if (!MerkleProof.verify(proof.chunkTransformProofSegments, ctx.chunkTransformRoot, transformedChunkAddress)) {
            return (FAIL_MEMBERSHIP, transformedChunkAddress);
        }

        return (FAIL_NONE, transformedChunkAddress);
    }
}
