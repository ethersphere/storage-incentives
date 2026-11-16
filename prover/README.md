# prover/: the off-chain side of SNARK settlement

In SNARK settlement, the storage incentives game of `Redistribution.sol` runs off chain. The nodes send
their commits, reveals and claim witnesses to a prover. A claim witness is the storage evidence of the
winner: three chunks of its reserve sample (a set of chunks that the node stores), with their proofs. The
prover proves the result of each round with a SNARK: a short proof that a contract can check for a fixed
gas cost. Gas is the unit of the cost of a transaction. The proof system is Groth16. The contract
[src/settlement/Settlement.sol](../src/settlement/Settlement.sol) checks the proof and pays the winner. The design is in [docs/SNARK-SETTLEMENT.md](../docs/SNARK-SETTLEMENT.md).

This directory holds the circuit, the Rust reference of the game, and the prover service. A circuit is a
fixed set of equations (constraints) that describes one computation.

| Part | What it is |
| --- | --- |
| `snark/` (Go module `swarm-snark`) | The game circuit, written with the gnark library (`circuit/`), and the tool `snarkd` (`cmd/snarkd`). `snarkd` makes the keys of a circuit size, makes Groth16 proofs, and runs as a proof daemon for the prover service. |
| `crates/vm` (`swarm-vm`) | The Rust reference of the game. `src/snark` computes the result of a round and the witness of the circuit (the private inputs of the proof). `claim.rs` and `bmt.rs` do the same claim checks as `ClaimVerifier.sol`: the prover runs them to know if a claim witness will pass on chain. `sample.rs` makes a reserve sample and a claim witness for `node-sim`. The binary `snark_synth` writes the witness of a synthetic round. |
| `service` (`swarm-prover`) | The prover service. `swarm-prover serve` collects commits, reveals and claim witnesses over HTTP, anchors the commit and reveal lists on chain, builds the round input from the chain state, gets a proof from `snarkd serve`, and calls `settleRound`. `swarm-prover stamp` shows, buys or tops up the postage batch (prepaid storage on Swarm) for the uploads. |
| `service` (`node-sim`) | Simulated Bee nodes. They share one simulated reserve, register a game key (an EdDSA key with which a node signs its commits; EdDSA is a signature scheme that the circuit checks at a low cost), commit, reveal and send claim witnesses. Chosen nodes do not reveal, reveal another hash, use the escape hatches, or do not send the claim. |

An anchor is a transaction that writes the root of an off-chain list on chain. The root is one hash of
the full list. An escape hatch is a
transaction with which a node puts its own entry on chain when the prover leaves it out
(`forceCommit`, `forceReveal`, `forceClaim`). Section 3 of the design document describes both.

## Build and test

You need Rust (stable), Go (the version in `snark/go.mod`), Foundry (`anvil`, `cast`) and the Node.js
packages of the repository.

```bash
cd prover/snark && go build -o snarkd ./cmd/snarkd
cd .. && cargo build --release
cargo test -p swarm-vm
```

The Rust tests include a cross-check with the real `Redistribution.claim`. The test vectors are in
`crates/vm/tests/vectors/`. To make them again, run this command from the repository root:

```bash
DUMP_CLAIM_VECTORS=1 npx hardhat test test/Redistribution.test.ts --grep "should claim pot by"
```

Commands of `snarkd` (run from `prover/`):

| Command | What it does |
| --- | --- |
| `snarkd setup -p 16 -out DIR` | Compiles the circuit with 16 slots, makes a local trusted setup (the step that makes the keys; this one is for tests only), and writes the proving key (the file that a prover needs for this size) and the verifier contract `GameVerifier16.sol` |
| `snarkd prove -keys DIR -witness w.json` | Makes and checks one proof |
| `snarkd serve -game DIR1,DIR2` | Keeps the keys in memory. Answers `POST /prove` with a witness and `GET /caps` with the sizes it has. Listens on `-listen` (default `127.0.0.1:8099`) |
| `snarkd size -p 16` | Prints the number of constraints of a circuit size |
| `snarkd check -witness w.json` | Solves the circuit for one witness without a proof (the fast test loop) |
| `snarkd vectors` | Prints test vectors of MiMC (the hash function of the circuit) for the Rust reference |

To make a witness for `snarkd check`: `./target/release/snark_synth NODES FORCED SLOTS > w.json`.

## Run it locally

Section 7 of [docs/SNARK-SETTLEMENT.md](../docs/SNARK-SETTLEMENT.md) has the steps for a local chain
(anvil) with real proofs.

## Configuration of `swarm-prover serve`

Each option is a flag or an environment variable. The service also reads `prover/.env`.

| Variable | Default | What it is |
| --- | --- | --- |
| `RPC_URL` | — | RPC endpoint of the settlement chain |
| `PROVER_PRIVATE_KEY` | — | Key with `ANCHOR_ROLE`. It pays the gas of the anchors and of `settleRound`, and receives the prover fee |
| `SETTLEMENT_ADDRESS` | — | Address of `Settlement` |
| `SNARKD_URL` | `http://127.0.0.1:8099` | Address of `snarkd serve` |
| `LISTEN` | `0.0.0.0:8080` | Address of the HTTP API for the nodes |
| `DATA_DIR` | `data` | Directory for the messages, inputs and proofs of each round |
| `POLL_SECS` | `3` | Seconds between two reads of the chain |
| `SWARM_API` | — | Bee API of the prover's Swarm node. Without it, the prover uploads nothing |
| `SWARM_BATCH_ID` | — | Mutable postage batch for the uploads (`swarm-prover stamp buy`). Without it, the prover uploads nothing |
| `SWARM_MIN_TTL_DAYS` | `7` | Warn (or top up) when the batch has less time left |
| `SWARM_TOPUP_DAYS` | `0` | Days to add when the batch runs low. `0`: warn only |
| `SWARM_BLOCK_SECONDS` | `5` | Block time of the chain of the Swarm postage contract (5 on Gnosis, 12 on Ethereum) |

Without the uploads, the `dataRef` of each anchor is the keccak256 hash of the list document.

These options make a prover that attacks the nodes. Use them for tests only:

| Variable | Attack |
| --- | --- |
| `CENSOR_COMMITS` | Leaves the commits of these staked addresses out of the anchored commit list |
| `CENSOR_REVEALS` | Leaves the reveals of these staked addresses out of the anchored reveal list |
| `NO_ANCHOR` | Does not anchor. The prover still settles rounds that another party anchored |
| `WITHHOLD_CLAIMS` | Accepts claim witnesses and throws them away |

`node-sim` finds each attack and uses the escape hatch. For example, with `CENSOR_COMMITS=<node 0 address>`
node 0 calls `forceCommit`, and the round counts it.

## Configuration of `node-sim`

| Option | What it is |
| --- | --- |
| `RPC_URL`, `SETTLEMENT_ADDRESS` | As for the prover |
| `PROVER_URL` | HTTP API of the prover (default `http://127.0.0.1:8080`) |
| `NODE_KEYS` | Staking keys of the nodes, comma separated |
| `BATCH_OWNER_KEY` | Owner key of the postage batch that stamps the simulated reserve |
| `BATCH_ID` | The batch. Default: the batch that `deploy/snark/002_roles_and_pot.ts` makes |
| `--depth` | Storage depth that each node reports (default 1) |
| `--silent`, `--liar`, `--forced`, `--no-claim` | Node indexes that do not reveal, reveal another hash, use only the escape hatches, or do not send the claim witness |
| `--no-claim-backstop` | Do not call `forceClaim` when nobody settled the round by block 58 |
| `--reserve` | Chunks in the simulated reserve (default 3,000,000) |
| `--rounds` | Stop after this number of rounds (default 0: run all the time) |

## What the prover writes

`$DATA_DIR/rounds/<round>/`:

- `messages.json`: each commit and reveal that the prover received, the lists as anchored, the claim
  witness and the settlement transaction. A restarted prover reads it, so it can settle the rounds that
  it anchored.
- `commits-data.json`, `reveals-data.json`: the list documents that the `dataRef` of each anchor refers to.
- `input.json`: the round input of the proof.
- `proof.json`: the proof. If a `settleRound` transaction fails, the prover sends the stored proof again.

## HTTP API

The overlay is the Swarm address of a node. A Merkle proof is the list of sibling hashes that links one
entry of a list to the root of the list.

| Method | Path | Body | Accepted |
| --- | --- | --- | --- |
| `POST` | `/v1/commit` | `{round, owner, obfuscatedHash, signature}` | Blocks 0-15 of the round. The signature must be a valid EdDSA signature of the owner's game key in `GameKeyRegistry` |
| `POST` | `/v1/reveal` | `{round, overlay, depth, hash, nonce}` | Blocks 24-39 |
| `POST` | `/v1/claim` | `{round, witness}` | After the seed block (block 48 of the round, which gives the random seed), until the round settles. The prover runs the game with the witness and accepts it only if the claim is valid |
| `GET` | `/v1/rounds/{round}` | | The anchored lists, the number of reveals, the settlement transaction |
| `GET` | `/v1/rounds/{round}/commit-proof/{owner}` | | Merkle proof of the commit of `owner` in the anchored commit list |
| `GET` | `/v1/rounds/{round}/reveal-proof/{overlay}` | | Merkle proof of the reveal of `overlay` in the anchored reveal list |
| `GET` | `/v1/rounds/{round}/outcome` | | After the seed block: the truth (the reserve sample hash that the round selects), the winner, and whether a valid claim is known |
| `GET` | `/v1/status` | | Block, round, block offset in the round, chain id, `Settlement` address |

A node checks its Merkle proof against the root and the count that `Settlement.rounds(round)` gives. If
the proof is missing or wrong, the node uses the escape hatch.
