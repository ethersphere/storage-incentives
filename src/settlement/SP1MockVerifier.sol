// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {ISP1Verifier} from "./ISP1Verifier.sol";

/// @title SP1 Mock Verifier
/// @notice Accepts any public values with an empty proof. Same behaviour as succinctlabs' SP1MockVerifier;
/// used for local runs and for testnet runs with SP1_PROVER=mock. Never deploy it as the verifier of a
/// Settlement that holds real value.
contract SP1MockVerifier is ISP1Verifier {
    function verifyProof(bytes32, bytes calldata, bytes calldata proofBytes) external pure {
        assert(proofBytes.length == 0);
    }
}
