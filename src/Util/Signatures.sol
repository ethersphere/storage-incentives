// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

library Signatures {
    error InvalidSignatureLength();

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

        return recoverSigner(ethMessageHash, _signature) == _signer;
    }

    function getEthSignedMessageHash(bytes32 _messageHash) internal pure returns (bytes32) {
        /*
        Signature is produced by signing a keccak256 hash with the following format:
        "\x19Ethereum Signed Message\n" + len(msg) + msg
        */
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", _messageHash));
    }

    function recoverSigner(
        bytes32 _ethSignedMessageHash, // it has to be prefixed message: https://ethereum.stackexchange.com/questions/19582/does-ecrecover-in-solidity-expects-the-x19ethereum-signed-message-n-prefix/21037
        bytes memory _signature
    ) internal pure returns (address) {
        (bytes32 r, bytes32 s, uint8 v) = splitSignature(_signature);

        return ecrecover(_ethSignedMessageHash, v, r, s);
    }

    function splitSignature(bytes memory sig) internal pure returns (bytes32 r_, bytes32 s_, uint8 v_) {
        if (sig.length != 65) {
            revert InvalidSignatureLength();
        }

        assembly {
            /*
            verbose explanation: https://ethereum.stackexchange.com/questions/135591/split-signature-function-in-solidity-by-example-docs
            First 32 bytes stores the length of the signature
            add(sig, 32) = pointer of sig + 32
            effectively, skips first 32 bytes of signature
            mload(p) loads next 32 bytes starting at the memory address p into memory
            */

            // first 32 bytes, after the length prefix
            r_ := mload(add(sig, 32))
            // second 32 bytes
            s_ := mload(add(sig, 64))
            // final byte (first byte of the next 32 bytes)
            v_ := byte(0, mload(add(sig, 96)))
        }

        // implicitly return (r, s, v)
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

        return recoverSigner(ethMessageHash, _signature) == _signer;
    }
}
