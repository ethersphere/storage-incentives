// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/// @title SP1 Verifier Interface
/// @notice Copy of succinctlabs/sp1-contracts ISP1Verifier, re-declared with the repo's pragma.
/// On Ethereum and Sepolia the Groth16 SP1VerifierGateway lives at
/// 0x397A5f7f3dBd538f23DE225B51f532c34448dA9B (see sp1-contracts/contracts/deployments).
interface ISP1Verifier {
    function verifyProof(bytes32 programVKey, bytes calldata publicValues, bytes calldata proofBytes) external view;
}
