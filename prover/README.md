# prover/: off-chain side of ZK settlement

Rust workspace for running the storage incentives game off chain and settling it on chain with an SP1
proof. The design is in [docs/ZK-SETTLEMENT.md](../docs/ZK-SETTLEMENT.md); the contract is
[src/settlement/Settlement.sol](../src/settlement/Settlement.sol).

| Crate | What it is |
| --- | --- |
| `crates/vm` (`swarm-vm`) | The Redistribution VM: the game rules of `Redistribution.sol` as a pure function `run(RoundInput) -> PublicValues`. No chain, no zkVM dependency. Unit tested. |
| `program` | The SP1 program. Reads a `RoundInput`, runs the VM, commits the ABI-encoded `PublicValues`. About 10 lines. |
| `service` (`swarm-prover`) | The prover node: HTTP collector for commits and reveals, anchors each round on chain, builds the round input from chain state, proves, calls `settleRound`. |
| `service` (`node-sim`) | Simulated Bee nodes: commit, reveal, optionally lie, stay silent, or use the on-chain escape hatch. |

## Toolchain

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # Rust
curl -L https://sp1up.succinct.xyz | bash && sp1up               # SP1 (cargo prove + succinct toolchain)
brew install protobuf                                            # protoc, needed by sp1-sdk
```

Build, which also compiles the SP1 program through `service/build.rs`:

```bash
cd prover && cargo build --release
```

Run the tests:

```bash
cargo test -p swarm-vm
```

Print the program verification key, which Settlement must be deployed with when it uses a real verifier:

```bash
./target/release/swarm-prover vkey
```

## Proving modes

`SP1_PROVER` selects where proofs come from:

| Value | What happens | Use with |
| --- | --- | --- |
| `mock` | The zkVM still executes and the output is checked, but the proof is empty | `SP1MockVerifier` (`ZK_VERIFIER=mock`) |
| `cpu` | Real Groth16 proof on this machine. Slow, needs a lot of RAM | SP1 verifier gateway |
| `network` | Succinct Prover Network; needs `NETWORK_PRIVATE_KEY` with credits | SP1 verifier gateway |
| `cuda` | Local GPU | SP1 verifier gateway |

## Run it locally (anvil, mock proofs)

```bash
anvil --block-time 1                       # one round = 152 s

# repo root: deploy token, postage, oracle, staking, mock verifier, Settlement, roles, one batch
WALLET_SECRET=<any 64-hex> npx hardhat deploy --network zklocal

# stake 5 nodes (anvil accounts 1-5), then skip ahead so they are older than two rounds
export NODE_KEYS=0x59c6...690d,0x5de4...365a,0x7c85...07a6,0x47e1...926a,0x8b3a...ffba
npx hardhat run scripts/zk/setup-nodes.ts --network zklocal
cast rpc anvil_mine 0x190

cd prover
export RPC_URL=http://127.0.0.1:8545
export SETTLEMENT_ADDRESS=$(jq -r .address ../deployments/zklocal/Settlement.json)
SP1_PROVER=mock PROVER_PRIVATE_KEY=0xac09...ff80 DATA_DIR=data/zklocal ./target/release/swarm-prover serve
./target/release/node-sim --depth 0 --silent 3 --liar 4 --forced 2 --rounds 3
```

The full anvil keys are the standard `test test ... junk` mnemonic accounts.

## Run it on Sepolia

See [docs/ZK-SETTLEMENT.md, "Sepolia runbook"](../docs/ZK-SETTLEMENT.md#sepolia-runbook).

## What the prover writes

`$DATA_DIR/rounds/<round>/`:

- `messages.json`: every commit and reveal received, plus the list exactly as anchored. This is the
  stand-in for publishing the list to Swarm.
- `input.json`: the full `RoundInput` the VM ran on. Replay it with
  `./target/release/swarm-prover execute data/.../input.json` to get cycle counts, or add `--prove`.
- `proof.json`: public values, proof bytes, cycles, proving time.

## HTTP API

| Method | Path | Body | Accepted |
| --- | --- | --- | --- |
| `POST` | `/v1/commit` | `{round, owner, obfuscatedHash, signature}` | blocks 0-37 of the round; the signature must recover to `owner` |
| `POST` | `/v1/reveal` | `{round, overlay, depth, hash, nonce}` | blocks 57-113; must open an anchored commit |
| `GET` | `/v1/rounds/{round}` | | The anchored list (so a node can check it is in it), reveal count, settle tx |
| `GET` | `/v1/status` | | Block, round, phase offset |

`signature` is an EIP-191 `personal_sign` over `Settlement.commitDigest(round, obfuscatedHash)`, made
with the node's staking key.
