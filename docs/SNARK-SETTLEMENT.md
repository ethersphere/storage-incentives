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
| sha256 | about 28,000 constraints for each 64 bytes | about 100 gas | Not used any more (the first version used it as the link between chain and circuit) |
| MiMC hash | about 330 constraints | about 9,000 gas (measured) | In the circuit. On chain for the links between chain and circuit: stake commitments, forced entries, the postage log |
| EdDSA signature check | about 7,000 constraints | not used | In the circuit |

A constraint is one equation of the circuit. The proof time and the memory increase with the number
of constraints.

MiMC is a hash function that uses only field arithmetic, so a circuit computes it with few
constraints. EdDSA is a signature scheme on the curve Baby Jubjub, which a circuit also checks with
few constraints. Both come from the gnark library (`gnark-crypto`, curve BN254).

Thus:

- The circuit proves the game (commits, reveals, truth, winner, freezes).
- `PostageStampZK` computes the pot on chain, with sums for each bucket of the balance scale (section 6).
  It has no batch tree and no expiry loop, and it needs no proof.
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
| `Settlement` | Groth16 verifiers for the game circuit (section 5), in two sizes (`gameCircuits`): a prover uses the smallest one that holds the round. It pays a winner the pot that `PostageStampZK.potAt(round)` gives, minus what it paid before. |
| | `settleRound` takes the two block headers. It checks their hashes and reads `prevrandao`. |
| | `settleRound` takes the claim witness and checks it on chain (`ClaimVerifier`). A round with reveals and without a valid witness is "unclaimed", as before. |
| | The forced-entry hash chains (`forceCommit`, `forceReveal`) use MiMC. A forced entry costs about 16k to 60k gas more. The circuit then has room for many forced entries at a low cost. |
| | The stake records enter through `GameKeyRegistry.commitmentOf(owner)`. |
| `GameKeyRegistry` (new) | Holds the game key of each node. Holds a MiMC commitment of each stake record with its game key, and computes it again only when the record changes. |
| `PostageStampZK` | Computes the pot on chain with bucket sums (section 6). No event log for a proof. The batch functions and events do not change. |
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
| Postage accounting | In the proof: a batch tree, the event log replay, the pot | On chain: bucket sums in `PostageStampZK` (section 6) | A second proof costs more gas and memory than the accounting itself |
| Pot timing | Exact at each cut | Each batch pays exactly its balance; the last part (less than one bucket) arrives late | The contract does not know the batches in expiry order |
| Claim batch check | Alive at the seed block, in the proof | Alive at the settlement, on chain (`isBatchAlive`) | The contract has the batch records |
| Capacity | No limit | Fixed: P commits and F forced entries for each proof. No limit for postage changes | A circuit has a fixed size |

## 5. The game circuit and its public inputs

The game circuit proves the commits, the reveals, the truth, the winner and the freezes. It has no
sha256. A node in the round can make this proof. The circuit exists in two sizes.

(An earlier version had a second circuit for the postage accounting. Section 8 has its numbers. The
accounting is now on chain, section 6.)

The public inputs are field elements that `Settlement` builds from its own state and from the outcome
(`_gameInputs`, `_settlePostage`). Small values are packed into one element.

Game circuit, 12 + P + F inputs:

```
0   chainId << 160 | settlement
1   round << 160 | lastClaimRound << 96 | commitCount << 80 | revealCount << 64 |
    forcedCommitCount << 48 | forcedRevealCount << 32 | stakePrice
2   lastWinnerDepth << 217 | penaltyDisagreement << 209 | penaltyNonRevealed << 201 |
    penaltyRandomFactor << 193 | stakeAgeRounds << 185 | hasReveals << 184 | truthDepth << 176 |
    redundancy << 160 | winner
3   selectionSeed, low 253 bits
4   (top 64 bits of roundAnchor) << 160 | feeRecipient
5   commitsRoot      6  revealsRoot      7  forcedCommitsHash      8  forcedRevealsHash
9   truthHash, high half      10  truthHash, low half
11  freeze codes: 2 bits for each entry, entry k at bit 2k
12+ the stake commitment of each entry: P anchored commits, then F forced commits (zero if unused)
```

A freeze code is 0 (no freeze), 1 (disagreement) or 2 (no reveal, or the stake changed in the round).
The contract computes the duration from `truthDepth` and the penalty parameters.

The stake commitment includes the owner, so the list of owners is not an input: the contract computes
each commitment from the owner that the transaction gives.

The root of an empty list is the root of a tree of zero leaves (`Settlement.EMPTY_LIST_ROOT`). The
contract stores zero for an empty list and uses this root as the input.

The random draws use the low 253 bits of the selection seed as one field element. The proximity check
reads only the top 64 bits of the round anchor, because `depth - height` is at most 64.

Stake commitment of a node, computed by `GameKeyRegistry`:

```
MiMC( owner,  overlay_hi,  overlay_lo,  key.x,  key.y,  committedStake << 96 | potentialStake,  height << 64 | lastUpdated )
```

A freeze changes only `lastUpdated`, which is in the last element. The registry keeps the hash of the
first 6 elements, so after a freeze it computes one compression only.

## 6. Postage accounting on chain

On master, `PostageStamp` keeps a sorted tree of all batches, so that it can remove the expired
batches before it pays the pot. A stamp buyer pays for the tree and for the expiry of the batches of
other users. On `feat/zk-settlement` the tree is in the proof.

Here the contract does not need the batches in expiry order. It needs only the number of chunks that
stop to pay at each balance level:

- The balance scale (`normalisedBalance`) is split into buckets of `BUCKET` = 2^21 units.
- For each bucket, the contract stores the chunks of the batches whose balance is in the bucket, and
  what these batches pay in their own bucket (the sum of chunks x (balance - start of the bucket)).
- `liveSize` is the chunks of the batches in the buckets after the current one. They pay the pot for
  each unit of outpayment.
- When the outpayment passes the end of a bucket, the batches of that bucket pay the rest of their
  balance, and the batches of the next bucket in use leave `liveSize`. A bitmap finds the next bucket
  in use.
- A purchase, a top-up or a depth increase changes one or two buckets.

Properties:

- Each batch pays exactly its balance, as on master. The test runs random batch histories on master's
  `PostageStamp` and on `PostageStampZK` in the same blocks: the pot of `PostageStampZK` is never more
  than master's pot, and it is equal when all batches are expired.
- A batch stops to pay at the start of its bucket and pays the rest at the end of its bucket. So the
  last part of its balance (less than one bucket) arrives late, never early.
- A new balance must be in a later bucket than the current one. The minimum balance of a batch
  (`minimumValidityBlocks` x price) is more than one bucket, so this is always true.
- The pot of a game round is fixed at the round's seed block (`potAt(round)`). The first accounting
  after a seed block stores the pot at that block. `anchorRound` calls `checkpoint()`, so each round
  with an anchor gets its own cut. Rounds without any transaction between their seed blocks share
  one cut.
- A stamp is valid when `normalisedBalance > currentTotalOutPayment()`, as before. Nothing is removed.

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
   ./snark/snarkd setup -p 8 -f 2 -out keys-game8
   ./snark/snarkd setup -p 16 -f 4 -out keys-game16
   cp keys-game8/GameVerifier8.sol keys-game16/GameVerifier16.sol ../src/settlement/groth16/
   ```

3. Start a local chain, deploy the contracts and stake the nodes (repository root):

   ```bash
   anvil --block-time 1
   WALLET_SECRET=<key of anvil account 0, no 0x> SNARK_P=16 SNARK_F=4 SNARK_P2=8 SNARK_F2=2 npx hardhat deploy --network zklocal
   NODE_KEYS=<keys of anvil accounts 1-5> npx hardhat run scripts/zk/setup-nodes.ts --network zklocal
   cast rpc anvil_mine 0x190
   ```

4. Start the proof daemon, the prover and the node simulator (`prover/`):

   ```bash
   ./snark/snarkd serve -game keys-game8,keys-game16
   export RPC_URL=http://127.0.0.1:8545
   export SETTLEMENT_ADDRESS=$(jq -r .address ../deployments/zklocal/Settlement.json)
   PROVER_PRIVATE_KEY=<key of anvil account 0> ./target/release/swarm-prover serve
   BATCH_OWNER_KEY=<key of anvil account 0> ./target/release/node-sim --depth 0 --silent 3 --liar 4 --forced 2 --rounds 6
   ```

`snarkd` has more commands: `size -p 16 -f 4` prints the number of constraints of a circuit, and
`check -witness w.json` solves the circuit for one witness without a proof (the fast test loop).
`snark_synth NODES FORCED P F` (in `prover/crates/vm`) writes the witness of a synthetic round.

## 8. Results

All numbers are from one machine: Apple M4 Max, 14 cores, 36 GB, on 2026-11-14.

Sections 8.1 to 8.3 are the first version: one circuit for the game and the postage accounting, with a
sha256 hash of all public values as the only public input. Section 8.4 is the version with two
circuits. Section 8.5 adds the MiMC postage log. Section 8.6 is the current version: the postage
accounting is on chain and there is one proof.

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

### 8.4 Two circuits

Circuit sizes:

| Circuit | Constraints | Proving key | Local setup |
| --- | --- | --- | --- |
| Game, 8 commits and 2 forced entries | 189,897 | 66 MB | 4 s |
| Game, 16 commits and 4 forced entries | 383,068 | 133 MB | 8 s |
| Postage, 4 events and 2 expiries | 751,751 | — | — |
| Postage, 8 events and 4 expiries | 1,346,512 | 599 MB | 54 s |

Proof time and peak memory of one proof (the whole process, with the keys):

| Circuit | Cores used | Proof time | Peak memory |
| --- | --- | --- | --- |
| Game, 8 commits | 4 | 0.8 s | 0.36 GB |
| Game, 8 commits | 1 | 2.9 s | 0.38 GB |
| Game, 16 commits | 14 | 0.6 s | 0.68 GB |
| Game, 16 commits | 4 | 1.4 s | 0.68 GB |
| Game, 16 commits | 2 | 2.7 s | 0.70 GB |
| Game, 16 commits | 1 | 5.6 s | 0.73 GB |
| Postage, 8 events | 14 | 2.9 s | 3.15 GB |
| Postage, 8 events | 4 | 6.2 s | 3.15 GB |

The game proof fits a small node: about 0.4 GB for 8 commits and about 0.7 GB for 16 commits, with one
CPU core in a few seconds. The postage proof is the heavy part. It needs a node with about 4 GB.

Local run (the same setup as section 8.3, game circuit 16/4, postage circuit 8/4, both proofs in one
`settleRound`):

| Round | What happened | Game proof | Postage proof | `settleRound` gas |
| --- | --- | --- | --- | --- |
| 9 | The draw selected the hash of node 4 as the truth; no valid claim witness ("unclaimed") | 0.57 s | 2.97 s | 2,038,595 |
| 10 | Truth and winner; 2 freezes | 0.62 s | 2.80 s | 1,491,306 |
| 11 | Same | 0.69 s | 2.76 s | 1,676,115 |
| 12 | Same | 0.63 s | 2.68 s | 1,656,819 |
| 13 | Same | 0.57 s | 2.73 s | 1,656,844 |
| 14 | No commits | 0.59 s | 2.64 s | 1,053,105 |

All 6 rounds settled.

The gas is higher than in section 8.3, because the contract checks two proofs, and the game verifier
has 32 public inputs. Each public input costs about 6,500 gas. Gas of round 12 (1,656,819):

| Part | Gas | In section 8.3 |
| --- | --- | --- |
| Game verifier (32 inputs) | 511,671 | 309,629 (one verifier for all) |
| Postage verifier (9 inputs) | 361,826 | — |
| Stake commitments | 324,811 | 324,811 |
| Claim checks | 89,854 | 89,757 |
| Price change, payouts, freezes, other | about 369,000 | about 350,000 |

Ways to decrease the gas: a game circuit with 8 commits has 22 inputs (about 65,000 gas less); a
postage proof for several rounds together; one MiMC hash of the stake commitments in place of one
input for each entry.

### 8.5 MiMC postage log, two game circuit sizes, cheaper MiMC on chain

Changes after section 8.4:

- The postage log hash chain is MiMC, so the postage circuit has no sha256.
- `MiMC.sol` has its 110 rounds written out: one compression costs about 9,000 gas (about 17,000
  before).
- The stake commitment has the element that a freeze changes at its end.
- `Settlement` holds two game circuit sizes, and the prover uses the smallest one that holds the round.

Circuit sizes, and one proof of each (peak memory of the whole process, with the keys):

| Circuit | Constraints | Proving key | 4 cores | 1 core | Peak memory |
| --- | --- | --- | --- | --- | --- |
| Game, 8 commits and 2 forced entries | 193,197 | 67 MB | 0.8 s | 2.9 s | 0.36 to 0.38 GB |
| Game, 16 commits and 4 forced entries | 389,668 | 135 MB | 1.4 s | 5.3 s | 0.67 to 0.72 GB |
| Postage, 4 events and 2 expiries | 345,087 | 138 MB | 1.9 s | 6.5 s | 0.81 to 0.83 GB |
| Postage, 8 events and 4 expiries | 665,064 | 268 MB | 3.5 s | 12.4 s | 1.5 GB |

The postage circuit went from 1,346,512 constraints and 3.15 GB to 665,064 constraints and 1.5 GB (8
events). One postage event costs about 64,000 constraints, and one expiry about 38,000.

Local test: one chain, the real verifier contracts, five scenarios one after the other. Each scenario
starts the prover with other options and runs `node-sim` for some rounds. Postage circuit 8/4.

| Scenario | What it tests | Rounds settled | Game circuit | Result |
| --- | --- | --- | --- | --- |
| honest | 5 honest nodes | 5 of 5 | 8/2 | 5 truth-tellers in each round with commits; no freeze |
| faults | Node 2 uses `forceCommit` and `forceReveal`, node 3 does not reveal, node 4 reveals another hash | 7 of 7 | 8/2 | 3 truth-tellers; nodes 3 and 4 get a freeze in each round |
| censor | The prover leaves the commit of node 0 and the reveal of node 1 out of its lists | 6 of 6 | 8/2 | Both nodes force their entry; nobody gets a freeze |
| noanchor | The prover does not anchor; 4 nodes | 2 of 2 | 16/4 | A node calls `anchorEmpty`, all 4 nodes force commit and reveal, the round pays out |
| withhold | The prover throws the claim witness away | 5 of 5 | 8/2 | A node calls `forceClaim`; the round pays out |

25 rounds settled, with no failed transaction and no error in the prover logs. In these runs a game
proof took 0.3 to 0.4 s and a postage proof 1.5 to 3.0 s (14 cores, with the other processes of the
test on the same machine).

Gas of `settleRound`:

| Round type | Gas | In section 8.4 |
| --- | --- | --- |
| Claimed, no freeze (game circuit 8/2) | 1,357,000 to 1,414,000 | — |
| Claimed, 2 freezes (game circuit 8/2) | 1,392,000 to 1,438,000 | about 1,660,000 (16/4) |
| Claimed, 4 forced entries (game circuit 16/4) | 1,398,000 to 1,404,000 | — |
| No commits | 951,000 to 974,000 | 1,053,000 |

Parts of one claimed round without a freeze (1,364,389 gas):

| Part | Gas |
| --- | --- |
| Game verifier (22 public inputs) | 446,521 |
| Postage verifier (7 public inputs) | 348,499 |
| Stake commitments (5, from the cache) | 113,115 |
| Price change, with its postage log entry | 96,872 |
| Claim checks | 89,833 |
| Payouts | 34,744 |
| Other (calldata, block headers, storage) | about 235,000 |

A stake commitment of a node that got a freeze in the round before costs 40,559 gas (128,271 before).

Other transactions:

| Transaction | Gas | In section 8.3 |
| --- | --- | --- |
| `forceCommit` | 77,860 to 112,292 | 128,523 |
| `forceReveal` | 131,632 to 165,828 | 215,800 |
| `createBatch` | 171,449 | 155,538 |

Not done from the list of possible optimizations, with the reason:

- **Tree depth 20.** It adds a limit of about 1 million batches, which is a new property.
- **Poseidon2 in the batch tree.** It needs a second hash in the Rust reference, the circuit and the
  tests, for about 15% fewer constraints in the postage circuit.
- **One hash of all stake commitments as one public input.** On-chain MiMC costs about 9,000 gas for
  each entry and a public input about 6,500 gas, so it does not decrease the gas. The second, smaller
  game circuit has the same purpose: it removes the unused inputs.
- **Memory-lean prover.** This is new prover software (some weeks of work).

### 8.6 Current version: postage accounting on chain, one proof

The postage circuit, the prover's batch tree and the postage log are removed. `settleRound` checks one
proof (the game) and pays from the pot that `PostageStampZK` computes.

The game proof (unchanged from section 8.5):

| Circuit | Constraints | 4 cores | 1 core | Peak memory |
| --- | --- | --- | --- | --- |
| Game, 8 commits and 2 forced entries | 193,197 | 0.8 s | 2.9 s | 0.36 to 0.38 GB |
| Game, 16 commits and 4 forced entries | 389,668 | 1.4 s | 5.3 s | 0.67 to 0.72 GB |

Local test, the same five scenarios as in section 8.5:

| Scenario | Rounds settled | Claimed rounds | `settleRound` gas, claimed | Forced transactions |
| --- | --- | --- | --- | --- |
| honest | 5 of 5 | 3 | 964,010 and 986,523 (first round: 1,736,279) | 0 |
| faults | 7 of 7 | 3 | 1,002,305 to 1,045,213 | 8 |
| censor | 6 of 6 | 3 | 968,436 to 1,012,011 | 6 |
| noanchor (game circuit 16/4) | 2 of 2 | 2 | 1,008,001 and 1,012,324 | 16 |
| withhold | 5 of 5 | 2 | 971,706 and 972,902 | 0 |

25 rounds settled, with no failed transaction and no error in the prover logs. A round without commits
costs about 555,000 gas. The first claimed round costs more, because the contract computes each stake
commitment for the first time. A game proof took 0.3 to 0.35 s.

After the run, `Settlement.potPaid` (5.46e13) is less than `PostageStampZK.cumulativePot` (5.71e13),
and the token balance of `PostageStampZK` (1.68e15) covers the pot.

Parts of one claimed round (964,010 gas):

| Part | Gas |
| --- | --- |
| Game verifier (22 public inputs) | 446,521 |
| Stake commitments (5, from the cache) | 113,115 |
| Claim checks | 94,394 |
| Price change, with the pot accounting | 84,851 |
| Payouts | 34,744 |
| Other (calldata, block headers, storage) | about 190,000 |

Gas of the stamp operations, on master's `PostageStamp` and on `PostageStampZK` (30 batches, measured
with a script on the hardhat network):

| Operation | Master | `PostageStampZK` |
| --- | --- | --- |
| `createBatch`, median | 365,179 | 217,469 |
| `topUp` | 445,594 | 169,212 |
| `increaseDepth` | 454,770 | 83,075 |
| `setPrice` | 52,686 | 66,495 |

Other transactions: `forceCommit` 77,844 to 129,376 gas, `forceReveal` 131,694 to 165,878 gas,
`anchorReveals` 57,443 gas.

### 8.7 Cost of a round: this design and the game on chain

The game on chain (master, `Redistribution` on Gnosis), measured from the transactions of the last
3,000 blocks before 2026-11-15 (20 rounds):

| Transaction | Count | Median gas |
| --- | --- | --- |
| `commit` | 76 | 155,598 |
| `reveal` | 72 | 199,877 |
| `claim` | 20 | 451,800 |

So a round on master costs about 355,000 gas for each node that plays, and about 452,000 gas for the
claim. About 3.8 nodes played in each round.

| Nodes in the round | Master, all transactions | This design: `settleRound` and the two anchors |
| --- | --- | --- |
| 4 | about 1,870,000 | about 1,100,000 |
| 10 | about 4,000,000 | about 1,300,000 (game circuit 16/4) |
| 16 | about 6,100,000 | about 1,450,000 |

The numbers for this design are estimates from the measured parts: 964,000 gas for 5 nodes, 22,000
gas more for each node, 65,000 gas more for the larger game circuit, and about 130,000 gas for the two
anchor transactions. In this design the nodes send no transaction in a normal round.

## 9. Open items

- **Trusted setup.** Groth16 needs a setup ceremony for each circuit version. The keys in this
  prototype come from a local setup, which is not safe for a real network.
- **Circuit review.** Nobody has audited the circuit. The only test is that the circuit and the Rust
  reference give the same hash of the public values, on synthetic rounds and on the local run.
- **Gas.** `settleRound` costs about 1.0M gas for a claimed round (section 8.6). The verifier is about 450,000 gas of that.
- **Fixed size.** A round with more entries than the largest game circuit holds cannot settle. The
  contract holds two sizes now; a real network needs a size for the largest neighbourhood.
- **Bucket width.** `BUCKET` is a constant. If the price falls so far that the minimum balance of a
  batch is less than one bucket, a purchase with a small balance reverts. The width can become a
  parameter.
- **Pot accounting loop.** The accounting visits each bucket in use that the outpayment passed. After
  a long time without any transaction, one call does all of that work.
- **Game key.** A node can set its key one time. A rule for a key change is necessary. A node that
  registers its first key during a round can decide late whether its commit counts.
- **Batch check time.** The claim checks read the batch at the settlement, not at the seed block.
- **Contract tests.** `test/Settlement.test.ts` is not ported (it is skipped). The Gnosis replay tools
  and the Swarm data layer of `feat/zk-settlement` are not tested on this branch.
