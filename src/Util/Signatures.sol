// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

library Signatures {
    /** Hash of the message to sign */
    function getPostageMessageHash(
        bytes32 _chunkAddr,
        bytes32 _batchId,
        uint64 _index,
        uint64 _timeStamp
    ) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(_chunkAddr, _batchId, _index, _timeStamp));
    }

    function postageVerify(
        address _signer, // signer Ethereum address to check against
        bytes memory _signature,
        bytes32 _chunkAddr,
        bytes32 _postageId,
        uint64 _index,
        uint64 _timeStamp
    ) internal pure returns (bool) {
        bytes32 messageHash = getPostageMessageHash(_chunkAddr, _postageId, _index, _timeStamp);
        bytes32 ethMessageHash = getEthSignedMessageHash(messageHash);

        return verifySignature(ethMessageHash, _signature, _signer);
    }

    function getEthSignedMessageHash(bytes32 _messageHash) internal pure returns (bytes32) {
        /*
        Signature is produced by signing a keccak256 hash with the following format:
        "\x19Ethereum Signed Message\n" + len(msg) + msg
        */
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", _messageHash));
    }

    function verifySignature(
        bytes32 _ethSignedMessageHash, // it has to be prefixed message: https://ethereum.stackexchange.com/questions/19582/does-ecrecover-in-solidity-expects-the-x19ethereum-signed-message-n-prefix/21037
        bytes memory _signature,
        address _signer
    ) internal pure returns (bool) {
        (address recovered, ECDSA.RecoverError error) = ECDSA.tryRecover(_ethSignedMessageHash, _signature);
        return error == ECDSA.RecoverError.NoError && recovered == _signer;
    }

    function getSocMessageHash(bytes32 _identifier, bytes32 _chunkAddr) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(_identifier, _chunkAddr));
    }

    function socVerify(
        address _signer, // signer Ethereum address to check against
        bytes memory _signature,
        bytes32 _identifier,
        bytes32 _chunkAddr
    ) internal pure returns (bool) {
        bytes32 messageHash = getSocMessageHash(_identifier, _chunkAddr);
        bytes32 ethMessageHash = getEthSignedMessageHash(messageHash);

        return verifySignature(ethMessageHash, _signature, _signer);
    }
}
