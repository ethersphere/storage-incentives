# prover/: off-chain side of ZK settlement

Rust workspace for running the storage incentives game off chain and settling it on chain with an SP1
proof. The design is in [docs/ZK-SETTLEMENT.md](../docs/ZK-SETTLEMENT.md); the contract is
[src/settlement/Settlement.sol](../src/settlement/Settlement.sol).

| Crate | What it is |
| --- | --- |
| `crates/vm` (`swarm-vm`) | The Redistribution VM as a pure function `run(RoundInput) -> PublicValues`: the game of `Redistribution.sol` (`lib.rs`), the storage evidence of `claim` (`claim.rs`, `bmt.rs`), and the postage accounting that `PostageStamp.expireLimited` did on chain (`postage.rs`). No chain, no zkVM dependency. Unit tested, and checked against the real contracts with test vectors. |
| `program` | The SP1 program. Reads a `RoundInput`, runs the VM, commits the ABI-encoded `PublicValues`. About 10 lines. |
| `service` (`swarm-prover`) | The prover node: HTTP collector for commits, reveals and claim witnesses; anchors each round on chain; builds the round input from chain state (including the PostageStampZK event log); proves; calls `settleRound`. |
| `service` (`node-sim`) | Simulated Bee nodes: a shared simulated reserve, commit, reveal, claim proofs; optionally lie, stay silent, withhold the claim, or use the on-chain escape hatches. |

The zkVM is SP1. A comparison with RISC Zero and ZisK, and a port plan for each, is in
[zkvms/README.md](zkvms/README.md).

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

The tests include two cross-checks with the real contracts. The vectors are in
`crates/vm/tests/vectors/`. To make them again (repository root):

```bash
DUMP_CLAIM_VECTORS=1 npx hardhat test test/Redistribution.test.ts --grep "should claim pot by"
DUMP_POSTAGE_VECTORS=1 npx hardhat test test/PostageStampZK.test.ts
```

Measure the zkVM cycles of a synthetic round (no proof):

```bash
./target/release/swarm-prover synth --nodes 10 --batches 1000 --out /tmp/round.json
SP1_PROVER=mock ./target/release/swarm-prover execute /tmp/round.json
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
| `network` | Succinct Prover Network; needs `NETWORK_PRIVATE_KEY` and a PROVE balance | SP1 verifier gateway |
| `cuda` | Local NVIDIA GPU | SP1 verifier gateway |

## Use the Succinct Prover Network

Measured on 2026-11-03: a 10-participant round with a claim and 100 live batches was proved in 42 s for at
most about 0.40 PROVE (docs/ZK-SETTLEMENT.md, section 5).

1. Make a requester key in a terminal outside the chat: `cast wallet new`. Do not use a wallet that holds
   other funds; the key is stored in a plain text file.
2. Buy PROVE with any wallet. In the Succinct Explorer (explorer.succinct.xyz), connect that wallet,
   deposit the PROVE (Account, Deposit), and use Transfer to move the balance to the requester address.
3. Write `prover/.env` (git ignores it):

   ```
   SP1_PROVER=network
   NETWORK_PRIVATE_KEY=0x...
   NETWORK_RPC_URL=https://rpc.mainnet.succinct.xyz
   ```

   Use `rpc.mainnet.succinct.xyz`. SP1 SDK 6.x sends PROVE-paid requests there. The older URL
   `rpc.production.succinct.xyz` accepts the program registration but then fails with `Unimplemented`.
   You can also remove the line: the SDK uses the mainnet URL by default.
4. Run from `prover/`, so the program finds `.env`:

   ```bash
   ./target/release/swarm-prover execute --prove input.json
   ```

   The log shows the request id and an Explorer link.

## Run the prover on a rented GPU

A laptop CPU is too slow for real proofs (section 5 of docs/ZK-SETTLEMENT.md). Use a rented NVIDIA GPU
machine, or the Succinct Prover Network. These steps prove a saved round input. They do not need a chain.

1. Rent a Linux machine with an NVIDIA GPU with 24 GB memory or more (for example RTX 4090, L40S, A100 or
   H100), at least 64 GB RAM and 100 GB disk. Use Ubuntu 22.04 or 24.04.
2. Install the NVIDIA driver and the CUDA toolkit. Check the CUDA version that SP1 6.x needs in the SP1
   documentation ("Hardware acceleration" / "CUDA"). Check with `nvidia-smi`.
3. Install Docker and the NVIDIA container toolkit if the SP1 documentation for your SP1 version says
   that the CUDA prover runs in a container.
4. Install the toolchain:

   ```bash
   sudo apt-get install -y build-essential pkg-config libssl-dev protobuf-compiler git jq
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
   curl -L https://sp1up.succinct.xyz | bash && ~/.sp1/bin/sp1up
   ```

5. Get the code and build:

   ```bash
   git clone -b feat/zk-settlement https://github.com/ethersphere/storage-incentives.git
   cd storage-incentives/prover && cargo build --release
   ```

6. Copy a round input to the machine, for example `data/zklocal/rounds/6/input.json` from a local run,
   or make one with `synth`.
7. Prove it:

   ```bash
   SP1_PROVER=cuda RUST_LOG=info ./target/release/swarm-prover execute --prove input.json
   ```

   The first Groth16 proof downloads the SP1 circuit files (about 3.5 GB compressed, 7.8 GB on disk) to
   `~/.sp1/circuits`. Later proofs use them again.
8. The result is `input.proof.json`: public values, proof bytes, cycles and proof time. Verify it against
   the SP1 Groth16 verifier, for example on anvil:

   ```bash
   cast call <SP1VerifierGroth16> "verifyProof(bytes32,bytes,bytes)" \
     $(jq -r .vkey input.proof.json) $(jq -r .publicValues input.proof.json) $(jq -r .proof input.proof.json)
   ```

To prove for a live Settlement, run `swarm-prover serve` on the GPU machine with `SP1_PROVER=cuda`, or
run it anywhere with `SP1_PROVER=network` and `NETWORK_PRIVATE_KEY`.

The GPU instructions are not yet tested on a real machine. Record the actual steps and times when you
do the first run, and correct this section.

## Shadow mode: replay Gnosis rounds

`gnosis-shadow` replays real Gnosis Chain Redistribution rounds through the VM and compares truth, winner
and freezes with what Redistribution did (docs/ZK-SETTLEMENT.md, section 5, "Robustness tests"):

```bash
GNOSIS_RPC_URL=https://rpc.gnosischain.com ./target/release/gnosis-shadow --rounds 3000
```

It exits with an error when a round differs. `--wrong-seed` is a negative control: rounds must then
differ.

## Run it locally (anvil, mock proofs)

```bash
anvil --block-time 1                       # one round = 64 s

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

To test the censorship escape hatches, start the prover as a censoring prover. It leaves the commits of
`CENSOR_COMMITS` out of the anchored commit list, and the reveals of `CENSOR_REVEALS` out of the anchored
reveal list. Use these options for tests only.

```bash
CENSOR_COMMITS=<node 0 address> CENSOR_REVEALS=<node 1 address> SP1_PROVER=mock ... ./target/release/swarm-prover serve
./target/release/node-sim --depth 0 --rounds 3
```

node-sim finds that it is missing from the anchored lists. Node 0 then calls `forceCommit`, and node 1
calls `forceReveal`. No node gets a freeze.

## Run it on Sepolia

See [docs/ZK-SETTLEMENT.md, "Sepolia runbook"](../docs/ZK-SETTLEMENT.md#6-sepolia-runbook).

## What the prover writes

`$DATA_DIR/rounds/<round>/`:

- `messages.json`: every commit and reveal received, plus the list exactly as anchored. This is the
  stand-in for publishing the list to Swarm.
- `input.json`: the full `RoundInput` the VM ran on. Replay it with
  `./target/release/swarm-prover execute data/.../input.json` to get cycle counts, or add `--prove`.
- `proof.json`: public values, proof bytes, cycles, proving time.

`$DATA_DIR/postage/<hash>.json`: the postage state after each settlement: the header (tree root, live
chunks, last cut, last price change) and every leaf of the batch tree. Settlement stores only the
header's hash. The next settlement starts from this file, and the prover builds the zkVM witness (Merkle
proofs of the touched leaves) from it. Do not delete it. Set `POSTAGE_FROM_BLOCK` to the PostageStampZK deployment block, so the first settlement does
not search the log from block 0.

## HTTP API

| Method | Path | Body | Accepted |
| --- | --- | --- | --- |
| `POST` | `/v1/commit` | `{round, owner, obfuscatedHash, signature}` | blocks 0-15 of the round; the signature must recover to `owner` |
| `POST` | `/v1/reveal` | `{round, overlay, depth, hash, nonce}` | blocks 24-47; must open an anchored commit |
| `POST` | `/v1/claim` | `{round, witness}` | after the seed block, until the round settles; the prover runs the VM with the witness and accepts it only if the claim is valid |
| `GET` | `/v1/rounds/{round}` | | The anchored list (so a node can check it is in it), reveal count, settle tx |
| `GET` | `/v1/rounds/{round}/outcome` | | After the seed block: truth, winner, anchor, seed, and whether a valid claim is known |
| `GET` | `/v1/status` | | Block, round, phase offset |

`signature` is an EIP-191 `personal_sign` over `Settlement.commitDigest(round, obfuscatedHash)`, made
with the node's staking key.
