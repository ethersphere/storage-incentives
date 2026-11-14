# SNARK settlement: the redistribution game with a custom circuit

Status: design and prototype on branch `feat/snark-settlement`. This branch starts from
`feat/zk-settlement`. Read `docs/ZK-SETTLEMENT.md` first: it describes the round, the anchors, the escape
hatches and the contracts. This document describes only the differences.

## 1. Purpose

The branch `feat/zk-settlement` proves a round with the SP1 zkVM. A zkVM is a program that proves the
run of a normal Rust program. That proof needs about 10 GB of memory and about 5 minutes on a laptop
CPU.

This branch replaces the zkVM with one custom circuit. A circuit is a fixed set of equations that
describes one computation. The proof system is Groth16, a SNARK (a small proof that a contract can
verify for about 250k gas). The goal is a proof that a small server can make in less than one minute,
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
| MiMC hash | about 330 constraints | about 7,000 gas | In the circuit; on chain only for rare actions |
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
| `Settlement` | The verifier is the Groth16 verifier of the circuit, with one public input: `sha256(packed public values)` with the top 3 bits cleared. |
| | `settleRound` takes the two block headers. It checks their hashes and reads `prevrandao`. |
| | `settleRound` takes the claim witness and checks it on chain (`ClaimVerifier`). A round with reveals and without a valid witness is "unclaimed", as before. |
| | The forced-entry hash chains use sha256. |
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
forcedCommitsHash (32) | forcedRevealsHash (32)
lastClaimRound (8) | lastWinnerDepth (1)
penaltyDisagreement (1) | penaltyNonRevealed (1) | penaltyRandomFactor (1) | stakeAgeRounds (1)
stakePrice (4)
postage: prevStateHash (32) | prevEventIndex (8) | prevEventHash (32) | eventIndex (8) | eventHash (32) | cutBlock (8)
outcome: hasReveals (1) | truthHash (32) | truthDepth (1) | winner (20) | redundancy (2)
feeRecipient (20)
postage outcome: newStateHash (32) | potAmount (32) | validChunkCount (32)
participantCount (1)
(P + F) x [ stakeCommitment (32) | freeze (1) ]      (zero for unused entries)
```

`freeze` is 0 (no freeze), 1 (disagreement) or 2 (no reveal, or the stake changed in the round). The
contract computes the duration from `truthDepth` and the penalty parameters.

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

## 7. Results

See section 8 (added after the local runs).
