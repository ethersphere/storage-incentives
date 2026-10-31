# SP1 (current choice)

SP1 is the zkVM of Succinct. This branch uses SP1 6.9. The comparison with the other zkVMs is in
[../README.md](../README.md).

## How we use it

| Part | File |
| --- | --- |
| Guest program | `prover/program/src/main.rs` |
| Build of the guest | `prover/service/build.rs` (`sp1-build`) |
| Execute and prove | `prover/service/src/prover.rs` (`sp1-sdk`, blocking API) |
| Precompile patches | `prover/Cargo.toml`: `tiny-keccak` and `k256` from `sp1-patches`, tag `sp1-6.2.0` |
| On-chain verifier | `src/settlement/ISP1Verifier.sol`; `SP1MockVerifier.sol` for tests |
| Verifier address | `helper-hardhat-config.ts`: Groth16 gateway `0x397A5f7f3dBd538f23DE225B51f532c34448dA9B` (Sepolia) |

The guest reads a `RoundInput` with `sp1_zkvm::io::read`, runs `swarm_vm::run`, and writes the
ABI-encoded `PublicValues` with `sp1_zkvm::io::commit_slice`.

Settlement calls `verifyProof(programVKey, publicValues, proofBytes)`. `programVKey` is the output of
`swarm-prover vkey`. The key changes when the guest or the VM changes.

## Pipeline

1. Execute: the RISC-V binary (`riscv64im-succinct-zkvm-elf`) runs in the emulator.
2. Core STARK: SP1 proves the execution trace.
3. Recursion: SP1 makes the STARK small.
4. Wrap: a fixed circuit verifies the STARK.
5. Groth16 (BN254): the final proof for Ethereum, 356 bytes.

## Our measurements (2026-10-19, MacBook, CPU)

| Value | Result |
| --- | --- |
| Cycles, 5 participants, without patches | 11,782,493 |
| Cycles, 5 participants, with patches | 985,100 |
| Cycles for each participant | about 200k |
| Execute + STARK + recursion | about 4 min 50 s |
| Groth16 wrap | about 35 s (16.0M constraints) |
| Peak memory | 10.2 GB |
| Setup files (one time) | 7.8 GB in `~/.sp1/circuits/groth16/v6.1.0`, about 20 min download |
| Proof size | 356 bytes, selector `0x4388a21c` (v6.1.0) |
| Gas of `verifyProof` | 269,345 (SP1 v6.1.0 Groth16 verifier on anvil) |

## Prover options

| `SP1_PROVER` | Use |
| --- | --- |
| `mock` | Development. Use with `SP1MockVerifier` |
| `cpu` | Local CPU. Slow, about 10 GB memory |
| `cuda` | Local NVIDIA GPU |
| `network` | Succinct Prover Network. Set `NETWORK_PRIVATE_KEY` |

## Points to know

- The SP1 API changes between major versions. Pin the versions in `Cargo.toml`.
- The patch tags must match the SP1 version.
- The owner of `SP1VerifierGateway` can freeze a route. A frozen route cannot become active again.
  Refer to section 5 of [../README.md](../README.md).
- The `sp1-sdk` build needs `protoc` (`brew install protobuf`).
