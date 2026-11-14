// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.19;

/// @notice Accepts every proof. For contract tests only: never deploy it on a real network.
contract Groth16MockVerifier {
    function verifyProof(bytes calldata, uint256[1] calldata) external pure {}
}
