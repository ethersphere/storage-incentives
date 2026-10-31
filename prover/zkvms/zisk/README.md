# ZisK

ZisK is a zkVM from the team of Jordi Baylina, who made Circom and worked on Polygon zkEVM. ZisK is
the prover of the Gnosis EEZ. This branch does not use it. This file tells what we know and what a port
needs. The comparison with the other zkVMs is in [../README.md](../README.md).

## Summary

| | |
| --- | --- |
| Instruction set | RV64IMA (target `riscv64ima-zisk-zkvm-elf`) |
| Proof pipeline | STARK (PIL2, Plonky3-based), aggregation, a compressed proof, then a final SNARK |
| Final SNARK | pilfflonk by default. PLONK or FFLONK with a Poseidon key and `--final-snark`. The SNARK setup needs a powers-of-tau file |
| Ethereum verifier | Solidity verifier files exist (`ZiskVerifier.sol` and `PlonkVerifier.sol`, used by the davinci-zkvm SDK). We did not find an official deployment or router |
| Precompiles | keccak-f, sha256-f, BLAKE2/BLAKE3, Poseidon, 256/384-bit arithmetic, secp256k1, secp256r1, BN254, BLS12-381, Ed25519, Babyjubjub curve operations |
| Patched crates | `tiny-keccak` (branch `zisk` of `zisk-patch-tiny-keccak`). A patched `k256` was not in the docs that we read |
| Ethereum state in the proof | Not known to us |
| Proof market | Not known to us |
| Local GPU | NVIDIA, driver 525.60.13+, CUDA Toolkit 12.9+ |
| Platforms | Ubuntu 22.04+, macOS 14+. The docs say that proof generation on macOS is "not yet optimized" |
| Status | The code is in audit. The README says that bugs and vulnerabilities can remain |
| Published speed | 9.62 s p99 for Ethereum blocks on 4 RTX 5090 (their claim; the workload is not published) |

## Port plan

1. Install with `ziskup`. Select the proving key and the SNARK key (`ziskup setup_snark`).
2. Make a project with `cargo-zisk new`. The template has the crates `common`, `guest` and `host`.
3. Move the guest code: read `RoundInput`, run `swarm_vm::run`, write the ABI-encoded `PublicValues`
   as the public output. Use the `ziskos` input and output functions.
4. Add the ZisK `tiny-keccak` patch. Measure the cycles of the secp256k1 recovery without a patched
   `k256`. If the cost is high, write a patch on top of the secp256k1 precompile.
5. Make the final SNARK. Deploy the matching `ZiskVerifier.sol` on Sepolia. Swarm then owns the
   verifier, so no third party can freeze it.
6. In `Settlement.sol`, replace the verifier call with the ZisK verifier interface. The davinci-zkvm
   SDK shows these inputs: program verification key, root commitment, public values and proof bytes.

## Open questions

- What is the gas cost of the ZisK verifier on Ethereum?
- Does ZisK publish a stable, versioned Solidity verifier with a deployment, like SP1 and RISC Zero?
- Is a patched `k256` available? Our program does one secp256k1 recovery for each participant.
- What is the time to a final SNARK for a program of about 2M cycles? The published numbers are for
  Ethereum blocks.
- Is there a link to the Gnosis team or the EEZ that gives us support or shared infrastructure?

## Sources

- [Repository](https://github.com/0xPolygonHermez/zisk)
- [Installation](https://0xpolygonhermez.github.io/zisk/getting_started/installation.html)
- [Precompiles](https://0xpolygonhermez.github.io/zisk/getting_started/precompiles.html)
- [Quickstart](https://0xpolygonhermez.github.io/zisk/getting_started/quickstart.html)
- [davinci-zkvm Solidity verifier](https://pkg.go.dev/github.com/vocdoni/davinci-zkvm/go-sdk/solidity)
- [CryptoSlate: the 4-GPU result](https://cryptoslate.com/ethereums-12-gpu-proving-problem-just-got-a-4-gpu-answer/)
- [EthCC talk summary](https://alearesearch.io/summit-digest/ethcc/jordi-baylina-polygon-cofounder-zisk-proving-in-real-time)
- [L1-zkEVM roadmap 2026](https://ethereum-magicians.org/t/l1-zkevm-roadmap-2026-integrating-zkevm-proofs-into-ethereums-core-protocol/27595)
