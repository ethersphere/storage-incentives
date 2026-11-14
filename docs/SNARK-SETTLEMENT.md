# SNARK settlement: the redistribution game with a custom circuit

Status: prototype on branch `feat/snark-settlement`. It runs end to end on a local chain with real proofs (section 8). This branch starts from
`feat/zk-settlement`. Read `docs/ZK-SETTLEMENT.md` first: it describes the round, the anchors, the escape
hatches and the contracts. This document describes only the differences.

## 1. Purpose

The branch `feat/zk-settlement` proves a round with the SP1 zkVM. A zkVM is a program that proves the
run of a normal Rust program. That proof needs about 10 GB of memory and about 5 minutes on a laptop
CPU.

This branch replaces the zkVM with one custom circuit. A circuit is a fixed set of equations that
describes one computation. The proof system is Groth16, a SNARK (a small proof that a contract can
verify for about 310k gas). The goal is a proof that a small server can make in less than one minute,
without a GPU.

The game rules, the round layout, the anchors, the escape hatches and the Swarm data formats stay the
same.

## 2. The principle

Each operation runs where it is cheap.

| Operation | In a circuit | On chain | Where it runs here |
| --- | --- | --- | --- |
| keccak256 | about 150,000 constraints | about 36 gas | On chain |
| secp256k1 signature check | about 500,000 constraints or more | 3,000 gas (`ecrecover`) | On chain |
| sha256 | about 28,000 constraints for each 64 bytes | about 100 gas | Both: the link between chain and circuit |
| MiMC hash | about 330 constraints | about 17,000 gas (measured) | In the circuit; on chain only for rare actions |
| EdDSA signature check | about 7,000 constraints | not used | In the circuit |

A constraint is one equation of the circuit. The proof time and the memory increase with the number
of constraints.

MiMC is a hash function that uses only field arithmetic, so a circuit computes it with few
constraints. EdDSA is a signature scheme on the curve Baby Jubjub, which a circuit also checks with
few constraints. Both come from the gnark library (`gnark-crypto`, curve BN254).

Thus:

- The circuit proves the game (commits, reveals, truth, winner, freezes) and the postage accounting.
- The contract checks the claim witness (the chunk inclusion proofs, the postage stamp signatures and
  the single-owner chunk signatures). These checks use keccak256 and `ecrecover`. They are the same
  checks that `Redistribution.claim` does now.
- The contract checks the two block headers and takes `prevrandao` from them.

Chunk addresses, postage stamps, batch ids and the reserve sample do not change.

## 3. What changes

### 3.1 Bee (game code only)

- **Game key.** Each node makes an EdDSA key pair on Baby Jubjub and registers the public key one time
  in `GameKeyRegistry`. The node signs its commits with this key.
- **Commit hash.** `obfuscatedHash = MiMC(overlay, depth, hash, nonce)`. A 256-bit value goes into the
  hash as two 128-bit halves.
- **Commit signature.** The node signs `MiMC(DOMAIN, chainId, settlement, round, obfuscatedHash)`.
- **List check.** The anchored lists are MiMC Merkle trees with a fixed depth of 8 (256 entries). A
  node checks its own entry with 8 sibling hashes.

### 3.2 Contracts

| Contract | Change |
| --- | --- |
| `Settlement` | The verifier is the Groth16 verifier of the circuit, with one public input: `sha256(packed public values)` with the top 3 bits cleared. The contract holds the size of the circuit (`capacity`, `forcedCapacity`). |
| | `settleRound` takes the two block headers. It checks their hashes and reads `prevrandao`. |
| | `settleRound` takes the claim witness and checks it on chain (`ClaimVerifier`). A round with reveals and without a valid witness is "unclaimed", as before. |
| | The forced-entry hash chains (`forceCommit`, `forceReveal`) use MiMC. A forced entry costs about 16k to 60k gas more. The circuit then has room for many forced entries at a low cost. |
| | The stake records enter through `GameKeyRegistry.commitmentOf(owner)`. |
| `GameKeyRegistry` (new) | Holds the game key of each node. Holds a MiMC commitment of each stake record with its game key, and computes it again only when the record changes. |
| `PostageStampZK` | The event log hash chain uses sha256 and has fewer fields: `sha256(prev, kind, batchId, depth, value (16 bytes), block)`. |
| `Staking.sol`, `PriceOracleZK` | No change. |

### 3.3 Prover

- `prover/crates/vm` keeps the game as a Rust function. It is the reference: it computes the result and
  the witness (the private inputs) of the circuit.
- `prover/snark` (Go, gnark) holds the circuit, the setup and the Groth16 prover.
- The prover service calls the Go prover for each round. It does not use SP1 or the Succinct Prover
  Network.

## 4. Rule differences from `feat/zk-settlement`

| Rule | zkVM branch | This branch | Reason |
| --- | --- | --- | --- |
| Commit signature | secp256k1, staking key | EdDSA, game key | Circuit cost |
| Commit list leaf | `keccak(owner, obfuscatedHash)` | `MiMC(owner, obfuscatedHash, R.x, R.y, S)`: the signature is in the leaf | A prover cannot replace a good signature with a bad one to drop a commit |
| Random draws | keccak, 128 bits | MiMC, 80 bits | Products must fit in the field (253 bits) |
| Stake amounts | uint256 | less than 2^96 | Same reason. The BZZ supply is less than 2^80 |
| `depth - height` of a reveal | 0..255 | 0..64 | Same reason |
| Batch balance, outpayment | uint256 | less than 2^128 | Same reason |
| Batch tree | two lists (by id, by expiry) | one list (by expiry). Key: (balance, leaf index) | The id list was for claim lookups, which are now on chain |
| Claim batch check | Alive at the seed block, in the proof | Alive at the settlement, on chain (`isBatchAlive`) | The contract has the batch records |
| Capacity | No limit | Fixed: P participants, F forced entries, E postage events, X expiries for each proof | A circuit has a fixed size |

## 5. Circuit interface

The circuit has one public input: the sha256 hash of the packed public values, with the top 3 bits
cleared (so it fits in the field). `Settlement` builds the same bytes and computes the same hash.

Packed public values (all integers big-endian):

```
chainId (32) | settlement (20) | round (8)
roundAnchor (32) | selectionSeed (32)
commitsRoot (32) | commitCount (4) | revealsRoot (32) | revealCount (4)
forcedCommitsHash (32) | forcedCommitCount (4) | forcedRevealsHash (32) | forcedRevealCount (4)
lastClaimRound (8) | lastWinnerDepth (1)
penaltyDisagreement (1) | penaltyNonRevealed (1) | penaltyRandomFactor (1) | stakeAgeRounds (1)
stakePrice (4)
postage: prevStateHash (32) | prevEventIndex (8) | prevEventHash (32) | eventIndex (8) | eventHash (32) | cutBlock (8)
outcome: hasReveals (1) | truthHash (32) | truthDepth (1) | winner (20) | redundancy (2)
feeRecipient (20)
postage outcome: newStateHash (32) | potAmount (32) | validChunkCount (32)
(P + F) x [ stakeCommitment (32) | freeze (1) ]      (zero for unused entries)
```

The first P entries are for the anchored commits. The next F entries are for the forced commits. The
stake commitment includes the owner, so the list of owners is not in the hash: the contract computes
each commitment from the owner that the transaction gives.

`freeze` is 0 (no freeze), 1 (disagreement) or 2 (no reveal, or the stake changed in the round). The
contract computes the duration from `truthDepth` and the penalty parameters.

The root of an empty list is the root of a tree of zero leaves (`Settlement.EMPTY_LIST_ROOT`). The
contract stores zero for an empty list and puts this root in the hash.

Stake commitment of a node, computed by `GameKeyRegistry`:

```
MiMC( owner | height | lastUpdated,  overlay_hi,  overlay_lo,  committedStake | potentialStake,  key.x,  key.y )
```

## 6. Postage state

The live batches are leaves of a MiMC Merkle tree with depth 24. A leaf is
`(id_hi, id_lo, depth, balance, nextIndex, nextBalance)`. The leaves form one linked list in expiry
order: the key is (balance, leaf index). Leaf 0 is the head of the list. `nextIndex = 0` is the end.

The carried state is `MiMC(root, nextFree, liveChunks, lastCutBlock, priceBlock, priceOutpayment, price)`.

Each event slot of the circuit does at most 3 leaf writes. Each expiry slot does 2 leaf writes.

## 7. How to run it locally

You need Go, Rust, Foundry (`anvil`, `cast`) and the Node.js packages of this repository.

1. Build the tools:

   ```bash
   cd prover/snark && go build -o snarkd ./cmd/snarkd
   cd .. && cargo build --release
   ```

2. Make the keys of the circuit. This is a local setup for tests. A real network needs a setup
   ceremony with more than one party.

   ```bash
   ./snark/snarkd setup -p 16 -f 4 -e 8 -x 4 -out keys-16
   cp keys-16/Verifier.sol ../src/settlement/groth16/Verifier.sol
   ```

3. Start a local chain, deploy the contracts and stake the nodes (repository root):

   ```bash
   anvil --block-time 1
   WALLET_SECRET=<key of anvil account 0, no 0x> SNARK_P=16 SNARK_F=4 npx hardhat deploy --network zklocal
   NODE_KEYS=<keys of anvil accounts 1-5> npx hardhat run scripts/zk/setup-nodes.ts --network zklocal
   cast rpc anvil_mine 0x190
   ```

4. Start the proof daemon, the prover and the node simulator (`prover/`):

   ```bash
   ./snark/snarkd serve -keys keys-16
   export RPC_URL=http://127.0.0.1:8545
   export SETTLEMENT_ADDRESS=$(jq -r .address ../deployments/zklocal/Settlement.json)
   PROVER_PRIVATE_KEY=<key of anvil account 0> ./target/release/swarm-prover serve
   BATCH_OWNER_KEY=<key of anvil account 0> ./target/release/node-sim --depth 0 --silent 3 --liar 4 --forced 2 --rounds 6
   ```

`snarkd` has more commands: `size` prints the number of constraints of a circuit size, and
`check -witness w.json` solves the circuit for one witness without a proof (the fast test loop).
`snark_synth` (in `prover/crates/vm`) writes the witness of a synthetic round.

## 8. Results

All numbers are from one machine: Apple M4 Max, 14 cores, 36 GB, on 2026-11-14.

### 8.1 Circuit size

| Circuit size (P, F, E, X) | Constraints | Proving key | Local setup |
| --- | --- | --- | --- |
| 16, 4, 8, 4 | 2,458,223 | 1.1 GB | 1.6 min, 5.2 GB |
| 32, 4, 16, 8 | 4,308,418 | about 2 GB | about 3 min, 7.4 GB |

The cost of each part (from `snarkd size` with different sizes):

| Part | Constraints |
| --- | --- |
| Fixed part | about 540,000 |
| One anchored commit with its reveal | about 42,000 |
| One forced commit with its reveal | about 30,000 |
| One postage event | about 130,000 |
| One batch expiry | about 38,000 |

About half of the constraints are sha256: the hash of the public values and the postage log chain
(two sha256 blocks for each event).

### 8.2 Proof time and memory

Circuit 16, 4, 8, 4 (2.46M constraints), one proof, keys already in memory:

| Cores used | Proof time | Peak memory |
| --- | --- | --- |
| 14 | 5 to 6 s | 4.2 GB |
| 4 | 12 s | 4.0 GB |
| 2 | 22 s | 3.6 GB |

The proof daemon loads the keys in about 1.3 s. For the circuit 32, 4, 16, 8 (measured before the
last layout change, with 4.7M constraints): 9.9 s with 14 cores and 6.9 GB.

For comparison, the SP1 zkVM on the same class of machine needs about 5 minutes and 10 GB for one
round.

The memory is higher than the first estimate of 1 to 2 GB. A node needs about 4 GB of free memory
to prove the small circuit. It does not need a GPU.

### 8.3 Local run of the game

The run uses anvil with 1-second blocks, the real Groth16 verifier contract, the prover service and
`node-sim` with 5 nodes. Node 2 uses the escape hatches (`forceCommit`, `forceReveal`) in each round.
Node 3 does not reveal. Node 4 reveals a different hash.

| Round | What happened | Proof | `settleRound` gas |
| --- | --- | --- | --- |
| 8 | No commits (the nodes were not ready) | 4.95 s | 522,695 |
| 9 | Truth and winner; 2 freezes; first use of each stake commitment | 4.84 s | 1,612,849 |
| 10 | Truth and winner; the frozen nodes get a freeze again | 5.16 s | 1,091,148 |
| 11 | Same | 5.08 s | 1,093,156 |
| 12 | Same | 4.95 s | 1,073,915 |
| 13 | Same | 5.06 s | 1,076,219 |
| 14 | No commits (`node-sim` stopped) | 5.13 s | 468,571 |

All 7 rounds settled. In an earlier run, one `settleRound` ran out of gas, because the gas of the
transaction was higher in the block that included it than in the estimate. The prover sent the
stored proof again and the round settled. The prover now adds a margin to the estimate.

Gas of one claimed round (round 12, 1,073,915 gas):

| Part | Gas |
| --- | --- |
| Groth16 verifier | 309,629 |
| Stake commitments: 3 from the cache, 2 computed again (the frozen nodes) | 324,811 |
| Claim checks (`ClaimVerifier`) | 89,757 |
| Price change, with its postage log entry | 80,963 |
| Payouts and freezes | 47,986 |
| Other (calldata, headers, storage) | about 220,000 |

A stake commitment costs about 22,000 gas from the cache and about 128,000 gas when the contract
computes it again. A freeze changes the stake record, so the next settlement computes the commitment
of that node again. Without freezes, a claimed round costs about 850,000 gas.

Other transactions:

| Transaction | Gas | On `feat/zk-settlement` |
| --- | --- | --- |
| `forceCommit` | 128,523 | about 46,000 |
| `forceReveal` | 215,800 | about 48,000 |
| `GameKeyRegistry.setKey` (one time for each node) | 68,989 | not used |

The escape hatches cost more gas than before, because the contract computes MiMC for them.

## 9. Open items

- **Trusted setup.** Groth16 needs a setup ceremony for each circuit version. The keys in this
  prototype come from a local setup, which is not safe for a real network.
- **Circuit review.** Nobody has audited the circuit. The only test is that the circuit and the Rust
  reference give the same hash of the public values, on synthetic rounds and on the local run.
- **Fixed size.** A round with more entries than the circuit size cannot settle. The same applies to a
  round with more than E postage events or X expiries since the last settlement. Possible solutions:
  several circuit sizes with one verifier each, and a proof that only moves the postage state forward.
- **Game key.** A node can set its key one time. A rule for a key change is necessary. A node that
  registers its first key during a round can decide late whether its commit counts.
- **Gas.** On-chain MiMC costs about 17,000 gas for each compression. Options: compute the stake
  commitment in two steps, so that a freeze changes only the last step; or a faster MiMC
  implementation.
- **Constraints.** A MiMC hash chain for the postage log removes about 60,000 constraints for each
  event. The price is about 50,000 gas more for each stamp purchase or top-up.
- **Batch check time.** The claim checks read the batch at the settlement, not at the seed block.
- **Contract tests.** `test/Settlement.test.ts` is not ported (it is skipped). The Gnosis replay tools
  and the Swarm data layer of `feat/zk-settlement` are not tested on this branch.
