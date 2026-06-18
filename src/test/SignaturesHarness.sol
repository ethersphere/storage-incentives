// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "../Util/Signatures.sol";

/// @dev Thin wrapper for unit-testing the Signatures library.
contract SignaturesHarness {
    function socVerify(
        address signer,
        bytes memory signature,
        bytes32 identifier,
        bytes32 chunkAddr
    ) external pure returns (bool) {
        return Signatures.socVerify(signer, signature, identifier, chunkAddr);
    }

    function postageVerify(
        address signer,
        bytes memory signature,
        bytes32 chunkAddr,
        bytes32 postageId,
        uint64 index,
        uint64 timeStamp
    ) external pure returns (bool) {
        return Signatures.postageVerify(signer, signature, chunkAddr, postageId, index, timeStamp);
    }
}
