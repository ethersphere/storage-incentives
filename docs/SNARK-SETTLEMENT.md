# SNARK settlement: the redistribution game with a custom circuit

Status: prototype on branch `feat/snark-settlement`. It runs end to end on a local chain with real proofs
(section 8). An earlier version on branch `feat/zk-settlement` used the SP1 zkVM (section 1). That branch keeps its
own documents. This document describes the SNARK version completely.

## 1. Purpose

The storage incentives game of Swarm works like this. In each round, a random value selects a
neighbourhood: a part of the Swarm address space. Each staked node in that neighbourhood commits to the
hash of its reserve sample (a hash of chunks that it stores), and later reveals the hash. A random draw,
weighted by stake, selects one revealed hash as the truth. A second draw selects the winner from the nodes
that revealed the truth. The winner proves its storage with a claim and receives the pot. The pot is the
storage fees that uploaders paid for their postage batches (prepaid storage on Swarm).

A claim holds the claim witness: three chunks of the reserve sample of the truth, each with its
inclusion proof and postage stamp. A node that committed and did not reveal gets a freeze. A frozen stake
cannot play for some time. The nodes that revealed a different hash get a freeze if a random draw of the
round (the freeze lottery) says so.

On master, this game runs on chain in `Redistribution.sol`. Each node in the round sends a commit
transaction and a reveal transaction, and the winner sends a claim transaction. Each transaction costs
gas: the unit of the cost of a transaction on Ethereum.

In this design the game runs off chain. The nodes send their commits and reveals as signed messages to a
prover. The prover proves the result of each round with a SNARK. One contract, `Settlement`, checks the
proof and executes the result. In a normal round, the nodes send no transaction.

A SNARK is a short proof that a contract can check at a fixed cost. The proof system here is Groth16,
which a contract checks for about 310k gas. The proof is for one custom circuit. A circuit is a fixed
set of equations that describes one computation.

The earlier SP1 version proved a normal Rust program with a zkVM: a virtual machine that makes a proof
of each run. That proof needed about 10 GB of memory and about 5 minutes on a laptop CPU. The goal of the
custom circuit is a proof that a small server can make in less than one minute, without a graphics card
(GPU). Section 8 has the measured numbers.

## 2. The principle

Each operation runs where it is cheap.

| Operation | In a circuit | On chain | Where it runs here |
| --- | --- | --- | --- |
| keccak256 | about 150,000 constraints | about 36 gas | On chain |
| secp256k1 signature check | about 500,000 constraints or more | 3,000 gas (`ecrecover`) | On chain |
| sha256 | about 28,000 constraints for each 64 bytes | about 100 gas | Not used any more (the first version used it as the link between chain and circuit) |
| MiMC hash | about 330 constraints | about 9,000 gas (measured) | In the circuit. On chain for the links between chain and circuit: stake commitments (one hash of the stake record of a node, section 5), forced entries |
| EdDSA signature check | about 7,000 constraints | not used | In the circuit |

A constraint is one equation of the circuit. The proof time and the memory increase with the number
of constraints.

MiMC is a hash function that uses only field arithmetic (arithmetic modulo the 254-bit prime of the
proof system), so a circuit computes it with few constraints. EdDSA is a signature scheme on the curve Baby Jubjub, which a circuit also checks with
few constraints. Both come from the gnark library (`gnark-crypto`, curve BN254).

Thus:

- The circuit proves the game (commits, reveals, truth, winner, freezes).
- `PostageStampSnark` computes the pot on chain, with sums for each bucket of the balance scale (section 6).
  It has no batch tree and no expiry loop, and it needs no proof.
- The contract checks the claim witness (the chunk inclusion proofs, the postage stamp signatures and
  the single-owner chunk signatures). These checks use keccak256 and `ecrecover`. They are the same
  checks that `Redistribution.claim` does now.
- The contract checks two block headers and takes the random value `prevrandao` from them (section 3.3).

Chunk addresses, postage stamps, batch ids and the reserve sample do not change.

## 3. The round, the anchors and the escape hatches

Three parties take part in a round:

- **Nodes** (Bee). Each node signs its commit and its reveal and sends them to a prover over HTTP.
- **The prover** (`swarm-prover serve`, see `prover/README.md`). It collects the messages, writes the
  lists on chain, makes the proof and calls `settleRound`. The prover key holds `ANCHOR_ROLE` on
  `Settlement`.
- **`Settlement`**. It replaces `Redistribution`. It stores the lists, checks the proof, freezes stakes,
  adjusts the price and pays the winner.

An anchor is a transaction that writes the root of an off-chain list on chain. The root is one hash of
the full list (section 3.4). After the anchor, the
prover cannot change the list. An escape hatch is a transaction with which a node puts its own entry on
chain when the prover leaves it out. The escape hatches are `forceCommit`, `forceReveal` and
`forceClaim`.

### 3.1 Round layout

A round is `ROUND_LENGTH` = 64 blocks. With 12-second blocks (Ethereum), a round is 768 seconds, about
12.8 minutes. This is the same time as the round of `Redistribution` on Gnosis Chain (152 blocks of 5
seconds). The phases come from the Gnosis layout, scaled to 64 blocks.

| Blocks in the round | Phase | What happens |
| --- | --- | --- |
| 0-15 | commit | Nodes send signed commits to the prover, or call `forceCommit` |
| 16-19 | commit anchor | The prover calls `anchorCommits` one time. If it does not, anybody can call `anchorEmptyCommits` in blocks 20-23 |
| 20-23 | commit check | Each node checks that its commit is in the anchored list. A node that is not in it calls `forceCommit` (open until block 23) |
| 24-39 | reveal | Nodes send reveals to the prover, or call `forceReveal` |
| 40-43 | reveal anchor | The prover calls `anchorReveals` one time. It accepts no more off-chain reveals |
| 44-47 | reveal check | Each node checks that its reveal is in the anchored list. A node that is not in it calls `forceReveal` (open until block 47) |
| 48 | seed block | Its `prevrandao` gives the selection seed (section 3.3). Nobody chooses it |
| 49-63 | claim | Each node can compute the truth and the winner. A node that holds the truth's sample sends the claim witness to the prover, or calls `forceClaim` |
| 49 and later | settle | Anybody with a valid proof calls `settleRound`. Rounds settle in the order of their numbers. A round without a valid claim ("unclaimed") settles only from block 64 |

The constants are in `Settlement.sol` (`COMMIT_END`, `ANCHOR_END`, `REVEAL_START`,
`REVEAL_ANCHOR_START`, `REVEAL_ANCHOR_END`, `REVEAL_END`, `SEED_OFFSET`, `CLAIM_START`).

`forceCommit` and `forceReveal` stay open for 4 blocks after each anchor. Thus a prover that leaves a node
out of an anchored list cannot stop the node.

The anchors and the escape hatches fix all reveals before the seed block. Thus nobody can see the seed first and then decide to reveal
or not. In `Redistribution.sol` the first reveal sets the seed, so each later revealer has this option.

### 3.2 Round storage: a ring of 256 entries

`Settlement` keeps the state of a round in `ring[round % 256]` (`RING_SIZE`). The state is the anchored
list roots, the forced hash chains, the counts and the flags. A new round takes the entry of the round 256
rounds before it.

The reason is gas. A write to a storage slot that is zero costs much more than a write to a slot that is
in use (about 20k gas against about 5k gas). With the ring, the anchors and the escape hatches write only
slots that are in use, after the first 256 rounds. `warmRing(from, count)` (admin) fills entries one time,
so that the first use is cheap too. The contract never sets the hash slots back to zero. A hash counts
only when the count or the flag of the entry says that it is from this round.

The ring size of 256 is safe. A round can settle only while the chain serves the block hash of its seed
block. EIP-2935 (a system contract of Ethereum) serves the last 8,191 block hashes: 128 rounds, about 27
hours. A round whose entry a later round took cannot settle (`NotAnchored`), and it cannot settle
anyway.

### 3.3 Randomness

`prevrandao` is a random value that the Ethereum beacon chain puts in each block header (the field
`mixHash`). Two values come from it:

- **Round anchor** = `keccak256(abi.encode(prevrandao of block roundStart - 1, round))`. It selects the
  neighbourhood. Each node knows it from the first block of the round.
- **Selection seed** = `keccak256(abi.encode(round anchor, prevrandao of the seed block))`. It selects the
  truth, the winner and the freeze lottery. Nobody knows it before all commit and reveal deadlines end.

A contract cannot read the `prevrandao` of an earlier block. Thus `settleRound` receives the headers of
the two blocks in RLP form (the format of a block header on Ethereum). `Settlement.randomness` checks
that the keccak256 hash of each header is the block hash. It reads the block hash with `BLOCKHASH`, or
from EIP-2935 for older blocks. Then it reads `mixHash` from each header.

The design uses `prevrandao` and not the block hash, because a block builder can choose the transactions
of a block. It can try many orders and keep a block hash that selects the neighbourhood or the winner
that it wants. The proposer of a block cannot change `prevrandao`. It can only skip its slot.

### 3.4 Anchors

| Function | Who | When | What it stores |
| --- | --- | --- | --- |
| `anchorCommits(round, commitsHash, commitCount, dataRef)` | Prover with `ANCHOR_ROLE` | Blocks 16-19 | The root of the commit list. The prover sorts the list by owner |
| `anchorReveals(round, revealsHash, revealCount, dataRef)` | Prover with `ANCHOR_ROLE` | Blocks 40-43, after `anchorCommits` | The root of the reveal list |
| `anchorEmptyCommits(round)` | Anybody | Blocks 20-23, if the round has no anchor | An empty commit list |

Each list is a MiMC Merkle tree with a fixed depth of 8 (256 entries). A Merkle tree hashes the entries in
pairs up to one root. A node does not need the full list. It asks the prover for a Merkle proof of its own
entry (`GET /v1/rounds/{round}/commit-proof/{owner}` and `.../reveal-proof/{overlay}`; the overlay is the
Swarm address of the node). A Merkle proof is
the list of sibling hashes that links one entry to the root. The node checks the proof against the root
and the count that `Settlement.rounds(round)` gives. If the proof is missing or wrong, the node uses the
escape hatch. `node-sim` waits at most 5 seconds for the prover.

`anchorReveals` is necessary. Without it, a prover can keep a commit and drop its reveal. The node then
gets the freeze for no reveal, and it cannot see the attack before the seed block.

`anchorEmptyCommits` keeps the game alive when the prover stops. The nodes then force their commits and
reveals. Any prover can settle the round from data that is all on chain.

`dataRef` is the Swarm reference of the document with the full list, or the keccak256 hash of the document
when the prover does not upload. The contract only emits it in the events `CommitsAnchored` and
`RevealsAnchored`. Another prover can download the lists with it and settle the round.

### 3.5 Escape hatches

| Function | Open in blocks | Rule |
| --- | --- | --- |
| `forceCommit(round, obfuscatedHash)` | 0-23 | The sender is the owner. A forced commit counts only if the owner has no anchored commit that counts |
| `forceReveal(round, overlay, depth, hash, nonce)` | 24-47 | Only for the overlay of the sender's own stake |
| `forceClaim(round, witness)` | 49-63 | A witness of at most 16 KB (`MAX_CLAIM_WITNESS_SIZE`) |

Limits:

- Only a staked address can use an escape hatch, and only one time in each round for each function.
- Each round holds at most 256 forced commits, 256 forced reveals (`MAX_FORCED_PER_ROUND`) and 16 forced
  claims (`MAX_FORCED_CLAIMS_PER_ROUND`).

Without these limits, anybody can fill a round with junk entries. A censored node then cannot get in.
Now a full round needs 256 (or 16) staked addresses.

`forceCommit` and `forceReveal` add the entry to a MiMC hash chain in the ring entry. `settleRound` gives
these hashes to the proof as public inputs: the values that the contract gives to the verifier of the
proof (section 5). Thus the proof must use exactly the forced entries. The circuit has a fixed number of
slots for entries, and forced entries and anchored entries share them (section 9).

`forceClaim` adds the witness to a keccak256 hash chain. If nobody settled the round by block 58, a node
that revealed the truth calls `forceClaim`. `node-sim` does this. An unclaimed round cannot settle before
block 64, so a prover that withholds the witness cannot close the round first.

Gas of the escape hatches: `forceCommit` about 78k to 129k, `forceReveal` about 132k to 166k (section 8.6).

### 3.6 Settlement of a round

`settleRound(outcome, evidence)` has no role check. The proof is the permission. It does these steps:

1. It checks that the round is anchored, not settled, and later than the last settled round.
2. It checks that no earlier anchored round can still settle (`RoundPending`). An anchored round blocks the
   later rounds for at most `PENDING_ROUNDS` = 3 rounds after its end, or until its seed block hash is gone.
   A round without an anchor does not block later rounds.
3. It computes the round anchor and the seed from the two headers (section 3.3).
4. It builds the public inputs of the circuit from its own state and checks the Groth16 proof with the
   verifier contract of the circuit size (section 5).
5. It checks the claim witness with `ClaimVerifier`.
6. For a claimed round, it freezes stakes, adjusts the price (`PriceOracleSnark.adjustPriceForRound`) and
   pays the pot to the winner.

A round without reveals changes nothing, as on master. A round with reveals and without a valid claim
witness is "unclaimed". It also changes nothing: no payout, no freeze, no price change. It settles only
from block 64, and each forced claim of the round must fail the check. The pot of a round without a payout
stays for the next winner.

**Prover fee.** The payout pays `proverFeeBps` (default 100, which is 1%; at most 10%) to `feeRecipient`.
`feeRecipient` is a public input of the proof, not `msg.sender`. Thus a party that copies a `settleRound`
transaction and sends it first gets nothing.

**Verifier changes.** A verifier is the contract that checks the proofs of one circuit size. A verifier
that accepts any proof can pay the pot to anybody. Thus a change takes
two steps. The admin calls `proposeVerifier(slot, verifier, P)`. After `verifierDelay` seconds, anybody can
call `applyVerifier`. The admin can call `cancelVerifier` before that. The deployment fixes the delay
(`VERIFIER_DELAY`): 0 on test networks, for example 7 days on mainnet.

### 3.7 Who does what and who pays

| Action | Who | When | Gas paid by | Paid back |
| --- | --- | --- | --- | --- |
| `createBatch`, `topUp`, `increaseDepth` | Uploader | Any time | Uploader (only its own batch) | — |
| `GameKeyRegistry.setKey` | Node | One time | Node (about 69k gas) | No |
| Commit, reveal, claim witness | Node, off chain | Each round | Nobody (HTTP) | — |
| `forceCommit`, `forceReveal`, `forceClaim` | Node | Only if the prover leaves it out | Node | No |
| `anchorCommits`, `anchorReveals` | Prover with `ANCHOR_ROLE` | Blocks 16-19 and 40-43 | Prover (about 130k gas together) | No |
| Proof | Prover, on its own CPU (`snarkd`) | After block 48 | Prover | Through the fee |
| `settleRound` | Anybody with a valid proof; in practice the prover | From block 49 (unclaimed: from block 64) | Caller (about 1.0M gas for a claimed round, section 8.6) | `proverFeeBps` of the payout, only in rounds with a payout |

The first valid `settleRound` wins. A second one reverts with `AlreadySettled`. If nobody settles, the
pot stays, and a later claimed round pays it.

### 3.8 Prover operations

The prover is the service `swarm-prover serve`, the proof daemon `snarkd serve` on the same machine, and
optionally a Bee node for the uploads. The proof needs no GPU and no external proof service. A game proof
takes less than 1.5 seconds on 4 cores and less than 1 GB of memory (section 9.2).

**Keys.** Use a different key for each role. Then a compromised key does only the damage of its own role.
A hot key is on a server that is on the internet. A cold key is offline, or it is a multisig wallet: a
wallet that needs the signatures of more than one person.

| Key | Holds | Used for | Where it is |
| --- | --- | --- | --- |
| Admin | `DEFAULT_ADMIN_ROLE` on `Settlement` | Grant and revoke `ANCHOR_ROLE`; `proposeVerifier`; parameters (`setStakeAgeRounds`, `setFreezingParams`, `setSampleMaxValue`, `setProverFee`); `warmRing`; `pause` | Cold: a multisig wallet on mainnet |
| Prover key (`PROVER_PRIVATE_KEY`) | `ANCHOR_ROLE`; ETH for gas | `anchorCommits`, `anchorReveals`, `settleRound`. It receives the prover fee, because the prover puts its own address in `feeRecipient` | Hot, on the prover server |
| Bee node wallet | The key of the Bee node; BZZ and gas on the chain of the Swarm postage contract | Owns the postage batch for the uploads and signs the stamps | Hot, in the Bee node |

Do not use the prover key for the postage batch. The owner of a batch signs each stamp, so its key must be
in the Bee node that uploads.

**If an attacker gets a key.**

| Key | What an attacker can do | What an attacker cannot do | Recovery |
| --- | --- | --- | --- |
| Prover key | Spend its ETH. Anchor wrong or empty lists: the nodes must then use the escape hatches and pay their gas. Stop the anchors: anybody can call `anchorEmptyCommits`, and the nodes force their entries | Change a result: each settlement needs a valid proof. Take the pot: the payout goes to the proven winner. Freeze a node without reason | The admin revokes `ANCHOR_ROLE` from the key and grants it to a new key |
| Bee node wallet | Spend its BZZ and gas. Upload junk with the batch, which can push the anchored lists out of the mutable batch | Change a result: a reader checks the lists against the roots on chain | Make a new Bee wallet and batch. A round whose lists are lost does not settle, and its pot stays for a later winner |
| Admin key | Propose a verifier that accepts any proof. After `verifierDelay`, that verifier can pay the pot to anybody. Everybody can see the proposal first, and the admin can cancel it. Revoke the prover. Pause | — | This is the critical key. Use a multisig wallet and a long `verifierDelay` on mainnet |

**Wallet balances.** Keep a few days of funds on each hot wallet, and refill it from a cold wallet. A small
balance limits the loss if an attacker gets the key.

- Prover key: there are about 112.5 rounds each day. A claimed round costs about 1.0M gas for
  `settleRound` and about 130k gas for the two anchors (sections 8.6 and 8.7). Thus a day costs at most
  about 130M gas, which is 0.13 ETH at a gas price of 1 gwei (10^-9 ETH). This is an estimate from the local measurements.
- Bee node wallet: the batch, and gas for some top-ups. `swarm-prover stamp buy --dry-run` prints the
  price of a batch.

If the prover key has no ETH, the prover cannot anchor the rounds. The nodes then use `anchorEmptyCommits` and the
escape hatches. If the batch expires, the uploads stop. The rounds still settle, but other provers cannot
get the anchored lists.

**Setup checklist.**

1. Make the keys of the table above. Fund the hot wallets.
2. Deploy the contracts, or ask the admin to grant `ANCHOR_ROLE` to the prover key.
3. Make the proving key of each circuit size that `Settlement.gameCircuits` holds (section 9). A proving
   key is the file that a prover needs for one circuit size. Start
   `snarkd serve -game DIR1,DIR2`.
4. Optional: run a Bee node and buy the batch with `swarm-prover stamp buy --depth 20 --days 30`. The
   command prints the batch id.
5. Start the prover:

   ```bash
   SWARM_API=http://localhost:1633 SWARM_BATCH_ID=<id> SWARM_TOPUP_DAYS=30 \
     PROVER_PRIVATE_KEY=... RPC_URL=... SETTLEMENT_ADDRESS=... swarm-prover serve
   ```

   Without `SWARM_API` and `SWARM_BATCH_ID`, the prover uploads nothing. All other functions do not change.
6. Monitor the ETH of the prover key, the batch (`swarm-prover stamp status`), and the log lines
   `anchored`, `reveals anchored` and `settled`.

## 4. What changes compared with master

### 4.1 Bee (game code only)

- **Game key.** Each node makes an EdDSA key pair on Baby Jubjub and registers the public key one time
  in `GameKeyRegistry`. The node signs its commits with this key.
- **Commit hash.** `obfuscatedHash = MiMC(overlay, depth, hash, nonce)`. A 256-bit value goes into the
  hash as two 128-bit halves.
- **Commit signature.** The node signs `MiMC(DOMAIN, chainId, settlement, round, obfuscatedHash)`.
- **List check.** The node checks its own entry in the anchored lists with 8 sibling hashes (section 3.4).
- **Messages.** The node sends its commit, reveal and claim witness to the prover over HTTP, and uses the
  escape hatches when the prover leaves it out (section 3.5).

### 4.2 Contracts

| Contract | Change |
| --- | --- |
| `Redistribution` | Not deployed. `Settlement` takes its roles: `REDISTRIBUTOR_ROLE` on `StakeRegistry` and on the postage contract, and `PRICE_UPDATER_ROLE` on the price oracle. |
| `Settlement` (new) | Runs the rounds of section 3. Groth16 verifiers for the game circuit (section 5), in two sizes (`gameCircuits`): a prover uses the smallest one that holds the round. It pays a winner the pot that `PostageStampSnark.potAt(round)` gives, minus what it paid before. |
| | `settleRound` takes the two block headers. It checks their hashes and reads `prevrandao`. |
| | `settleRound` takes the claim witness and checks it on chain (`ClaimVerifier`). A round with reveals and without a valid witness is "unclaimed". |
| | The forced-entry hash chains (`forceCommit`, `forceReveal`) use MiMC. A forced entry costs about 16k to 60k gas more than with keccak256. The circuit then has room for many forced entries at a low cost. |
| | The stake records enter through `GameKeyRegistry.commitmentOf(owner)`. |
| `ClaimVerifier` (new) | The claim checks of `Redistribution.claim`: chunk inclusion proofs, postage stamp signatures, single-owner chunk signatures, the order of the witnesses and the reserve size estimate. |
| `GameKeyRegistry` (new) | Holds the game key of each node. Holds a MiMC commitment of each stake record with its game key, and computes it again only when the record changes. |
| `MiMC`, `GameVerifier8`, `GameVerifier16` (new) | MiMC on chain, and the Groth16 verifiers that `snarkd setup` writes. |
| `PostageStampSnark` | Replaces `PostageStamp`. Computes the pot on chain with bucket sums (section 6). The batch functions and events do not change. |
| `PriceOracleSnark` | `PriceOracle` with 64-block rounds, and `adjustPriceForRound`. |
| `Staking.sol` (`StakeRegistry`) | No change. |

### 4.3 Prover

- `prover/crates/vm` keeps the game as a Rust function. It is the reference: it computes the result and
  the witness (the private inputs) of the circuit.
- `prover/snark` (Go, gnark) holds the circuit, the setup and the Groth16 prover.
- The prover service calls the Go prover for each round.

### 4.4 Rule differences from `Redistribution.sol`

| Rule | Master | This design | Reason |
| --- | --- | --- | --- |
| Commit | A transaction; `msg.sender` is the committer | A message signed with the EdDSA game key | No transaction for each node. EdDSA costs few constraints |
| Commit order | Transaction order | Anchored commits sorted by owner, then forced commits in chain order | No transactions to order |
| Commit list leaf | — | `MiMC(owner, obfuscatedHash, R.x, R.y, S)`: the signature is in the leaf | A prover cannot replace a good signature with a bad one to drop a commit |
| Anchored commit with a bad signature | — | Does not count | A prover that anchored a bad entry must not make the round impossible to prove |
| Stake age | 2 rounds | `Settlement.stakeAgeRounds`, default 2. `STAKE_AGE_ROUNDS=0` at deployment is for test networks only | Faster tests |
| Stake record | Read at `commit` | Read at `settleRound`. A commit counts only for a stake that is old enough. If the owner changed the stake record after the round started, the node gets the no-reveal freeze. If the change was a freeze of `Settlement`, the commit does not count and the node gets no freeze | A node must not leave the round after it saw the seed. A frozen node cannot commit on master, so it must not get a second freeze here |
| Seed | `prevrandao` at the first reveal | `prevrandao` of block 48, read from its header | The prover and the block builder must not influence the randomness (section 3.3) |
| Random draws | keccak256, 128 bits | MiMC, 80 bits | Products must fit in the field (253 bits) |
| Freeze lottery for a disagreement | `block.prevrandao % 100` | `MiMC(seed, 2) % 100`, from the low 64 bits | Same as the seed |
| Invalid reveal | Reverts, so the node stays "not revealed" | Does not count, so the node stays "not revealed". The first valid reveal of a node counts | Same effect |
| Stake amounts | uint256 | less than 2^96 | Products must fit in the field. The BZZ supply is less than 2^80 |
| `depth - height` of a reveal | 0..255 | 0..64 | Same reason |
| Batch balance, outpayment | uint256 | less than 2^128 | Same reason |
| Postage accounting | `expireLimited` removes expired batches from a sorted tree and adds to the pot. Stamp buyers and claims pay for it | Bucket sums in `PostageStampSnark` (section 6) | Stamp buyers pay only for their own batch |
| When the pot increases | Exact when `expireLimited` runs | Each batch pays exactly its balance; the last part (less than one bucket) arrives late | The contract does not know the batches in expiry order |
| Claim batch check | The batch exists: `expireLimited` did not remove it yet | The batch is alive at the settlement (`isBatchAlive`) | The contract has the batch records |
| Claim | Anybody calls `claim` in the claim phase | Anybody sends the witness to a prover, or calls `forceClaim` (blocks 49-63). The payout always goes to the selected winner | The same, off chain |
| Capacity | No limit | Fixed: P slots for each proof. Anchored and forced entries share them (anchored + forced <= P) | A circuit has a fixed size. With shared slots, a round in which every node forces its entry (no anchor) fits the same circuit |


## 5. The game circuit and its public inputs

The game circuit proves the commits, the reveals, the truth, the winner and the freezes. It has no
sha256. A node in the round can make this proof. The circuit exists in two sizes.

(An earlier version had a second circuit for the postage accounting. Section 8 has its numbers. The
accounting is now on chain, section 6.)

The public inputs are field elements that `Settlement` builds from its own state and from the outcome
(`_gameInputs`). Small values are packed into one element.

Game circuit, 12 + P inputs:

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
11  freeze codes: 2 bits for each entry, entry k at bit 2k; and from bit 128, one bit for each entry:
    the stake record was last changed by a freeze of Settlement (`Settlement.frozenUntil`)
12+ the stake commitment of the entry in each slot (zero if unused)
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
other users.

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
  `PostageStamp` and on `PostageStampSnark` in the same blocks: the pot of `PostageStampSnark` is never more
  than master's pot, and it is equal when all batches are expired.
- A batch stops to pay at the start of its bucket and pays the rest at the end of its bucket. So the
  last part of its balance (less than one bucket) arrives late, never early.
- A new balance must be in a later bucket than the current one. The minimum balance of a batch
  (`minimumValidityBlocks` x price) is more than one bucket, so this is always true.
- The pot of a game round is fixed at the round's seed block (`potAt(round)`). The first accounting
  after a seed block stores the pot at that block. `anchorCommits` calls `checkpoint()`, so each round
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
   ./snark/snarkd setup -p 8 -out keys-game8
   ./snark/snarkd setup -p 16 -out keys-game16
   cp keys-game8/GameVerifier8.sol keys-game16/GameVerifier16.sol ../src/settlement/groth16/
   ```

3. Start a local chain, deploy the contracts and stake the nodes (repository root):

   ```bash
   anvil --block-time 1
   WALLET_SECRET=<key of anvil account 0, no 0x> SNARK_P=16 SNARK_P2=8 npx hardhat deploy --network snarklocal
   NODE_KEYS=<keys of anvil accounts 1-5> npx hardhat run scripts/snark/setup-nodes.ts --network snarklocal
   cast rpc anvil_mine 0x190
   ```

4. Start the proof daemon, the prover and the node simulator (`prover/`):

   ```bash
   ./snark/snarkd serve -game keys-game8,keys-game16
   export RPC_URL=http://127.0.0.1:8545
   export SETTLEMENT_ADDRESS=$(jq -r .address ../deployments/snarklocal/Settlement.json)
   PROVER_PRIVATE_KEY=<key of anvil account 0> ./target/release/swarm-prover serve
   BATCH_OWNER_KEY=<key of anvil account 0> ./target/release/node-sim --depth 0 --silent 3 --liar 4 --forced 2 --rounds 6
   ```

`snarkd` has more commands: `size -p 16` prints the number of constraints of a circuit, and
`check -witness w.json` solves the circuit for one witness without a proof (the fast test loop).
`snark_synth NODES FORCED SLOTS` (in `prover/crates/vm`) writes the witness of a synthetic round.

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

For comparison, the earlier SP1 zkVM version (branch `feat/zk-settlement`) needs about 5 minutes and
10 GB for one round on the same class of machine.

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

| Transaction | Gas | SP1 version (`feat/zk-settlement`) |
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
| noanchor | The prover does not anchor; 4 nodes | 2 of 2 | 16/4 | A node calls `anchorEmptyCommits`, all 4 nodes force commit and reveal, the round pays out |
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
proof (the game) and pays from the pot that `PostageStampSnark` computes.

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

After the run, `Settlement.potPaid` (5.46e13) is less than `PostageStampSnark.cumulativePot` (5.71e13),
and the token balance of `PostageStampSnark` (1.68e15) covers the pot.

Parts of one claimed round (964,010 gas):

| Part | Gas |
| --- | --- |
| Game verifier (22 public inputs) | 446,521 |
| Stake commitments (5, from the cache) | 113,115 |
| Claim checks | 94,394 |
| Price change, with the pot accounting | 84,851 |
| Payouts | 34,744 |
| Other (calldata, block headers, storage) | about 190,000 |

Gas of the stamp operations, on master's `PostageStamp` and on `PostageStampSnark` (30 batches, measured
with a script on the hardhat network):

| Operation | Master | `PostageStampSnark` |
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

## 9. Circuit sizes: how to choose them and how to add one

Read this section before you change a circuit size, add a size, or change the game rules. It also
applies when you build the circuits for a real network.

### 9.1 Words

- **Circuit size.** A circuit has a fixed number of slots: P slots for commits and P for reveals.
  Anchored entries and forced entries (from the escape hatches) share the slots: the anchored ones
  first, then the forced ones. Any mix fits as long as their sum is at most P. P must be a power of
  two.
- **Proving key.** The file that a prover needs to make a proof for one circuit size. A node that
  proves keeps it in memory.
- **Verifier contract.** The Solidity contract (`GameVerifier<P>.sol`) that checks proofs for one
  circuit size. `snarkd setup` writes it together with the proving key.
- **Trusted setup.** The step that makes the proving key and the verifier contract. It uses a random
  secret. Anyone who keeps this secret can make proofs for any result, so the secret must be
  destroyed. On a real network, many independent parties make the setup together (a ceremony). The
  result is safe if one of them destroyed their part.

### 9.2 Measured sizes

Apple M4 Max, 2026-11-16. Peak memory is the whole proof process, with the keys.

| Circuit (P slots) | Constraints | Peak memory | 4 cores | 1 core | Proving key | Public inputs |
| --- | --- | --- | --- | --- | --- | --- |
| 8 | 180,077 | 0.36 to 0.38 GB | 0.7 s | 2.7 s | 64 MB | 20 |
| 16 | 360,626 | 0.70 GB | 1.4 s | 5.2 s | 127 MB | 28 |
| 32 | 738,897 | about 1.4 GB (estimate) | — | — | — | 44 |

The earlier circuits with separate slots for forced entries were larger for the same number of
commits: 193,227 constraints for 8 commits and 2 forced entries, 389,728 for 16 and 4, and 808,423
for 32 and 8 (1.3 to 1.45 GB, 10.8 s on one core).

### 9.3 What changes with the size

- **Memory and proof time increase faster than the size.** The circuit compares each entry with each
  reveal, to find the first valid reveal of each node. So the number of constraints increases with
  P x P. When you double the slots, the constraints become about 2 times more.
- **A node with little memory can prove only small sizes.** A Bee node class machine (about 1 GB free)
  can prove 16 slots. 64 slots needs about 3 GB (estimate).
- **Gas increases with the size of the verifier, not with the size of the round.** Each slot is one
  public input of the verifier, and each public input costs about 6,500 gas. The verifier for 8 slots
  has 20 inputs, and for 16 slots 28 inputs. A verifier for 64 slots (76 inputs) costs about 800,000
  gas (estimate). The prover always uses the smallest size that holds the round, so a small round does
  not pay for a large circuit.
- **Each size needs its own trusted setup** and its own verifier contract.

### 9.4 Limits that do not depend on the circuit

- `Settlement.gameCircuits` has 2 entries. To hold more sizes, make the array longer. This is a
  contract change.
- The anchored commit and reveal lists are MiMC trees of depth 8 (`ListDepth`, `LIST_DEPTH`). So P
  cannot be more than 256. A larger P needs a deeper list tree in the circuit, the Rust reference and
  the prover service at the same time.
- A round with more entries than the largest size holds cannot settle. Its pot stays in the contract
  for the next claimed round, and the next rounds settle after `PENDING_ROUNDS`.

### 9.5 How to choose the sizes

1. Find the largest number of nodes that play in one round on the real network, and how often it
   happens. In the last 20 Gnosis rounds before 2026-11-15, about 3.8 nodes played in each round.
2. Use a small size that holds almost every round, for example 8 slots. Small rounds then cost the least
   gas, and small nodes can prove them.
3. Use a large size that holds the largest round you expect, with a margin, for example 64 slots. It is
   the safety net. At least one prover with enough memory must have its proving key.
4. If large rounds are frequent, consider the change in section 9.7 first.

### 9.6 How to add or change a size

1. Make the keys and the verifier contract:

   ```bash
   cd prover
   ./snark/snarkd setup -p 64 -out keys-game64
   ```

   This is a local setup: use it only for tests. For a real network, make the keys in a ceremony.
2. Copy `keys-game64/GameVerifier64.sol` to `src/settlement/groth16/` and deploy it.
3. Register it in a slot of `Settlement.gameCircuits` (`proposeVerifier(slot, verifier, P)`). After
   `verifierDelay` (for example 7 days on mainnet), anybody can call `applyVerifier`.
4. Start the provers with the keys of every size: `snarkd serve -game keys-game8,keys-game64`. The
   prover service uses only the sizes that both the contract and `snarkd` have, and picks the
   smallest one that holds the round.

### 9.7 Every rule change needs new circuits

- A change to the game rules changes the circuit, the Rust reference (`prover/crates/vm/src/snark`)
  and sometimes the contract. The circuit and the reference must give the same public inputs: test
  them with `snark_synth` and `snarkd check`, with random rounds and with tampered witnesses (see the
  scratch tests of 2026-11-16 for the method).
- After a rule change, every size needs a new trusted setup and a new verifier contract, and the
  change takes effect only after `verifierDelay`.
- **Possible change, if large rounds are frequent:** the prover gives, for each node, the position of
  its first valid reveal, and the circuit checks only that reveal and that no earlier reveal of the
  node is valid. Then the constraints increase in proportion to the size, not faster. This change must
  keep the rule "the first valid reveal counts". It is not built.

### 9.8 Why the slots are shared

A local run with 6 nodes and no anchor showed the problem of separate slots: all 6 nodes forced their
commits, the circuit had 4 slots for forced entries, and no proof was possible for the round. The
round blocked the next rounds for `PENDING_ROUNDS` and then dropped out. With shared slots the same
round settled in the 8-slot circuit (proof 0.33 s, `settleRound` 1,010,218 gas). The shared circuit is
also smaller: anchored commits and forced commits use the same signature check and the same reveal
comparison.

## 10. Open items

- **Trusted setup.** Groth16 needs a setup ceremony for each circuit version and each size (section
  9.1). The keys in this
  prototype come from a local setup, which is not safe for a real network.
- **Circuit review.** Nobody has audited the circuit. The only test is that the circuit and the Rust
  reference give the same hash of the public values, on synthetic rounds and on the local run.
- **Gas.** `settleRound` costs about 1.0M gas for a claimed round (section 8.6). The verifier is about 450,000 gas of that.
- **Fixed size.** A round with more entries than the largest game circuit holds cannot settle. The
  contract holds two sizes now; a real network needs a size for the largest neighbourhood. Anchored
  and forced entries share the slots, so a round without an anchor fits the same size. See section 9.
- **Bucket width.** `BUCKET` is a constant. If the price falls so far that the minimum balance of a
  batch is less than one bucket, a purchase with a small balance reverts. The width can become a
  parameter.
- **Pot accounting loop.** The accounting visits each bucket in use that the outpayment passed. After
  a long time without any transaction, one call does all of that work.
- **Game key.** A node can set its key one time. A rule for a key change is necessary. A node that
  registers its first key during a round can decide late whether its commit counts.
- **Batch check time.** The claim checks read the batch at the settlement, not at the seed block.
- **Contract tests.** `Settlement` has no contract tests. The SP1 version had `test/Settlement.test.ts`,
  and this branch removed it. No test on this branch covers the Swarm uploads of the anchored lists.
