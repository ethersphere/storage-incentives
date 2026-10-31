# RISC Zero

RISC Zero is a zkVM in production since 2024. This branch does not use it. This file tells what a
port needs. The comparison with the other zkVMs is in [../README.md](../README.md).

## Summary

| | |
| --- | --- |
| Instruction set | RV32IM |
| Proof pipeline | STARK, recursion, then Groth16 over BN254 |
| Ethereum verifier | `RiscZeroVerifierRouter` (with `RiscZeroVerifierEmergencyStop` and a `TimelockController`), deployed by RISC Zero |
| Verifier call | `verify(seal, imageId, sha256(journal))` |
| Program identity | `imageId` (the equivalent of the SP1 `programVKey`) |
| Precompiles | keccak, sha256, secp256k1 (k256), bigint and others, through patched crates |
| Ethereum state in the proof | Steel ([boundless-xyz/steel](https://github.com/boundless-xyz/steel)) |
| Proof market | Boundless |
| Local GPU | CUDA; Metal on macOS |
| Development mode | `RISC0_DEV_MODE=1` (fake receipts, like the SP1 `mock` mode) |
| Latest release that we found | 3.0.x for `risc0-build-ethereum` (August 2025). Examine the GitHub releases for a newer version |

## Port plan

1. Make a guest crate. Read `RoundInput` with `risc0_zkvm::guest::env::read`. Write the ABI-encoded
   `PublicValues` to the journal with `env::commit_slice`.
2. Build the guest with `risc0-build` in `build.rs`. Read the `imageId` from the generated
   `methods` crate.
3. In `prover.rs`, use `default_prover().prove_with_opts(env, ELF, &ProverOpts::groth16())`. Encode
   the seal with `risc0-ethereum-contracts` (`encode_seal`).
4. Replace the keccak and k256 patches in `prover/Cargo.toml` with the RISC Zero patches.
5. In `Settlement.sol`, replace the verifier call:

   ```solidity
   // SP1
   verifier.verifyProof(programVKey, _publicValues, _proofBytes);
   // RISC Zero
   riscZeroVerifier.verify(_proofBytes /* seal */, imageId, sha256(_publicValues));
   ```

6. Set the router address for Sepolia in `helper-hardhat-config.ts`. Take the address from the RISC
   Zero docs.

The `PublicValues` layout, the round rules and the contract checks do not change.

## Points to know

- The journal digest is SHA-256, not keccak. Settlement must hash the public values with `sha256`.
- The router removes a verifier version after a security vulnerability. Old proofs for that version
  then fail.
- Steel is the most mature library to read Ethereum state inside a proof. This is important if we
  move the stake reads of `settleRound` into the proof.

## Sources

- [Verifier contracts](https://dev.risczero.com/api/next/blockchain-integration/contracts/verifier)
- [risc0-build-ethereum releases](https://lib.rs/crates/risc0-build-ethereum)
- [Steel](https://github.com/boundless-xyz/steel)
