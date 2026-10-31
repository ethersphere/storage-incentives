# zkVM options for ZK settlement

This folder compares three zkVMs for the Swarm settlement prover: SP1, RISC Zero and ZisK.
Each zkVM has its own file:

- [sp1/README.md](sp1/README.md): the zkVM that this branch uses now.
- [risc0/README.md](risc0/README.md): RISC Zero.
- [zisk/README.md](zisk/README.md): ZisK, the prover of the Gnosis EEZ.

**Decision:** keep SP1 for the prototype and the Sepolia run. Do a benchmark of all three before the
mainnet decision. Section 4 gives the benchmark plan.

The facts in these files come from public documentation and from our own runs on 2026-10-19 to
2026-10-31. The three projects change fast. Examine the sources again before you use a fact in a
decision.

---

## 1. What is the same in all three

- You write the program in Rust. The compiler makes a RISC-V binary. The zkVM proves that the binary
  ran correctly on the inputs.
- The zkVM uses one general circuit (a RISC-V CPU). You do not write a circuit for each program.
- The first proof is a STARK. Recursion makes the STARK small. A SNARK wrap makes a proof that
  Ethereum can verify for a low gas cost.
- The trusted setup is for the fixed wrap circuit of the zkVM. It is not for our program. A change to
  our game rules does not need a new setup.
- Each zkVM has fast paths (precompiles) for keccak and secp256k1. Our program uses these two
  operations most. Phase 4 (storage witnesses) adds more keccak for the BMT hashes.

## 2. Comparison

| | SP1 | RISC Zero | ZisK |
| --- | --- | --- | --- |
| Team | Succinct | RISC Zero | ZisK (team of Jordi Baylina, from Polygon zkEVM) |
| Instruction set | RV64IM (v6) | RV32IM | RV64IMA |
| STARK | Hypercube (v6) | STARK with recursion | PIL2 / Plonky3-based STARK |
| SNARK wrap for Ethereum | Groth16 or PLONK (BN254) | Groth16 (BN254) | pilfflonk by default; PLONK or FFLONK as options |
| Ethereum verifier | `SP1VerifierGateway`, deployed on Ethereum and Sepolia | `RiscZeroVerifierRouter`, deployed on Ethereum and Sepolia | Solidity verifier files exist (`ZiskVerifier.sol`, PLONK). We did not find an official deployment |
| Verifier gas | about 270k (we measured 269,345) | about 250-300k (their figures) | Not known to us |
| Proof market | Succinct Prover Network | Boundless | No public market known to us |
| Ethereum state in the proof | `sp1-contract-call` | Steel | Not known to us |
| Local GPU | Yes (CUDA) | Yes (CUDA, Metal) | Yes (CUDA 12.9+) |
| macOS | Yes. Our CPU proof ran on a MacBook | Yes | Yes, but their docs say that proof generation is "not yet optimized" on macOS |
| Maturity | Production (rollups, Celestia Blobstream). Fast API changes between major versions | Production since 2024. Strong focus on audits and formal verification | The code is in audit. The README says that bugs can remain |
| Published speed | Real-time Ethereum blocks on about 16 GPUs (their claim) | No current figure known to us | 9.62 s p99 for Ethereum blocks on 4 RTX 5090 (their claim, workload not published) |
| License | MIT / Apache-2.0 | Apache-2.0 | MIT / Apache-2.0 |

"Not known to us" means that we did not find a public source. It does not mean that the feature does
not exist.

## 3. What a change of zkVM costs us

The game rules in `prover/crates/vm` do not use a zkVM. A change of zkVM touches only these files:

| File | Change |
| --- | --- |
| `prover/program/` | The input and output calls of the guest (about 10 lines) |
| `prover/service/src/prover.rs` | The SDK calls: execute, prove, read the proof bytes |
| `prover/service/build.rs` | The build step for the guest binary |
| `prover/Cargo.toml` | The keccak and k256 patches of the new zkVM |
| `src/settlement/Settlement.sol` | One call to the new verifier interface |
| `deploy/zk/001_deploy_settlement.ts`, `helper-hardhat-config.ts` | The verifier address |

We estimate about one day of work for RISC Zero. For ZisK, the estimate is less certain, because the
Ethereum verifier path is not clear to us yet.

## 4. Benchmark plan before mainnet

1. Port `prover/program/` to RISC Zero and to ZisK, each in a separate crate.
2. Make the same inputs for all three: `swarm-prover synth --nodes 10` and `--nodes 50`.
3. Run each input on the same rented NVIDIA GPU machine.
4. Send the same inputs to the Succinct Prover Network and to Boundless.
5. Record these values for each zkVM:
   - cycles,
   - time to the final on-chain proof,
   - peak memory,
   - size of the setup files,
   - cost for each proof on the market,
   - gas of the on-chain verification.
6. Record who controls the on-chain verifier router, and what that party can change.

## 5. Verifier router control

The verifier router is an upgrade key that Swarm does not control. Make this decision for each zkVM:

- **SP1:** The owner of `SP1VerifierGateway` can add a route and freeze a route. A frozen route cannot
  become active again. A route cannot be replaced. If Succinct freezes a route, our proofs for that
  version stop. The gateway cannot accept a false proof through an existing route.
- **RISC Zero:** RISC Zero manages the router. A `TimelockController` and a
  `RiscZeroVerifierEmergencyStop` contract are deployed for each network. Their docs say that they
  remove verifiers after security vulnerabilities.
- **ZisK:** We did not find an official router. Swarm can deploy the verifier contract itself, and then
  Swarm controls it.

For mainnet, select one of these:

1. Point Settlement at one specific verifier version, not at the router.
2. Keep the router, and put `Settlement.setVerifier` behind a timelock with an exit window.

## Sources

- SP1: [sp1-contracts](https://github.com/succinctlabs/sp1-contracts), `SP1VerifierGateway.sol` and
  `deployments/`; our measurements in [docs/ZK-SETTLEMENT.md](../../docs/ZK-SETTLEMENT.md).
- RISC Zero: [verifier contracts](https://dev.risczero.com/api/next/blockchain-integration/contracts/verifier),
  [risc0-build-ethereum](https://lib.rs/crates/risc0-build-ethereum), [Steel](https://github.com/boundless-xyz/steel).
- ZisK: [repository](https://github.com/0xPolygonHermez/zisk),
  [installation](https://0xpolygonhermez.github.io/zisk/getting_started/installation.html),
  [precompiles](https://0xpolygonhermez.github.io/zisk/getting_started/precompiles.html),
  [quickstart](https://0xpolygonhermez.github.io/zisk/getting_started/quickstart.html),
  [davinci-zkvm Solidity verifier](https://pkg.go.dev/github.com/vocdoni/davinci-zkvm/go-sdk/solidity),
  [CryptoSlate on the 4-GPU result](https://cryptoslate.com/ethereums-12-gpu-proving-problem-just-got-a-4-gpu-answer/),
  [EthCC talk summary](https://alearesearch.io/summit-digest/ethcc/jordi-baylina-polygon-cofounder-zisk-proving-in-real-time).
