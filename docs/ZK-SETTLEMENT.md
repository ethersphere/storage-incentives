# ZK settlement: implementation (option 4)

Branch `feat/zk-settlement`. This is the working implementation of the proposal in
[ZK-REDISTRIBUTION.md](./ZK-REDISTRIBUTION.md) ("the game off chain, settlement on chain"), option 4 of
the Homecoming deck. It is built so it can be run end to end on Sepolia with simulated nodes.

**Status:** a prototype. All of `Redistribution.sol` runs off chain and is proven with SP1:

- the game: commit, reveal, eligibility, truth and winner selection, freezes, redundancy for the price
  oracle;
- the storage evidence of `claim`: chunk inclusion proofs in the reserve sample, transformed chunk
  addresses, postage stamp signatures, single-owner chunk (SOC) signatures, the order of the witnesses,
  and the reserve size estimate;
- the postage accounting that `PostageStamp.expireLimited` did on chain: batch expiry and the pot
  (section 2, "Postage accounting in the proof").

Two cross-checks with the real contracts:

- The Rust claim checks accept the claims that the real `Redistribution.claim` accepts in master's tests,
  including the Bee-generated CAC and SOC proofs.
- The Rust postage accounting gives the same pot and `validChunkCount` as master's `PostageStamp` at every
  checkpoint of three random batch histories.

This version ran end to end on a local chain with mock proofs (section 5, 2026-11-02). A real Groth16
proof of this version came from the Succinct Prover Network in 42 seconds and passes SP1's verifier
contract. Then live rounds were settled with real network proofs on a local chain, with Settlement using
SP1's real Groth16 verifier, and on Sepolia with SP1's verifier gateway (section 5, 2026-11-03).

**Latest state (2026-11-04):**

- **Censorship.** The prover anchors both off-chain lists on chain: the commits (`anchorRound`, blocks
  16-19) and the reveals (`anchorReveals`, blocks 40-43). After each anchor, a node has 4 blocks to see
  that it was left out and to use `forceCommit` or `forceReveal`. A test mode of the prover censors
  chosen nodes. With it, local runs and Sepolia runs with real proofs settled with all censored nodes
  counted (section 5).
- **Soundness tests.** A test changes each private input of the VM and checks that the prover cannot
  get another outcome with the same public inputs. A real Sepolia proof is checked against SP1's
  verifier: every change to the outcome, the inputs, the key or the proof is rejected (section 5).
- **Real Gnosis postage data.** The full Gnosis postage history (226k events, 8,013 live batches)
  replays with the same total outpayment as Gnosis (section 5).
- **Merkle postage state.** The live batches are now an indexed Merkle tree; the proof touches only the
  batches that change, expire or are read by a claim. With the SP1 keccak precompile (which the program
  did not use before), one settlement with the Gnosis state went from 369M to 5.9M cycles. The number
  of batches no longer changes the cost (section 2, "The batch tree"; section 5).
- **Round ring.** Round state is kept in 256 reused entries, so anchors and forced messages write only
  used storage slots (section 2, "Round storage").
- **Sepolia (2026-11-08, with the cut of each round, the direct payout, the `OutOfGas` guard and
  `PENDING_ROUNDS`).** Settlement `0x187383d796982750b7F9c111f62B239675aC6116`, PostageStampZK
  `0xe3eeD32e9D8b67372d0E9BB8B6936084E1f54482`, PriceOracleZK `0x0C95D4439e3A80E9F20b7E3Ff68a340563048428`,
  StakeRegistry `0x8Ff0bE93D1edB72c58A9d51C42D9c11e726a55ae`, sBZZ
  `0x1e96D92aEF6ceA3cE35D1697F6C35877BadD7232`; SP1's verifier gateway; program key
  `0x0027935554b533c1957b7a2b8b5471239bd82a634f160457b60a367724314669`. Source verified on Etherscan and
  Sourcify. The contracts of 2026-11-05 (Settlement `0x9dC237bEeB7fa2E5EBBa0F68e0BD4DEe963Cc448`) are
  no longer used. Run: section 5, "Long run on Sepolia".
- **Data layer.** The anchored lists are Merkle roots (a node checks its own entry with a proof). The
  prover uploads the lists and a daily postage snapshot to Swarm, and rebuilds the postage state from
  the chain (or a snapshot) when its file is missing. Uploads are off until a postage batch is bought
  (`swarm-prover stamp buy`). Prover keys, actions and costs: [ZK-PROVER-OPERATIONS.md](./ZK-PROVER-OPERATIONS.md).
- **Robustness tests (2026-11-06).** Shadow mode against real Gnosis rounds, two provers at the same
  time, the edges of the rings, and escape hatches under full blocks. They found two faults, and both
  are fixed: a round anchored by a prover that then stopped blocked all settlement for 8191 blocks, and
  a forced transaction that was not mined in its first block stayed stuck until its window closed (an
  honest node was then frozen). A third fault came from the ring test: about 8,192 postage log entries
  before a settlement made the round unsettleable. PostageStampZK now keeps the cut of each round. Results:
  section 5, "Robustness tests".
- **Review fixes (2026-11-04).** A hard review found nine problems; all nine are fixed, each with tests
  and a local run:
  1. a node could leave a round after it saw the seed, to escape a freeze (now: non-reveal freeze);
  2. the prover could choose who is paid: late cut, skipped rounds, withheld claim (now: cut = seed
     block, no skipping of a round that can still settle, `forceClaim` backstop at block 58);
  3. anybody could take the prover fee by front-running (now: `feeRecipient` in the proof);
  4. cheap top-ups could block every settlement (now: PostageStampZK keeps the cut of each round);
  5. junk could fill the escape-hatch caps (now: staked addresses only, once per round);
  6. a stopped prover stopped the game (now: `anchorEmpty` fallback);
  7. the prover API could be flooded, and node-sim waited forever (now: limits, cache, 5 s timeout);
  8. block builders could grind the randomness (now: `prevrandao` from the headers);
  9. verifier changes took effect at once (now: timelock).
- **Next.** Buy the batch and turn on the uploads, a gas comparison on Sepolia, and the rest of the
  optimization plan (section 7, "Open items").

---

## 1. What changed compared with master

| Contract | Change | Why |
| --- | --- | --- |
| `PostageStamp.sol` | **replaced by `settlement/PostageStampZK.sol`** | The same batch functions, events and views, without the batch tree and without on-chain expiry. It logs every change that affects the pot, and pays out the amount the proof gives. Section 2, "Postage accounting in the proof" |
| `Staking.sol` (`StakeRegistry`) | **none** | Settlement calls `freezeDeposit` with `REDISTRIBUTOR_ROLE` and reads stake records with existing views |
| `PriceOracle.sol` | **none** | Settlement calls `adjustPrice(redundancy)` with `PRICE_UPDATER_ROLE`. The redundancy number comes out of the proof |
| `Redistribution.sol` | **not deployed** | Left in the tree untouched so master's tests still run. Settlement takes its three roles |
| `settlement/Settlement.sol` | **new**, ~550 lines | Anchors each round, keeps the censorship escape hatches (commit, reveal, claim), checks proof inputs against the chain (including PostageStampZK's event log), executes the outcome |
| `settlement/ISP1Verifier.sol` | new | Interface of the SP1 verifier |
| `settlement/SP1MockVerifier.sol` | new | Accepts empty proofs. Local and smoke testing only |

StakeRegistry and PriceOracle are master's code, deployed as they are. PostageStamp changes, because the
expiry tree is the main gas cost for stamp buyers. The homecoming to Ethereum needs new deployments and a
batch migration in all cases, so this change adds no extra migration.

### New files

```
src/settlement/Settlement.sol          replaces Redistribution
src/settlement/PostageStampZK.sol      replaces PostageStamp: no tree, event log for the proof
src/settlement/ISP1Verifier.sol
src/settlement/SP1MockVerifier.sol
test/Settlement.test.ts                contract tests (mock verifier)
test/PostageStampZK.test.ts            PostageStampZK tests; random histories against master PostageStamp (DUMP_POSTAGE_VECTORS=1)
test/util/claimVectors.ts              dumps accepted Redistribution claims as Rust test vectors (DUMP_CLAIM_VECTORS=1)
deploy/zk/000_deploy_core.ts           token, oracle, staking (master code) and PostageStampZK
deploy/zk/001_deploy_settlement.ts     verifier (mock or SP1 gateway) + Settlement
deploy/zk/002_roles_and_pot.ts         roles Redistribution had -> Settlement; price; one batch so the pot grows
scripts/zk/setup-nodes.ts              fund and stake simulated nodes
hardhat.config.ts                      networks zklocal (anvil) and sepoliazk, both use deploy/zk/
helper-hardhat-config.ts               sp1VerifierGateway for sepoliazk
prover/                                Rust workspace, see prover/README.md
  crates/vm/src/lib.rs                 the Redistribution VM (game rules as a pure function)
  crates/vm/src/claim.rs               claim's storage checks (inclusion, stamp, SOC, order, size)
  crates/vm/src/bmt.rs                 BMT and transformed BMT hashing and proofs
  crates/vm/src/sample.rs              reserve sample and claim witness builders (node side)
  crates/vm/src/postage.rs             postage accounting: event replay, expiry, pot
  crates/vm/src/postage_tests.rs       postage unit tests
  crates/vm/tests/claim_vectors.rs     differential test against claims Redistribution accepted
  crates/vm/tests/postage_vectors.rs   differential test against master PostageStamp's pot
  crates/vm/tests/vectors/             bee-cac, bee-soc, generated-cac, generated-soc, postage-1..3
  program/                             the SP1 program (runs the VM, commits public values)
  service/src/main.rs                  swarm-prover: serve | vkey | execute | synth
  service/src/settler.rs               anchor loop, settle loop, round input from chain state
  service/src/server.rs                HTTP API for nodes
  service/src/prover.rs                SP1 execute / prove
  service/src/store.rs                 per-round message store and postage state (stand-in for Swarm as DA)
  service/src/bin/node_sim.rs          simulated Bee nodes
docs/ZK-SETTLEMENT.md                  this file
docs/ZK-SETTLEMENT-OPTIMIZATION.md     plan to decrease mainnet gas further
docs/ZK-REDISTRIBUTION.md              the proposal (copied from docs/zk-redistribution-proposal)
```

---

## 2. Architecture

```
  Bee nodes (node-sim)                                     Ethereum / Sepolia
  ─────────────────────                                    ───────────────────────────────────────────
  sign commit ──POST /v1/commit──►┐                       PostageStampZK  StakeRegistry   PriceOracle
  reveal      ──POST /v1/reveal──►│                         ▲ withdraw(amt) ▲ freeze       ▲ adjustPrice
                                  │                              └───────┬───────┴──────────────┘
  claim proofs ─POST /v1/claim───►│  (after the seed; the winner)
  (censored?) forceCommit / forceReveal / forceClaim ──────────►  Settlement
                                  │                                ▲ anchorRound(commitsHash)   (1 tx/round)
                                  │                                │ anchorReveals(revealsHash) (1 tx/round)
                         swarm-prover (service)                    │ settleRound(pv, proof)     (1 tx/round)
                         ├─ store messages ───────────────────────┘
                         ├─ read chain: anchor, seed, forced events, stake records, PostageLog, game state
                         ├─ swarm-vm::run(input)       native, sanity check
                         └─ SP1: program(input) ─► Groth16 proof ─► settleRound
```

Three transactions per round for the whole network, instead of about three per participating node today.
Uploaders who buy or top up stamps send their own transactions to PostageStampZK, as today, but they do
not pay for the expiry of other batches.

### Round timing

`ROUND_LENGTH = 64` blocks. With 12 s blocks (Sepolia, Ethereum mainnet) a round is 768 s, about 12.8
minutes: the same time as the Redistribution round on Gnosis (152 blocks × 5 s = 760 s). All phases are
scaled from the Gnosis layout. Measurements in section 5 before 2026-11-03 used 152-block rounds.

| Blocks in round | Phase | What happens |
| --- | --- | --- |
| 0-15 | commit | Nodes sign commits and send them to a prover, or call `forceCommit` |
| 16-19 | anchor | The prover calls `anchorRound(round, commitsHash, count, dataRef)` once. If it does not, anybody can call `anchorEmpty(round)` in blocks 20-23 |
| 20-23 | commit check | Each node compares the anchored list with `commitsHash` on chain. A node that is missing calls `forceCommit` (open until block 23) |
| 24-39 | reveal | Nodes send reveals to the prover, or call `forceReveal` |
| 40-43 | reveal anchor | The prover calls `anchorReveals(round, revealsHash, count, dataRef)` once. The prover accepts no more off-chain reveals |
| 44-47 | reveal check | Each node compares the anchored reveal list with `revealsHash` on chain. A node that is missing, or a node in a round without `anchorReveals`, calls `forceReveal` (open until block 47) |
| 48 | seed block | Its block hash becomes the selection seed. Nobody chooses it |
| 49-63 | claim | Truth and winner are known. The winner (or any node that holds the truth's sample) sends the three claim proofs to the prover, or calls `forceClaim` |
| 49 onward | settle | Anyone with a valid proof calls `settleRound`. Rounds settle in increasing order. A round whose truth has no valid claim ("unclaimed") settles only from block 64 (the next round) |

### Round storage: a ring of 256 entries

Settlement keeps the state of a round (anchored commit and reveal hashes, forced hash chains, counts,
flags) in `ring[round % 256]`, not in a new storage entry for each round. When a new round takes an
entry, it writes the slot with the round number, the counts and the flags. The five hash slots are never
set back to zero; a hash counts only when its count or flag says it is from this round. `rounds(round)`
returns the round's state with zero for everything that is not set.

**Why.** A write to a storage slot that is zero costs a new-slot write. A write to a slot that is in use
costs about 5k gas. On Sepolia a new-slot write costs about 110k gas, so the anchors cost 355k and 246k
gas with a new entry for each round (section 5). With the ring, the entries are reused after 256 rounds.
`warmRing(from, count)` (admin) fills entries once, so that the first use is cheap too.

**Why 256 is safe.** A round can settle only while EIP-2935 serves the block hash of its seed block:
8,191 blocks, which is 128 rounds (about 27 hours). Round N stays settleable until block 47 of round
N + 128. Round N + 256 takes its entry about 27 hours after that. A round whose entry was taken cannot
settle (`NotAnchored`), and it could not settle anyway. The round anchor is not stored: Settlement
calculates it from the block hash before the round start. Its block is 49 blocks older than the seed
block, so the last 49 blocks of the 8,191-block window are not available for a settlement.

### Randomness

- **Round anchor** (neighbourhood selection) = `keccak256(abi.encode(prevrandao of block roundStart - 1,
  round))`. Every node knows it from the first block of the round: it reads `prevrandao` (the header's
  `mixHash`) from its Ethereum node.
- **Selection seed** (truth, winner, freeze lottery) = `keccak256(abi.encode(round anchor, prevrandao of
  block roundStart + 48))`. It is fixed after every commit and reveal deadline.
- **How the contract checks it.** A contract cannot read the `prevrandao` of an earlier block. So the
  proof gets the RLP headers of the two blocks, checks that each header hashes to the block hash it
  commits to (`anchorBlockHash`, `seedBlockHash`), and reads `mixHash` from them. Settlement compares the
  two hashes with the block hashes it reads itself (BLOCKHASH, or EIP-2935 for 8,191 blocks). Code:
  `prover/crates/vm/src/randomness.rs`.

**Why `prevrandao` and not the block hash (changed 2026-11-04).** A block builder chooses the
transactions of a block, so it can try many orderings and keep a block hash that selects the neighbourhood
or the winner it wants. With the anchored reveal list public (Swarm data layer), anybody can compute the
winner for each candidate hash. `prevrandao` is fixed before the slot; the proposer can only skip its
slot, which is one bit of influence. This also removes the "first revealer chooses the seed block" lever
of today's contract ([ZK-REDISTRIBUTION.md §6](./ZK-REDISTRIBUTION.md)).

### What the proof commits to

`PublicValues { PublicInputs inputs; Outcome outcome; }`. Both sides share the definition:
`Settlement.sol` and `prover/crates/vm/src/types.rs`.

`settleRound` checks every input against the chain before it executes anything:

| Input | Checked against | Error code |
| --- | --- | --- |
| `chainId`, `settlement` | `block.chainid`, `address(this)` | `InputMismatch(0)` |
| `roundAnchor` | stored at `anchorRound` | 1 |
| `selectionSeed` | recomputed from the seed block hash | 2 |
| `commitsHash`, `commitCount` | stored at `anchorRound` | 3 |
| `revealsHash`, `revealCount` | stored at `anchorReveals`; zero if the prover did not call it | 13 |
| `forcedCommitsHash` | hash chain built by `forceCommit` | 4 |
| `forcedRevealsHash` | hash chain built by `forceReveal` | 5 |
| `lastClaimRound`, `lastWinnerDepth` | Settlement state (minimum depth rule) | 6 |
| penalty parameters | Settlement state | 7 |
| `participants`, `stakeDigest` | `StakeRegistry.stakes(owner)` read now, for every participant: overlay, committed and potential stake, height, last update | 8 |
| `stakePrice` | `PriceOracle.currentPrice()` (the VM computes effective stake from it) | 9 |
| `forcedClaimsHash` | hash chain built by `forceClaim` | 10 |
| `postage`: previous state hash, previous and new log position, log hash, cut block | Settlement's stored postage state hash and log position; `PostageStampZK.cutOf(round)` (the log index and hash at the round's seed block); the cut block must be the round's seed block | 11 |
| `sampleMaxValue` | Settlement state (default: Redistribution's value) | 12 |

Then `verifier.verifyProof(programVKey, publicValues, proof)`. Then it executes the outcome:

1. For every round: store the new postage state hash and log position, and add the proven
   `potAmount` to `accruedPot`.
2. For a round with a valid claim: freezes, `adjustPrice(redundancy)`, then pay out `accruedPot`.
   PostageStampZK pays `proverFeeBps` (default 1%) to `outcome.feeRecipient` and the rest to the winner,
   with two `withdraw` calls. The tokens do not go through Settlement.
   The fee recipient is an output of the proof, not `msg.sender`: before this, a bot could copy a
   `settleRound` transaction from the mempool, send it first and take the fee (found in review,
   2026-11-04).

### What the VM proves (prover/crates/vm/src/lib.rs)

The rules are ported one to one from `Redistribution.sol` on master:

- commit signatures (EIP-191 over `commitDigest`) recover to the committing owner;
- the stake is older than two rounds (`MustStake2Rounds`);
- `wrapCommit(overlay, depth, hash, nonce) == obfuscatedHash`;
- `depth >= currentMinimumDepth` (from the last winner's depth and rounds since the last claim);
- `inProximity(overlay, roundAnchor, depth - height)`;
- `stakeDensity = stake * 2^(depth - height)`;
- truth selection, a stake-density-weighted draw with `keccak(seed, "0", i)`;
- winner selection, a weighted draw over truth-tellers with `keccak(seed, "1", redundancy)`;
- freezes: `2 * ROUND_LENGTH * 2^truthDepth` for committed but not revealed, and `1 * ROUND_LENGTH * 2^truthDepth` for a
  revealed disagreement (behind the random factor);
- redundancy = the number of truth-tellers, which goes to the oracle.

### Claim (prover/crates/vm/src/claim.rs)

`claim` checks three chunk witnesses from the truth's reserve sample: two at random positions
(`seed % 15`, `seed % 14`) and the last one. The port keeps each check of `Redistribution.sol`:

| Check | Redistribution.sol | Rust |
| --- | --- | --- |
| The witness is in the neighbourhood: `inProximity(proveSegment, anchor, depth)` | `claim` | `verify_claim` |
| The witness is in the sample at its position (BMT proof against the truth hash) | `inclusionFunction` (1) | `inclusion` |
| The plain and transformed chunk proofs share the first sister segment | `inclusionFunction` (2) | `inclusion` |
| The opened segment (`seed % 128`) gives the original chunk address | `inclusionFunction` (3) | `inclusion` |
| The transformed address (keyed with the round anchor) is in the sample; for a SOC, `keccak(socAddress, transformed)` | `inclusionFunction` (4) | `inclusion` |
| The batch exists; the stamp index is inside the batch; the stamp bucket matches the address | `stampFunction` | `stamp` |
| The batch owner signed the stamp (EIP-191, strict `ecrecover`: v must be 27 or 28) | `Signatures.postageVerify` | `stamp`, `ecrecover` |
| The SOC owner signed the chunk, and `keccak(identifier, owner)` is the SOC address | `socFunction` | `soc` |
| The witnesses are in ascending order | `checkOrder` | `check_order` |
| The last witness is below `sampleMaxValue` | `estimateSize` | `verify_claim` |

**Differential test.** `test/util/claimVectors.ts` writes the inputs of four claims that the real
`Redistribution.claim` accepts in `test/Redistribution.test.ts` (Bee-generated CAC, Bee-generated SOC,
generated CAC, generated SOC). `crates/vm/tests/claim_vectors.rs` checks that the Rust port accepts all
four, and rejects them after a change to a stamp signature, a SOC signature, the seed, the anchor or the
truth hash. To make the vectors again:

```bash
DUMP_CLAIM_VECTORS=1 npx hardhat test test/Redistribution.test.ts --grep "should claim pot by"
```

**Who sends the claim.** The payout always goes to the selected winner. Thus any node that holds the
truth's sample can send the witness. node-sim lets the winner send it. The prover runs the VM with a
witness before it accepts it at `POST /v1/claim`.

**Unclaimed round.** On master, a `claim` without valid proofs reverts. Then the round has no effect: no
payout, no freezes, no price change. The VM gives the same result, with `unclaimed = true`. Settlement
accepts an unclaimed outcome only after the claim window (block 64 of the round), so a prover cannot close the round
before the winner had time to send the witness.

**Batches come from the proven postage state.** The claim checks read each witness batch (owner, depth,
bucket depth, balance) from the postage state of the proof, after this settlement's log entries. A batch
is alive when its `normalisedBalance` is above the outpayment at the round's seed block. The state is
bound by its hash and the event log, so a prover cannot hide a batch or change its owner.

### Postage accounting in the proof (prover/crates/vm/src/postage.rs)

**Why.** On master, a stamp buyer pays for a sorted tree of all batches (`HitchensOrderStatisticsTree`)
and for the expiry of other batches. `createBatch`, `topUp` and `increaseDepth` call
`expireLimited(max)`, which removes expired batches in order and credits the pot. Bee also sends
`expireLimited(25)` transactions before it buys a batch and before a claim. The tree exists only for the
pot: the pot increases by `validChunkCount × Δoutpayment`, so the contract must know when each batch stops
to count.

**What changes.**

| | Master (`PostageStamp`) | This branch (`PostageStampZK` + proof) |
| --- | --- | --- |
| Batch record | `batches(id)` | The same |
| Batch is expired | Removed by `expireLimited` | `normalisedBalance <= currentTotalOutPayment()`. Nothing is removed; the id stays taken |
| Who expires batches | Stamp buyers, Bee before buys and claims | Nobody on chain. The prover, in the proof, at each settlement |
| Pot | `pot`, increased by `expireLimited` | Computed in the proof; Settlement keeps `accruedPot` |
| Payout | `withdraw(beneficiary)`: all of `pot` | `withdraw(beneficiary, amount)`: the proven amount |
| `validChunkCount` | Live value | Written by Settlement after each settlement (for readers only) |
| `expiredBatchesExist()`, `expireLimited()` | Real | No-ops (false, nothing), so current Bee versions keep working |
| Events | `BatchCreated`, `BatchTopUp`, `BatchDepthIncrease`, `PriceUpdate` | The same, plus `PostageLog` |

**The event log.** Each change that affects the pot (batch created or copied, topped up, deepened, price
changed) appends one entry: `hash_i = keccak256(hash_{i-1}, kind, batchId, owner, depth, bucketDepth,
value, outpayment, block)`. The contract keeps the hash after the last entry (`eventHash`) and emits
`PostageLog` with the same fields.

**The cut of a round.** A settlement replays the log up to the seed block of its round. The first log
entry after a round's seed block stores the log index and hash before it as the round's cut (every
earlier entry is at or before the seed block). Rounds with no entry between their seed blocks share one
cut. `cutOf(round)` returns it, and Settlement checks the proof's log position against it. The cuts of
the last 256 rounds that stored one are kept; an older round cannot settle anyway (its seed block hash is
gone). Log entries do not push a cut out.

Before 2026-11-06 the contract kept the hash and block of the last log entries in a ring (256 entries,
then 8,192), and Settlement read the cut entry from it. Enough cheap top-ups between a round's seed block
and its settlement pushed the cut entry out: the round could never settle, and it blocked later rounds
until its seed was gone. Each entry also wrote a new storage slot until the ring wrapped. With the cuts,
an entry writes only the log hash and count, and one entry in a round also writes a cut: `createBatch`
went from 176,950 to 137,575 gas on Hardhat (two fewer new slots).

**The batch tree.** The live batches are the leaves of a Merkle tree with 2^32 leaves. Settlement
stores only the hash of the postage header, and the header holds the tree root, the next free leaf, the
live chunk count, the last cut block and the last price change. Each leaf is in two sorted linked lists
at the same time:

- by batch id, so that the proof can find a batch, and can prove that a batch does not exist;
- by expiry, (normalisedBalance, id), so that the expired batches are always at the front.

Leaf 0 is the head of both lists. A new batch takes the next free leaf. A top-up or a depth increase
keeps the leaf and its place in the id list, and moves the leaf in the expiry list. An expired batch is
removed from both lists and its leaf becomes empty. This is an "indexed Merkle tree".

The program does not receive the batches. It receives the header, and a Merkle proof for each leaf that
the settlement reads or writes, plus "hints": the leaf of a batch, or the leaf before a key in a list.
The program checks each proof against the current root and calculates the new root after each write. It
checks each hint by the order of the neighbours: for example, the leaf before a new batch must have a
smaller id, and its successor a larger one. Thus a wrong hint makes the proof fail. The prover cannot
hide a batch from a claim: "not found" needs the leaf before the id in the id list, and its successor
must have a larger id.

The algorithm (`postage::apply`) is the same code on two trees. The prover's `FullTree` has every leaf
and writes down the proofs and hints. The program's `WitnessTree` checks them. Thus both sides ask for the
same leaves in the same order.

**One settlement, step by step.**

1. The prover reads Settlement's `postageStateHash`, `postageEventIndex` and `postageEventHash`, loads the
   postage state with that hash (`$DATA_DIR/postage/<hash>.json`, the header and all leaves), and reads
   the `PostageLog` entries after `postageEventIndex` up to the cut block (the current block). It runs
   the settlement on its tree and records the witness.
2. The program replays the entries in order. Before each entry, all batches in the tree pay up to the
   entry's outpayment: `pot += liveChunks × Δoutpayment`. Then the entry adds a batch, or changes a
   batch's balance or depth, or changes the price. The program checks each entry's outpayment against
   the last price change.
3. The program reads the batches of the claim witnesses from the tree (after step 2), and runs the game
   and the claim.
4. All batches pay up to the outpayment at the cut block. Then the program removes the batches at the
   front of the expiry list whose balance the cut reached, and takes back what each one did not pay:
   `size × (outpayment at cut − normalisedBalance)`. A batch never pays more than its balance.
5. The outputs are the new header hash, the pot amount and `validChunkCount`.
6. Settlement checks the log position and hash against PostageStampZK, and that the next entry (if any)
   is after the cut block. Thus no entry up to the cut is missing. Then it adds the pot amount to
   `accruedPot`.

**Cost.** A settlement touches only the leaves of its events, of its expired batches and of its claim:
about 4 leaf proofs for each. The number of live batches does not change the cost (section 5, "Merkle
postage state"). Batch ids `0x00…00` and `0xff…ff` are reserved for the list head and end;
PostageStampZK makes ids with keccak256, so they do not occur.

**Who expires batches?** Nobody has to send a transaction. A batch is expired as soon as its balance ends,
and every reader can calculate this. Bee already calculates it from the events (`pkg/postage/batchstore`,
`cleanup`). The ordered removal and the pot credit are in step 4, once per settlement. If a settlement is
late, batches still expire on time; the next settlement replays more entries and credits the pot to the
correct amount.

**Bee.** Bee does not read `pot`, `totalPot` or `validChunkCount` (checked in `ethersphere/bee`). It
follows the four batch events, which do not change. It calls `expiredBatchesExist()` and
`expireLimited(25)` before it buys a batch (`pkg/postage/postagecontract`) and before a claim
(`pkg/storageincentives/agent.go`). With the no-op stubs these calls cost almost nothing. A later Bee
version can remove them.

**Correctness check.** `test/PostageStampZK.test.ts` runs three random histories (batches created, topped
up and deepened, price changes, blocks mined, batches that expire) on master's `PostageStamp` and on
`PostageStampZK`, in the same blocks. At six checkpoints in each history, master's `pot` (after
`expireLimited`) and `validChunkCount` are recorded. `crates/vm/tests/postage_vectors.rs` replays the
PostageStampZK log with the same cut blocks and gets the same values at all 18 checkpoints. It also gets
the same total with one settlement instead of six.

### Rule differences from Redistribution.sol (forced by the venue)

| Today | Here | Why |
| --- | --- | --- |
| Commit order = transaction order | Anchored commits sorted by owner, then forced commits in chain order | No transactions to order |
| `msg.sender` identifies the committer | EIP-191 signature over `commitDigest(round, obf)` | Same binding, off chain. Domain-separated by chain and contract |
| Stake must be 2 rounds old | `Settlement.stakeAgeRounds` (default 2). `STAKE_AGE_ROUNDS=0` at deploy lets a node play in the round after it staked; for test networks only | Faster tests on Sepolia |
| Stake snapshot at `commit` (`nodeEffectiveStake`) | Raw stake record read at `settleRound`; must be older than `roundStart - 2 rounds`. Effective stake = `min(2^height * committed * price, potential)`, computed in the VM | Avoids a stake snapshot transaction. A stake change or freeze after the round started disqualifies the node for that round, and the node gets the non-reveal freeze. Without that freeze, a node could see the seed, call `manageStake(nonce, 0, height)` (only gas), and leave the round to escape a freeze or to change the draw (found in review, 2026-11-04). Reading the stakes as of round start (optimization item 1) removes the rule. The raw record is used because `nodeEffectiveStake` depends on `block.number` (0 while frozen), which made the first version fail when a freeze expired between proving and settling (regression test in `test/Settlement.test.ts`) |
| Seed updated with `prevrandao` at the first reveal | `prevrandao` of a fixed block (48), read from its header in the proof | The prover must not influence randomness; a block builder must not either (a block hash can be ground) |
| Disagreement freeze uses `block.prevrandao % 100` | `keccak(seed, "2") % 100` | Same reason |
| Invalid reveal reverts, so the node stays "not revealed" | Invalid reveal is ignored, so the node stays "not revealed" | Same effect |
| Anchored commit with a bad signature | Dropped from the round | A prover that anchored garbage must not make the round unprovable |
| `claim` reads the batch at claim time: "exists" means not yet removed by `expireLimited` | The batch comes from the proven postage state; "alive" means balance above the outpayment at the seed block | Batches are no longer removed on chain. The comparison is exact, and it does not depend on when somebody swept |
| `expireLimited` removes expired batches and credits the pot, paid by whoever buys a stamp or claims | The proof replays PostageStampZK's log, expires batches and credits the pot at each settlement | Stamp buyers pay only for their own batch. The pot is the same (differential test) |
| Anyone can call `claim` during the claim phase | Anyone can send the witness to a prover, or call `forceClaim` (blocks 49-63) | The same, off chain |

---

## 3. The hard problems, and what this version does about each

**Input completeness (can the prover leave me out?).** The prover can drop your off-chain commit or
reveal. The escape hatch: `forceCommit` (blocks 0-23) and `forceReveal` (blocks 24-47) record the
message in a hash chain on chain. `settleRound` rejects a proof that does not use exactly that chain.

Only a staked address can use an escape hatch, once per round for each kind (`forceCommit`,
`forceReveal`, `forceClaim`), and `forceReveal` only for its own overlay. The caps (256 forced commits
and reveals, 16 forced claims for each round) keep a round provable. Before this rule (found in review,
2026-11-04), anybody could fill a cap with junk entries for about 12M gas, and then a censored node could
not get in. Now a full cap needs 256 (or 16) staked addresses.

Both off-chain lists are fixed on chain before the escape hatch closes:

- `anchorRound` (blocks 16-19) fixes the commit list. `forceCommit` stays open for 4 more blocks.
- `anchorReveals` (blocks 40-43) fixes the reveal list. `forceReveal` stays open for 4 more blocks.

The anchored hashes are Merkle roots of the lists. A node does not need a list: it asks the prover for a
Merkle proof of its own entry (`GET /v1/rounds/{round}/commit-proof/{owner}` and
`.../reveal-proof/{overlay}`) and checks it against the root and count on chain. No proof, or a proof
that does not check, and the node uses the escape hatch. Without
`anchorReveals`, a prover can keep a commit and drop the reveal. The node then gets a freeze for
non-reveal, and it cannot see the attack before the seed block. node-sim does these checks for every
node. The prover option `CENSOR_COMMITS` / `CENSOR_REVEALS` (test only) runs the attack (section 5).
node-sim's `--forced` flag skips the prover and uses the escape hatches directly. Still open from the
proposal (§7.1c): scoping a forced entry so it re-opens the prover's obligation for several rounds,
not one.

**Ordering.** The commit set is fixed on chain (`anchorRound`) before any reveal is accepted and before
the seed block exists.

**Reveal after the seed is known (fixed).** `anchorReveals` fixes the off-chain reveals at blocks 40-43,
and `forceReveal` closes at block 47. The seed is the hash of block 48. Thus all reveals are fixed
before anybody knows the seed. A node that colludes with the prover cannot see the seed first and then
select to reveal or not. In `Redistribution.sol` the first reveal sets the seed, so each later revealer
has this option.

**Storage possession.** Proven, with the same evidence as `claim` today (section 2, "Claim"). A prover can
withhold the winner's witness, or say in `/outcome` that a node did not win. The defence: if the round is
not settled at block 58, a node that revealed the honest sample calls `forceClaim` itself (node-sim does
this; about 4 KB of witness, about 100k-200k gas). An unclaimed round cannot settle before block 64, so
"settled at block 58" means "settled with a winner". The prover option `WITHHOLD_CLAIMS` (test only) runs
the attack.

**The prover's power over the payouts (fixed 2026-11-04).** Before the fix, the prover could choose who is
paid, and how much: (1) settle a round late with a late cut block, so that its winner gets the pot of the
later rounds as well; (2) settle round N + 1 first, so that round N (and its winner) is skipped and its pot
carries over; (3) withhold the winner's claim witness. Now: (1) the cut block must be the round's seed
block; (2) `settleRound` reverts with `RoundPending` while an earlier anchored round can still settle;
(3) the `forceClaim` backstop above.

**Prover API under load (fixed 2026-11-04).** `/outcome` and `/claim` build a whole round input (dozens
of RPC calls and a VM run). Now: `/outcome` answers are cached for 10 s for each round; `/claim` rejects a
witness that is too large or does not decode before any RPC call, and returns at once if the round
already has a valid witness; at most 2 such requests run at the same time (others get 503). Test: 200
junk claims and 100 parallel `/outcome` requests in a claim phase; the rounds still anchored and settled.
A node must never wait long for the prover: node-sim uses a 5 s timeout, and no answer means "force".

**Prover liveness.** `settleRound` is permissionless. `anchorRound` is limited to `ANCHOR_ROLE` (the
Foundation's prover first, as the proposal says). If nobody settles, the payments stay in PostageStampZK.
The next settlement replays the log and credits them. If no prover calls `anchorRound` in blocks 16-19,
anybody can call `anchorEmpty(round)` in blocks 20-23: the round is anchored with an empty commit list,
the nodes force their commits and reveals, and any prover can settle the round from data that is all on
chain (node-sim does this; the prover option `NO_ANCHOR`, test only, runs a prover that stopped
anchoring). Before this fallback (found in review, 2026-11-04), a stopped prover made every round
unsettleable, and forced entries counted for nothing. Rounds settle in increasing order. An anchored round
cannot be skipped while it can still settle; a round without an anchor is skipped. Section 4 tells who
settles and who pays.

**Upgrade authority (timelock added 2026-11-04).** A new verifier or program key takes two steps:
`proposeVerifier(verifier, programVKey)` (admin), then `applyVerifier()` (anybody) after
`verifierDelay` seconds; the admin can `cancelVerifier()` in between. The delay is fixed at deployment
(`VERIFIER_DELAY`): 0 on test networks, for example 7 days on mainnet. A verifier that accepts anything
could pay the pot to anybody, so nodes and users must see such a change before it takes effect. The admin
must still be a multisig. This is the residual risk L2BEAT flags in Lighter and Derive.

**Data availability (built; uploads off until a batch is bought).** Missing data cannot make a result
wrong: the proof and the escape hatches see to that. It can only stop a round from settling (the round is
skipped and the pot carries over), or keep a new prover from starting. Thus the data goes to Swarm, not
to a data availability layer such as Celestia, and not into Ethereum calldata (about 170k more gas each
round).

| Data | Size | Kept for | Where |
| --- | --- | --- | --- |
| Anchored commit list, with signatures | about 117 bytes for each commit | Until the round settles (at most 128 rounds, about 27 h) | Swarm; its reference is `dataRef` of `anchorRound` |
| Anchored reveal list | about 97 bytes for each reveal | The same | Swarm; `dataRef` of `anchorReveals` |
| Postage state snapshot | about 3.4 MB for the Gnosis state (8,013 batches) | Until the next snapshot (one each day, `SNAPSHOT_EVERY`) | Swarm; its reference is in the next commit-list document |

- Every document can be checked against a hash on chain (the list roots, `postageStateHash`), so a
  reader does not have to trust the prover.
- The uploads use one mutable postage batch of the prover's Bee node (depth 20). When a bucket is full,
  the newest chunk replaces the oldest, so old anchored lists and snapshots drop out by itself.
- The postage state can always be rebuilt from the chain without Swarm: replay the `PostageLog` entries,
  settlement by settlement, with the cut blocks and log positions of the `PostageSettled` events, and
  check the result against `postageStateHash`. The prover does this when its file is missing; with a
  Bee node it starts from the newest snapshot. Ethereum clients will stop keeping old logs (EIP-4444),
  which is a reason for the snapshots.
- Without `SWARM_API` and `SWARM_BATCH_ID`, nothing is uploaded and `dataRef` is the keccak256 of each
  document. Setup, costs and keys: [ZK-PROVER-OPERATIONS.md](./ZK-PROVER-OPERATIONS.md).

**Size of the postage state (fixed).** The proof used to read and hash all live batches at each
settlement: about 46k cycles for each live batch. The batch tree (section 2) touches only the batches
that change, expire or are read by a claim. The cost no longer depends on the number of live batches
(section 5, "Merkle postage state"). The prover still needs the full tree, which is a data availability
question (below).

---

## 4. Prover and settlement: who does what, and who pays

All prover actions, keys, costs and wallet balances, and Succinct against an own GPU, are in
[ZK-PROVER-OPERATIONS.md](./ZK-PROVER-OPERATIONS.md).

| Action | Who | When | Gas paid by | Paid back |
| --- | --- | --- | --- | --- |
| `createBatch`, `topUp`, `increaseDepth` | Uploader | Any time | Uploader (only its own batch) | — |
| Commit, reveal, claim witness | Node, off chain | Each round | Nobody (HTTP) | — |
| `forceCommit`, `forceReveal`, `forceClaim` | Node | Only if the prover censors it | Node | No |
| `anchorRound` | Prover with `ANCHOR_ROLE` (the Foundation at the start) | Blocks 16-19 of each round | Prover | No |
| `anchorReveals` | The same prover | Blocks 40-43 of each round | Prover | No |
| Proof | Prover (own GPU or a proving market) | After block 48 | Prover (off chain) | Through the fee |
| `settleRound` | Anyone with a valid proof; in practice the prover service | From block 49 (unclaimed: from block 64) | Caller | `proverFeeBps` (1%) of the payout, only in rounds with a payout |

**Who calls `settleRound`.** It has no role check: the proof is the permission. The prover service
(`swarm-prover serve`, `settler.rs`) calls it when the round is ready. Another prover, or the winner,
can call it with its own proof. The first valid call wins; a second one reverts with `AlreadySettled`.

**At the start.** The Foundation runs the prover. It pays the gas of `anchorRound` (about 97k on anvil),
`anchorReveals` (about 76k on anvil) and `settleRound` (about 0.5M with a real proof), and the cost of
the proofs. It gets back 1% of the pot in rounds with a payout. The two anchors and rounds without a
payout give nothing back.

**Later.** When the anchored commit and reveal lists and the postage state are public on Swarm, anyone can prove and
settle. The fee is the reward.

**Open points.**

1. **Fee shape.** The cost of a settlement (gas + proof) is almost constant. 1% of the pot changes with
   the storage demand. Consider gas reimbursement plus a fixed margin, capped by the pot, or a minimum
   fee. Decide with measurements from Sepolia and mainnet.
2. **Races.** If many provers race for the same round, all but one waste their proof. Possible fixes:
   give each round to one prover (in turn, or by the lowest offer) with a takeover after a deadline, or
   let one party buy proofs on a market (Succinct Prover Network, Boundless).
3. **Transactions without a fee.** `anchorRound`, and settlements without a payout. A small fee from
   `accruedPot` can pay for them, or epochs can decrease their number.
4. **Expiry sweeps before settlement.** With PostageStamp (master), a prover must send `expireLimited`
   transactions before `settleRound` when many batches expired, as Bee does before a claim. With
   PostageStampZK this is not necessary: the proof does the expiry.

---

## 5. Measured so far

All numbers are from this machine (Apple Silicon laptop), 2026-10-19. They are small-scale and indicative.

**End-to-end local run** (anvil, 1 s blocks, 5 nodes: node 2 forced, node 3 silent, node 4 liar, mock proofs).
Rounds 4 to 8 were all anchored and settled by the prover with no manual steps:

| Round | Participants | Redundancy | Freezes | `settleRound` gas |
| --- | --- | --- | --- | --- |
| 4 | 5 | 3 | 2 (silent + liar) | 295,665 |
| 5 | 5 | 3 | 0 (both frozen, so ineligible) | 261,329 |
| 6 | 5 | 3 | 0 | 244,241 |
| 7 | 5 | 3 | 0 | 244,217 |
| 8 | 5 | 3 | 1 (silent again, after its freeze expired) | 270,299 |

`anchorRound` costs about 75k gas. The gas above uses `SP1MockVerifier`. A real Groth16 proof of round 4
(below) verified against SP1's v6.1.0 Groth16 verifier deployed on anvil costs **269,345 gas** (estimate
including the 21k transaction base), and the same proof with one byte of public values changed is
rejected. So a real settlement for this round is about 0.5M gas for the whole network. Today's game
costs about three transactions per participating node.

**End-to-end local run with storage proofs** (2026-10-31; anvil, 1 s blocks, mock proofs). node-sim
keeps a shared reserve of 3,000,000 chunks stamped by the deployed batch. It computes the real sample
each round (about 0.5 s) and passes Redistribution's default `sampleMaxValue`. Rounds 4 to 13 settled with
no manual steps:

| Round | What happened | `settleRound` gas |
| --- | --- | --- |
| 4, 5 | The liar (largest stake) won the truth draw with a fake hash. Nobody can prove storage for it, so the round settled unclaimed after block 152: no payout, no freezes | 147,177 / 147,165 |
| 6 | Honest truth. The winner (node 2) posted the three claim proofs with `forceClaim`. Paid; the silent node and the liar were frozen | 308,262 |
| 7, 8 | Same, through `forceClaim` | 256,126 |
| 9, 10, 14 | No commits | 76,671 |
| 11, 12, 13 | Honest truth. The winner (node 3) sent the claim proofs to `POST /v1/claim`; the prover checked them and settled | 260,236 / 242,233 / 242,245 |

zkVM cycles of real rounds: 960,596 for round 4 (unclaimed) and 2,927,494 for round 6 (claim with three
witnesses). The claim checks add about 2M cycles to a round.

**zkVM cycles** (`swarm-prover synth` + `execute`; 80% honest, 10% liars, 10% silent; rounds before the
claim checks were added):

| Participants | Cycles | Native execute |
| --- | --- | --- |
| 5 (round 4 above), without SP1 precompile patches | 11,782,493 | 0.21 s |
| 5 (round 4 above), with keccak + secp256k1 patches | 985,100 | 0.05 s |
| 10 | 2.1 M | 0.07 s |
| 50 | 10.2 M | 0.28 s |
| 200 | 40.6 M | 1.07 s |
| 1000 | 209 M | 5.4 s |

The cost is about 200k cycles for each participant, and it is linear. The commit signature recovery
uses most of the cycles. The precompile patches (`[patch.crates-io]` in `prover/Cargo.toml`) decrease
the cycles by 12×.

The rows for 50, 200 and 1000 participants are stress tests only. A round does not include the full
network. Only the nodes in the neighbourhood of the round anchor play, which is about 10 nodes. Thus a
real round is near the 10-participant row: about 2M cycles.

**Proving time** (round 4, about 1M cycles, `SP1_PROVER=cpu`, laptop):

| Step | Time |
| --- | --- |
| Execute + STARK + recursion | about 4 min 50 s |
| Groth16 circuit artifacts download (one-time, about 3.5 GB) | about 20 min |
| Groth16 wrap (gnark, 16.0M constraints) | about 30 s |
| Peak memory | 10.2 GB |
| Proof size | 356 bytes; verifier selector `0x4388a21c` (v6.1.0) |

A laptop proves a round of this size in a few minutes. This time is inside the settle window (blocks
49-63, about 3 minutes at 12 s blocks). A round has about 10 participants, so the proving time stays
in this range. For a production prover, use the Succinct Prover Network (`SP1_PROVER=network`) or a GPU.
These options give more margin and do not need a 10 GB laptop.

**Contract cost for each participant:** `settleRound` reads `StakeRegistry.stakes` for each participant
(about 13k gas when cold). It also calls `freezeDeposit` one time for each freeze. A round has about 10
participants, so this adds about 130k gas. The stake read does not cause a scale problem.

**End-to-end local run with postage accounting in the proof** (2026-11-02; anvil, 1 s blocks, mock
proofs; PostageStampZK; no fix was necessary). Rounds 4 to 14 settled with no manual steps:

| Rounds | What happened | `settleRound` gas |
| --- | --- | --- |
| 4 | Liar won the truth draw: unclaimed. The proven pot for blocks 63-760 went to `accruedPot` | 272,017 (first postage state write) |
| 5-8 | Liar won again (about 2% chance for five in a row with its 5/11 of the stake; checked: all honest reveals were valid and the seeds differ). Unclaimed; each round added 152 blocks × 24,000 × 2^20 = 3,825,205,248,000 | 175,414-175,426 |
| 9, 10 | No commits; the pot still accrued | 104,943-104,955 |
| 11 | Honest truth (second session without the liar). The winner sent the claim to the prover; paid all of `accruedPot` (rounds 4-11) minus 1%: exactly 42,976,935,936,000 | 297,748 |
| 12, 13 | Same | 285,834 / 268,796 |
| 14 | No commits. The proof replayed the three price changes of rounds 11-13 from the log | 131,149 |

`accruedPot` and the winner balance were checked on chain against the expected values: they are equal to
the unit. The postage accounting adds about 30k gas to a settlement (log checks and state writes).

**Real proof on the Succinct Prover Network** (2026-11-03; synthetic round: 10 participants, a valid claim
with three witnesses, 100 live batches in the postage state):

| Measurement | Result |
| --- | --- |
| Cycles | 8,296,167 |
| Time from request to proof (auction, assignment after about 4 s) | 41.6 s |
| Price | base fee 0.394 PROVE + at most 0.75 PROVE per billion PGU (7.6M PGU): at most about 0.40 PROVE |
| Proof | Groth16, 356 bytes, circuit v6.1.0 (selector `0x4388a21c`) |
| Verification on SP1's v6.1.0 Groth16 verifier (anvil) | Valid, 273,813 gas. One changed byte in the public values: rejected |
| Program verification key | `0x00c999a8608036dd88962aa3340047a4eed518188eacb5fc41f1bab4b302d9ac` |

Thus the network proves a round well inside the settle window (blocks 49-63, about 3 minutes on
Ethereum). The base fee is the main part of the price for a round of this size.

**Settlement with real proofs** (2026-11-03; anvil, 1 s blocks; Settlement deployed with SP1's v6.1.0
Groth16 verifier and the program key, `ZK_VERIFIER=<address>`; prover with `SP1_PROVER=network`; 5 nodes,
node 4 silent):

| Round | What happened | Cycles | Time to proof (from start of proving) | `settleRound` gas |
| --- | --- | --- | --- | --- |
| 4 | Commits and reveals off chain, honest truth, winner sent the claim. The network proved the round; Settlement checked the proof with the real verifier, paid the winner and froze the silent node until block 1101 (797 + 2 × 152) | 2,688,203 | 69.8 s | 625,965 |
| 5 | No commits; the postage accounting still ran | 280,988 | 37.1 s | 360,952 |

The verification of a real proof adds about 270k gas to `settleRound` (compare section 5 runs with the mock
verifier). The time includes the local execution and the program registration; the network assigned each
request within about 5 s.

**Sepolia run** (2026-11-03; 64-block rounds; Settlement with SP1's Groth16 verifier gateway
`0x397A5f7f3dBd538f23DE225B51f532c34448dA9B`; network proofs; 4 simulated nodes, node 3 silent;
`stakeAgeRounds = 0`):

| Contract | Address (Sepolia) |
| --- | --- |
| Settlement | `0xB69BE1e0CF55F50C507E88273a39430dF87Bb6d8` (replaced by `0x8FA253E8dF857c1a2b8A15f7AEcEA9BaBeE1c3d0`, with `anchorReveals`) |
| PostageStampZK | `0x0d394c681D4937Ad0e8610738f4f2758cF29680e` |
| PriceOracleZK | `0x0C47cbCf1498D12C1Ce02525bdCBAAf40b3DA58a` |
| StakeRegistry | `0x6cE96a0e89EA06143b9AfD737928f6e57F95380E` |
| TestToken (sBZZ) | `0x1e96D92aEF6ceA3cE35D1697F6C35877BadD7232` |

Program key `0x001c0e2d6b5d8deec792fc7f16b282798afb4269d6f1eb7e8db58cc10c9b3f56`.

| Round | What happened | Cycles | Time to proof | `settleRound` gas |
| --- | --- | --- | --- | --- |
| 188401 | 4 commits, anchor, 3 reveals; winner (node 1) sent the claim; network proof; the gateway accepted it; paid; node 3 frozen | 2,489,424 | 79.6 s | 1,283,920 (first postage state and freeze writes) |
| 188402 | Same; node 3 still frozen, so not eligible | 2,510,630 | 45.8 s | 768,706 |

Transactions: settlements `0x4f3780e0…6f56` and `0x1cb78d2e…b134`; anchors `0x8c06d6eb…724a` and
`0x4a510f81…b740`.

**Censoring prover** (2026-11-03; anvil, 1 s blocks, mock proofs; 5 honest nodes). The prover ran with
`CENSOR_COMMITS=<node 0>` and `CENSOR_REVEALS=<node 1>`. node-sim checked both anchored lists against
the hashes on chain in every round.

| Round | Commit anchor | Reveal anchor | Node actions | Settlement |
| --- | --- | --- | --- | --- |
| 10 | 4 commits, node 0 left out | 4 reveals, node 1 left out | Node 0: `forceCommit` at block 20-22, reveal to the prover. Node 1: `forceReveal` at block 44-46 | 5 participants, redundancy 5, 0 freezes, 395,238 gas |
| 11 | The same | The same | The same | 5 participants, redundancy 5, 0 freezes, 304,201 gas |
| 12 | The same | The same | The same | 5 participants, redundancy 5, 0 freezes, 304,239 gas |

The first try found a bug. The prover accepted off-chain reveals only for anchored commits, so it refused
the reveal of a node with a forced commit. node-sim then did not force the reveal, and the node was
frozen. Now the prover also accepts reveals for forced commits. node-sim forces a reveal also when its
off-chain reveal failed.

**Prover restart** (2026-11-03; the same chain; node 2 forced, node 3 silent, node 4 liar). A second
prover started with an empty data folder. It anchored rounds 14-16, but it could not settle them: it did
not have the postage state of the last settlement (open item 3). It also marked the rounds as failed for
good. Now an error while it builds the round input is only logged, and the prover tries again. With the
postage state file copied into its folder, the restarted prover settled rounds 14, 15 and 16 in order
with no other help. Rounds 14 and 15 settled as unclaimed: the winner could not get the outcome while the
prover failed.

**Sepolia run with censorship** (2026-11-03/04; Settlement `0x8FA253E8dF857c1a2b8A15f7AEcEA9BaBeE1c3d0`
with `anchorReveals`, SP1's verifier gateway, program key `0x007503aa…a6b1`; network proofs; the same
PostageStampZK, PriceOracleZK, StakeRegistry and sBZZ as the first Sepolia run; 4 nodes). The prover
censored node 0's commits and node 1's reveals. From round 188413, nodes 2 and 3 used only the escape
hatches (`--forced 2,3`).

| Round | What happened | Cycles | Proof | `settleRound` gas |
| --- | --- | --- | --- | --- |
| 188411 | Node 0: `forceCommit`. A prover bug (below) refused all off-chain reveals; all 4 nodes called `forceReveal` in the same block, but 3 of the 4 transactions ran out of gas (below). Result: redundancy 1, 3 nodes frozen | 2,379,610 | 73 s | 1,223,223 |
| 188412 | Node 0: `forceCommit`; node 1: `forceReveal`. Nodes 1-3 still frozen, so only node 0 counted | 2,381,342 | 39 s | 676,813 |
| 188413 | The same escape hatches, plus nodes 2 and 3; all 6 forced transactions confirmed. Nodes 1-3 still frozen | 2,174,258 | 35 s | 676,765 |
| 188414 | Node 0: `forceCommit`; node 1: `forceReveal`; nodes 2 and 3: `forceCommit` and `forceReveal`. All 6 confirmed. **4 participants, redundancy 4, 0 freezes** | 2,785,744 | 42 s | 872,999 |
| 188415 | No commits (node-sim stopped); postage only | 285,203 | 26 s | 487,457 |

Gas on Sepolia: `anchorRound` 355,077; `anchorReveals` 246,126; `forceCommit` and `forceReveal` about
241k for the first one of a round and about 46k for each later one (the first writes new storage
slots). These values are 3-4 times the anvil values.

Two bugs that only Sepolia showed, both fixed:

1. To accept a reveal for a forced commit, the prover read `CommitForced` logs up to block 48 of the
   round. During the reveal phase that block is in the future, and the Sepolia RPC refuses such a range.
   Anvil does not. Now the range ends at the current block.
2. node-sim let the RPC estimate the gas of `forceReveal`. The estimate runs against the pending state.
   There, node 0's transaction had already written the round's forced-reveal slots, so the estimate for
   nodes 1-3 was about 48k. The block builder put node 0's transaction last. Thus nodes 1-3 ran first,
   against empty slots, and ran out of gas. node-sim did not check the receipts and believed the reveals
   were on chain. Now node-sim sends forced transactions with a fixed gas limit (600k; `forceClaim`
   1.5M), checks each receipt, and sends a failed one again while its window is open. A Bee node must
   do the same.

**Sepolia run with the ring and the batch tree** (2026-11-04; Settlement
`0x02CF166cADfFE7F320a50542659383Eb68965158`, program key
`0x004b0af7ce9487951a8b57ecc1179044299afa862a853e4b348c12eb481b209e`; the same PostageStampZK,
PriceOracleZK, StakeRegistry and sBZZ; 16 ring entries warmed at deployment, 10,609,814 gas, about 663k
for each entry; network proofs). The same scenario as the run before: the prover censored node 0's
commits and node 1's reveals, and nodes 2 and 3 used only the escape hatches.

| Round | Result | Cycles | Proof | `settleRound` gas |
| --- | --- | --- | --- | --- |
| 188421 | 4 participants, redundancy 4, 0 freezes; all 6 forced transactions confirmed | 1,098,221 | 63 s | 1,177,573 (first settlement of this Settlement: new storage) |
| 188422 | The same | 661,428 | 50 s | 676,474 |

| Gas on Sepolia | Before (new storage each round) | With the ring (warmed entries) |
| --- | --- | --- |
| `anchorRound` | 355,077 | **49,256** |
| `anchorReveals` | 246,126 | **48,647** |
| First `forceCommit` of a round | 241,360 | **46,038** |
| First `forceReveal` of a round | 243,306 | **47,923** |
| Cycles of a 4-node round with a claim | 2.4M-2.8M | 0.66M-1.10M |

The two anchors together now cost about 98k gas for each round instead of about 601k. Without
`warmRing`, the first use of each of the 256 entries still pays the new-slot cost once.

**Source verification.** `scripts/zk/verify-etherscan.ts` submits the source to Etherscan (v2 API) and,
with `SOURCIFY=1`, to Sourcify. Settlement `0x02CF…5158`, PostageStampZK and PriceOracleZK are verified on
Sourcify with an exact match of the creation and runtime bytecode. Etherscan accepted the same input,
but its queue did not process it for hours ("Pending in queue"); StakeRegistry and TestToken show as
verified on Etherscan.

**Sepolia run after the review fixes** (2026-11-05; the contracts above; network proofs; 4 nodes; stake
age 0; 16 ring entries warmed). The prover ran in test mode as an attacker: it censored node 0's commits
and node 1's reveals, and threw away every claim witness (`WITHHOLD_CLAIMS`). Node 3 used only the escape
hatches.

| Round | What happened | Cycles | Proof | `settleRound` gas |
| --- | --- | --- | --- | --- |
| 188528 | Node 0 found its commit missing (inclusion proof) and forced it; node 1 forced its reveal; node 3 forced both. The prover withheld the claim; at block 58 node 0 called `forceClaim` (backstop). **4 participants, redundancy 4, 0 freezes, winner paid** | 1,146,773 | 46 s | 1,966,450 (first settlement of this deployment: new storage) |
| 188529 | The same attacks, the same defences. **4 participants, redundancy 4, 0 freezes, winner paid** | 733,603 | 42 s | 507,201 |
| 188530 | No game (node-sim stopped); postage only | 199,594 | 39 s | 452,286 |

Gas on Sepolia in this run: `anchorRound` 49,211; `anchorReveals` 48,648; `forceCommit` and
`forceReveal` about 73k-75k (about 171k the first time an address uses one: its once-per-round slot is
new); `forceClaim` with a 4 KB witness 281,496.

**Sepolia run of the liveness fallback** (2026-11-05; the same contracts; network proofs). The prover ran
with `NO_ANCHOR` (it never anchors, like a prover that stopped) and with an empty data folder.

| Round | What happened | Cycles | Proof | `settleRound` gas |
| --- | --- | --- | --- | --- |
| 188614 | Nobody anchored in blocks 16-19. At block 21, node 0 called `anchorEmpty` (131,658 gas; the ring entry was not warmed). All 4 nodes forced their commits and reveals. The prover rebuilt the postage state from the chain (empty data folder), found the empty-anchored round and settled it from on-chain data: **4 participants, redundancy 4, 0 freezes, winner paid** | 613,962 | 91 s | 1,288,553 (see below) |

**Why round 188614 cost 1,288,553 gas and round 188529 only 507,201** (analysed 2026-11-05). Both have
the same calldata (2,180 bytes). The differences:

1. **The no-skip check scanned the gap.** 84 rounds without an anchor lay between the last settlement
   (188530) and 188614. The check of fix 2 read every round in between: on Sepolia, about 7k gas for the
   EIP-2935 block hash call and about 4k for the cold read of the ring entry, so about 8k-11k gas for
   each round, about 650k-800k in total. **Fixed:** each anchored round stores the previous anchored
   round (`prevAnchored`), and `settleRound` checks only that one round (O(1)).
2. **The price changed in 188614, but not in 188529.** In 188614 the oracle caught up 84 skipped rounds
   (the maximum increase for each, master's rule): 24,000 to 25,713, plus the price writes and a new
   postage log entry. In 188529 the price change was lost: the oracle counted rounds by the block of the
   `adjustPrice` call, and the settlement of 188528 had landed in 188529's blocks (the block-58 backstop
   plus a 45 s proof), so 188529 found its oracle round "already adjusted". **Fixed:**
   `adjustPriceForRound(round, redundancy)` uses the game round (the oracle's rounds are also 64 blocks).
   Regression test: "adjusts the price for each game round, also when a settlement lands in the next
   round".

**Sepolia run after the gas fixes** (2026-11-05; Settlement `0x9dC237bEeB7fa2E5EBBa0F68e0BD4DEe963Cc448`,
PriceOracleZK `0x1Ff1C2FFdb2f584132211FF341B5B49e0aEcFAe8`; network proofs). The prover ran in attacker
mode (`CENSOR_COMMITS`, `CENSOR_REVEALS`, `WITHHOLD_CLAIMS`), with 4 simulated nodes.

| Round | What happened | Cycles | Proof | `settleRound` gas |
| --- | --- | --- | --- | --- |
| 188622 | The prover left out 2 commits and 2 reveals; the nodes forced them. The prover withheld the claim; at block 58 node 0 called `forceClaim`. **4 participants, redundancy 3, 1 freeze, winner paid, price changed** | 1,153,060 | 35 s | 1,094,134 (first settlement of this deployment: new storage) |
| 188623 | The same attacks, the same defences. **Winner paid, price changed** | 737,736 | 43 s | 693,270 |
| 188624 | The same. **Winner paid, price changed** | 738,138 | 95 s | 693,270 |
| 188625 | The same. **Winner paid, price changed** | 737,061 | 87 s | 791,140 |
| 188626 | No game (node-sim stopped); postage only. No truth, so no price change (as on master) | 204,533 | 56 s | 475,947 |

Each of the 4 rounds with truth emitted `PriceUpdate` from the oracle and no `PriceAdjustmentSkipped`.
After the run, the oracle's `lastAdjustedRound` was 188625. In the previous run, the price change of
round 188529 was lost (see above): fix 2 of the gas analysis works on Sepolia.

### Robustness tests (2026-11-06)

**Shadow mode (phase 2).** `gnosis-shadow` replays real Gnosis Chain rounds of Redistribution
`0x5069cdfB3D9E56d23B1cAeE83CE6109A7E4fd62d` through the VM and compares the outcome with the
`TruthSelected`, `WinnerSelected` and `StakeFrozen` events of the claim transaction:

- The commits (`Committed` events and the `commit` calldata, in chain order) and the reveals become forced
  commits and forced reveals. The stake of each node is the effective stake from the `Revealed` event.
- Redistribution's randomness replaces the VM's: the `CurrentRevealAnchor` anchor, the seed after the
  first reveal (`keccak256(abi.encode(seed, prevrandao))`, with `prevrandao` from the block header), and
  `prevrandao % 100` of the claim block. The replay checks the seed chain itself: the anchor of each round
  must follow from the seed after the round before.
- The overrides are in `swarm_vm::shadow`. They are not compiled for the zkVM (`target_os = "zkvm"`), so
  the program key does not change (checked after a rebuild).

Result (2026-11-06, Gnosis rounds 320284-323283, about 5.3 days): **2,880 of 2,880 rounds equal, 0
differ.** They include 46 rounds where a node did not reveal, 18 rounds where a node revealed another
hash or depth, 63 rounds with freezes (86 freezes), and rounds at winner depth 9 and 10, so the minimum
depth rule is checked too. 110 rounds had reveals but no claim on Gnosis, so there was nothing to
compare. The first round is skipped: its seed before the first reveal is unknown.

A negative control (`--wrong-seed`) gives the VM a wrong seed: then 13 of 28 rounds differ. Not
replayed: the claim's storage proofs (the replay takes the claim result from Gnosis), and the freeze
lottery (Gnosis has `penaltyRandomFactor` 100, so a disagreeing node is always frozen).

**Two provers at the same time** (anvil, mock proofs). Two provers with `ANCHOR_ROLE` get the same node
messages through a fan-out proxy. After 3 rounds, prover B is killed right after it anchors a round.

| | Before the fix | After the fix (`9793ef3`) |
| --- | --- | --- |
| Round that B anchored, then B stopped | Prover A: "this prover will not settle it". It cannot build the input, and the no-skip rule stops every later round. 2 of 8 rounds settled | Prover A takes B's anchored list (its own messages match the on-chain hash), anchors the reveals itself and settles. 8 of 8 rounds settled |
| Nodes in that round | A has no anchored list, so it cannot give inclusion proofs. Every node forces its commit and reveal | No forced commits or reveals |
| Lost `anchorRound` race | Logged as "anchored" (the receipt status was not checked) | Logged as a revert; the prover takes the winner's list |

On Ethereum the stall before the fix lasts 8191 blocks (about 27 hours). When the prover's own messages
do not match the anchored list, it downloads the `dataRef` document from Swarm (when the data layer is
on) and checks it against the hash.

**Escape hatches under full blocks** (anvil, fee-ordered transaction pool, block gas limit 1.6M). The
prover censors node 0's commit and node 1's reveal. A spammer fills the blocks with 50 gwei-tip
transfers, from the block after the node sends its forced transaction until the window ends (round
blocks 21-23 and 45-47).

| | node-sim before | node-sim after |
| --- | --- | --- |
| Fees of a forced transaction | alloy's estimate (no tip in a quiet block) | Tip: twice the highest of the estimate and the 90th percentile tip of the last 4 blocks (at least 1 gwei); max fee: 4 base fees plus the tip |
| Not mined after a block | Waits | Replaced (same nonce, fees +30% or more) |
| Result, 4 rounds | Every forced transaction was mined after its window and reverted. Node 1 was frozen in 3 rounds as a node that did not reveal | Every forced transaction landed in its window (a replacement with a 100 gwei tip). No freezes |

When the spam already runs before the node sends, the old node-sim also gets in: alloy's estimate follows
the tips of recent blocks. The failure needs a transaction that was sent into a quiet block.

**The edges of the rings** (`test/Settlement.test.ts`, "round ring"):

- A pending round blocks later rounds in the last block where its seed hash can still be read, and no
  longer in the next block (8191 blocks with EIP-2935; 256 on Hardhat, which has no EIP-2935 contract).
- With the ring of 8,192 log entries, a round whose cut entry left the ring could not settle, and it
  blocked later rounds (open item 12). Fixed: a round settles after 8,195 later log entries.

**A price update lost to a gas estimate** (found while testing the cut, 2026-11-06). PriceOracleZK calls
`PostageStampZK.setPrice` with a low-level call and ignores a failure, and `settleRound` catches a failed
`adjustPriceForRound`. A gas estimate only checks that the outer transaction does not revert, so it could
choose a limit at which the inner call ran out of gas: the transaction succeeded, and the price change
was lost (the deploy script hit this when the first cut write made `setPrice` cost more). The prover sets
the `settleRound` gas with an estimate, so a settlement could lose its price change in the same way.
Fixed: when the inner call failed and at most 1/64 of the gas is left (an out-of-gas), the outer call
reverts with `OutOfGas`, so an estimate always gives enough gas. Test: "a gas limit too low for the stamp
price update reverts, and does not lose the update" (it fails without the check).

**Long run on Sepolia** with faults (2026-11-06, 12:04-23:05 UTC; the contracts of "Sepolia run after
the gas fixes"; network proofs; rounds 188695-188743). Every 25-40 minutes a script did one fault, in
turn: a prover restart, an RPC outage of 3 minutes (a proxy answers 503), a pause of the prover for 4
minutes (a late proof), a restart with an empty data folder, and a pause of 15 minutes (a round without
a prover). Each fault came 3 times.

**Result: 8 rounds settled (188695-188703), then no more.** The restart, the RPC outage and the late
proof did no harm. The first restart with an empty data folder (14:20 UTC) stopped all settlement:

1. Round 188704 was anchored (commits and reveals) by the prover before the restart. The new prover
   had no messages for it, and the Swarm uploads were off, so it could not get the anchored lists. The
   round cannot settle, and the no-skip rule makes Settlement reject every later round
   (`RoundPending(188704)`) until the seed block hash of round 188704 is gone: 8191 blocks, about 27
   hours.
2. The prover did not see this before it proved. It proved round 188705 29 times, about 0.42 PROVE
   each time, and each `settleRound` reverted. Then the PROVE balance of the requester key was too low
   for a proof (0.2465 PROVE), and no more proofs were made.
3. In 5 rounds (188702, 188708, 188722, 188724, 188739) the prover did not answer in the commit phase.
   node-sim retried the commit to the prover, then gave up: it did not call `anchorEmpty` and
   `forceCommit`. These rounds have no anchor, so they are skipped. The rule "no answer means force"
   (section 3) holds for the commit checks and the claim, but not for a commit that the prover never
   took.

The nodes kept to the rules: `forceClaim` as a backstop in 37 rounds, and forced reveals in 4 rounds. In
17 rounds node-sim's reserve was too small for the size estimate (`ReserveCheckFailed`), so those rounds
can only settle unclaimed; this is a node-sim setting (`--reserve`), not a fault. Fixes (2026-11-08):

- **The prover checks before it pays for a proof.** It simulates `settleRound` with an empty proof
  (`eth_call`, free). If Settlement rejects the round (`RoundPending`, `InputMismatch` and the other
  errors before the verifier), the prover does not prove; for `RoundPending` it tries to take the
  anchored lists of the pending round, and waits. It also reuses a stored proof of the same public
  values. `swarm-prover balance` shows the PROVE balance of the requester key.
- **node-sim forces a commit that the prover did not take.** It keeps the commit, and the commit check
  calls `anchorEmpty` (if no prover anchored the round) and `forceCommit`. The reveal check already
  forced every reveal that is not in the anchored list.

Local test of both faults (anvil, mock proofs; `scratchpad` script `wipe/run.sh`): the prover was killed
right after it anchored the reveals of round 10, and started again with an empty data folder. Round 10
could not settle. The prover did not prove round 11 while round 10 blocked it, and it settled rounds 11-15
as soon as the seed of round 10 was gone (256 blocks on anvil, which has no EIP-2935 contract). Then the
prover was paused for 20 blocks from the start of round 15. The nodes called `anchorEmpty`,
`forceCommit` and `forceReveal`, and round 15 settled. All rounds 8-20 except round 10 settled.

Still open: a prover must be able to get an anchored list back after a data loss (the Swarm uploads, or
the nodes send their messages again), and one round that cannot settle still stops all settlement for
27 hours on Ethereum (open item 14).

**Gas on Sepolia is higher than on anvil.** Sepolia runs a newer Ethereum version (Geth 1.17). The same
`createBatch` costs 633,420 gas on Sepolia and 177,236 on anvil. The gas values measured on anvil and
Hardhat in this section are therefore too low for current Ethereum rules. Use the Sepolia values for cost
estimates, and repeat the PostageStamp and PostageStampZK comparison on Sepolia.

**PostageStampZK** (2026-11-02, Hardhat):

| Measurement | Result |
| --- | --- |
| `createBatch` with 50 batches already present: PostageStamp (master) | 443,169 gas |
| The same with PostageStampZK | 176,950 gas (60% less) |
| Pot and `validChunkCount` of the replay against master, 3 random histories, 18 checkpoints | Equal at every checkpoint |

On master the cost of `createBatch` also increases with the size of the tree and with the number of
batches that expired since the last sweep. On PostageStampZK it does not.

**zkVM cycles with postage accounting** (`synth --nodes 10 --batches N`, `execute`, no proof):

| Live batches in the postage state | Cycles: batch list (before 2026-11-04) | Cycles: batch tree and keccak precompile |
| --- | --- | --- |
| 1 | 3.71M | 1.10M |
| 1,000 | 49.6M | 1.10M |
| 10,000 | 463M | 1.10M |

With the batch list, each live batch cost about 46k cycles in each settlement. With the batch tree, the
number of live batches does not change the cost. See "Merkle postage state" below.

**Real Gnosis postage history** (2026-11-03; `prover/service/src/bin/gnosis_postage.rs`). The tool reads
all batch and price events of the Gnosis PostageStamp `0x45a1502382541Cd610CC9068e88727426b696293`
from its deployment (block 31,305,656) to block 49,095,608. It converts them to the PostageLog entries
that PostageStampZK writes, and replays them with one settlement every 152 blocks (one Gnosis round).

| Item | Value |
| --- | --- |
| Events | 226,254: 47,364 create, 66,350 top-up, 915 depth, 111,625 price |
| Settlements replayed natively | 117,034, in 2.9 s, with no error |
| Live batches (most at any cut; now) | 8,013; 8,011 after the last cut |
| Total outpayment at the last cut | 923,867,393,222: the same as `currentTotalOutPayment()` on Gnosis |
| `validChunkCount` after the last cut | 7,991,984,128. Gnosis: 7,993,032,704. The difference is one depth-20 batch that has expired; Gnosis still counts it because nobody called `expireLimited` yet (`expiredBatchesExist()` is true) |
| Pot of the last settlement (152 blocks) | 24.09 BZZ = 7.99e9 chunks × price 198,291 × 152 blocks |
| Cycles of one settlement (8,013 live batches, 12 new events, no game) | **368,829,867** (6.1 s to execute on a laptop) |
| Groth16 proof on the Succinct Prover Network | 356 bytes in **127 s** (request to proof). Gas limit 324,913,729 PGU; base fee 0.395 PROVE + at most 0.75 PROVE per billion PGU: **at most about 0.64 PROVE** |

Thus at today's Gnosis size, the postage part alone is about 150 times the cycles of the game. The cost
does not depend on the number of events in the round. It comes from the state: the proof reads and
hashes all 8,013 batches, and each batch costs about 46k cycles.

The proof still fits in a round: 127 s, against a round of 768 s. The price is mostly the fixed base
fee: at most 0.64 PROVE, against about 0.40 PROVE for a small round. Thus today's state does not block
mainnet. But the time and the variable price grow with the number of live batches: at 10 times today's
batches, a proof takes many minutes. The Merkle postage state (optimization plan, item 9) touches only
the batches that change or expire: 14 in this round. Then the cost stays near the cost of a small round.
Item 9 is the first optimization to do.

**Merkle postage state and the keccak precompile** (2026-11-04). The batch tree replaced the list of
all live batches (section 2, "The batch tree"). Checks:

- The comparison with master's PostageStamp (3 random histories, 18 checkpoints) gives the same pot
  and `validChunkCount` at every checkpoint. Each settlement also runs in zkVM mode from the recorded
  witness and gives the same result.
- The full Gnosis history, replayed on the batch tree (117,034 settlements, 18 s natively), gives the
  same results as the batch list: the same total pot over all settlements
  (19,292,378,374,310,260,506,624), the same pot of the last settlement (240,916,066,438,479,872) and
  the same `validChunkCount` (7,991,984,128).
- Tests for a dishonest prover: a prover that says "not found" for a batch that exists cannot finish
  its own run, and the zkVM rejects the witness it recorded (`BadHint`). A changed leaf, a wrong
  sibling, or an extra proof are rejected.

While measuring, a second problem showed up. `alloy-primitives` computes keccak256 with the `sha3` crate
unless its `tiny-keccak` feature is on. SP1's keccak patch replaces `tiny-keccak`, so the program did not
use SP1's keccak precompile at all. The workspace now enables the feature. This makes all hashing in the
program cheaper: the game, the claim's BMT proofs and the tree.

| One settlement with the real Gnosis state (8,013 live batches, 12 events, no game) | Cycles |
| --- | --- |
| Batch list (all batches read and hashed) | 368,829,867 |
| Batch tree, keccak in software | 63,153,627 |
| Batch tree, keccak precompile | **5,870,816** |
| Witness of that settlement | 66 leaf proofs and 37 hints (179 KB of JSON input) |

| The same settlement on the Succinct Prover Network | Batch list (2026-11-03) | Batch tree (2026-11-04) |
| --- | --- | --- |
| Gas limit (PGU) | 324,913,729 | 10,474,500 |
| Request to Groth16 proof | 127 s | 52 s |
| Price, at most (base fee + 0.75 PROVE per billion PGU) | 0.64 PROVE | 0.41 PROVE |

| Synthetic round (`synth`) | Cycles before | Cycles now |
| --- | --- | --- |
| 10 nodes, any number of batches | 3.71M (1 batch) to 463M (10,000 batches) | 1.10M |
| 50 nodes | not measured | 3.47M |

**Round ring** (2026-11-04; Hardhat gas rules; `test/Settlement.test.ts`, "round ring"):

| Transaction | New ring entry | Reused (or warmed) entry |
| --- | --- | --- |
| `anchorRound` | 75,023 | 40,823 |
| `anchorReveals` | 57,051 | 39,951 |

On Sepolia a new-slot write costs about 110k gas instead of 20k, so the saving there is larger (see
"Sepolia run with the ring and the batch tree" below).

**Data layer, local test** (2026-11-04; anvil, mock proofs, a stand-in for the Bee API that keeps uploads
in memory; the prover censored node 0's commits, node 2 used the escape hatches):

| Step | What happened | Result |
| --- | --- | --- |
| Rounds 9-10, uploads on, `SNAPSHOT_EVERY=1` | Each round: commit list and reveal list uploaded, their references in `dataRef`; a postage snapshot after each settlement. Nodes checked their entries with Merkle proofs; node 0 found its commit missing and forced it | Both rounds settled; 5 participants, 0 freezes |
| Prover restarted with a postage file it could not read (older format), and an old snapshot | Replay from the chain: `PostageSettled` and `PostageLog` events | State rebuilt, equal to `postageStateHash`; round 11 settled |
| Prover restarted with no postage files, Swarm on | The newest snapshot, found through the `dataRef` document of the last `anchorRound` | State rebuilt; round 12 settled |
| Prover restarted with no postage files, Swarm off | Replay from the chain | State rebuilt; round 13 settled |

The Gnosis postage state as a snapshot: 3,397,514 bytes of JSON (47,365 leaf slots, of which 8,014 are
in use; empty leaves are not stored).

**Soundness tests** (2026-11-03). Three test groups check that a prover cannot select the result:

1. `every_private_input_is_bound_to_a_public_input` (`prover/crates/vm/src/tests.rs`). It changes each
   private input of the VM: commits, signatures, anchored and forced reveals, forced commits, stake
   records, game parameters, seed, anchor, postage state, postage log, cut block, forced claims (27
   changes). Each change must make the VM fail, or change a public input that `settleRound` checks
   against the chain, or leave the outcome as it was. A check of the test: without `revealsHash` in the
   public inputs, the test fails ("drop an anchored reveal"). The one documented exception is the
   off-chain claim witness: without it, the round is unclaimed with the same public inputs. The defence
   is `forceClaim` (section 3).
2. `test/SP1Verifier.test.ts`. A real Groth16 proof of Sepolia round 188411
   (`test/fixtures/sp1-settlement-proof.json`) and SP1's v6.1.0 verifier (vendored in
   `src/settlement/sp1`). The proof passes as it is (267,701 gas, hardhat estimate). It fails after a
   change to the winner, the truth, the unclaimed flag, the redundancy, the pot, the freezes, the round,
   the commit or reveal list, the stake digest, the postage log position, the chain id, the program key,
   or any proof byte (16 tests).
3. `test/Settlement.test.ts`. Each public input that does not match the chain reverts with its
   `InputMismatch` code (0-13).

Note for tests: Hardhat's `eth_call` returns `0x` when the verifier reverts without data, for example
for a too short proof. In a transaction the same call reverts. Thus the verifier tests use
`estimateGas`.

---

## 6. Sepolia runbook

Prerequisites: Sepolia ETH on a deployer key, a Sepolia RPC, the toolchain from prover/README.md, and
for real proofs either a Succinct Prover Network key (`NETWORK_PRIVATE_KEY`) or a machine that can
prove Groth16 on its CPU.

```bash
# 1. Build the prover and get the program key
cd prover && cargo build --release && ./target/release/swarm-prover vkey   # -> 0x00...

# 2. Deploy (repo root). WALLET_SECRET = deployer key, PRIVATE_RPC_TESTNET = Sepolia RPC
#    Real proofs: verifier = SP1 Groth16 gateway 0x397A5f7f3dBd538f23DE225B51f532c34448dA9B
STAKE_AGE_ROUNDS=0 PROGRAM_VKEY=0x00... PROVER_ADDRESS=<prover key address> npx hardhat deploy --network sepoliazk
#    WARM_RING=16 also fills the next 16 round-ring entries (about 0.7M gas each on Sepolia).
#    Or a smoke test without proving: ZK_VERIFIER=mock npx hardhat deploy --network sepoliazk

# 3. Stake the simulated nodes (needs the deployer to hold ETH for them; NODE_ETH per node, default 0.02)
NODE_KEYS=0x..,0x..,0x.. npx hardhat run scripts/zk/setup-nodes.ts --network sepoliazk
#    With STAKE_AGE_ROUNDS=0 at deploy, nodes play from the next round (~13 min). Default (2): ~26 min.

# 4. Prover. POSTAGE_FROM_BLOCK = deployment block of PostageStampZK (deployments/sepoliazk/PostageStamp.json)
cd prover
export RPC_URL=<sepolia rpc> SETTLEMENT_ADDRESS=$(jq -r .address ../deployments/sepoliazk/Settlement.json)
SP1_PROVER=network NETWORK_PRIVATE_KEY=0x.. PROVER_PRIVATE_KEY=0x.. DATA_DIR=data/sepolia \
  POSTAGE_FROM_BLOCK=$(jq -r .receipt.blockNumber ../deployments/sepoliazk/PostageStamp.json) \
  ./target/release/swarm-prover serve
#    Or prove on a rented GPU with SP1_PROVER=cuda: prover/README.md, "Run the prover on a rented GPU".

# 5. Nodes. BATCH_OWNER_KEY = the deployer key (it owns the batch that stamps the simulated reserve)
NODE_KEYS=0x..,0x.. BATCH_OWNER_KEY=0x.. ./target/release/node-sim --depth 0 --silent 3 --liar 4 --forced 2
#    Censorship test: start the prover with CENSOR_COMMITS=<address> and/or CENSOR_REVEALS=<address>.
#    Swarm data layer: a Bee node and a mutable batch (ZK-PROVER-OPERATIONS.md, section 7), then add
#    SWARM_API=http://localhost:1633 SWARM_BATCH_ID=<id> to the prover.

# After a change to the zkVM program: give Settlement the new program key (admin, one transaction).
PROGRAM_VKEY=0x00... npx hardhat run scripts/zk/set-verifier.ts --network sepoliazk

# 6. Verify the source code (repo root). Uses the compiler input that hardhat-deploy stored at deployment.
#    Etherscan (v2 API), TESTNET_ETHERSCAN_KEY = Etherscan API key:
npx hardhat run scripts/zk/verify-etherscan.ts --network sepoliazk
#    Sourcify (no key):
SOURCIFY=1 npx hardhat run scripts/zk/verify-etherscan.ts --network sepoliazk
#    Only some contracts: CONTRACTS=Settlement,PostageStamp npx hardhat run ...
```

On Sepolia the selection seed is available for 8191 blocks (about 27 hours) through EIP-2935, so a slow
prover still settles.

---

## 7. Migration phases, and where this branch is

Phases are from [ZK-REDISTRIBUTION.md §11](./ZK-REDISTRIBUTION.md).

| Phase | | State |
| --- | --- | --- |
| 1 | Deterministic VM, no EVM dependency | **Done** for master's rules (`crates/vm`) |
| 2 | Shadow mode: VM against live Gnosis rounds | **Done** for the game (`gnosis-shadow`, section 5): truth, winner and freezes equal in every replayed round. The claim's storage proofs are not replayed |
| 3 | Prove the game logic | **Done** (SP1 program, Settlement, Sepolia setup) |
| 4 | Prove the storage witnesses | **Done** (`claim.rs`, `forceClaim`, differential vectors) |
| 4b | Postage accounting in the proof | **Done** (`PostageStampZK`, `postage.rs`, differential vectors, Gnosis replay). Run end to end on Sepolia since 2026-11-04 (section 5) |
| 5 | Canonical settlement, retire on-chain phases | This branch's deployment shape |
| 6 | Recursive aggregation | Not started |

The plan to decrease mainnet gas further (storage proofs for stakes, epochs, oracle change, payouts that
winners collect, a smaller anchor, a Merkle postage state) is in
[ZK-SETTLEMENT-OPTIMIZATION.md](./ZK-SETTLEMENT-OPTIMIZATION.md).

### Open items (in priority order)

1. ~~A Merkle postage state~~ **Done** (2026-11-04): one Gnosis settlement 369M → 5.9M cycles.
2. ~~Swarm as the data layer~~ **Built** (2026-11-04): lists and snapshots to Swarm, rebuild of the
   postage state from the chain. To do: buy the batch and turn the uploads on
   ([ZK-PROVER-OPERATIONS.md](./ZK-PROVER-OPERATIONS.md), section 7).
3. Gas on Sepolia: `settleRound` is measured (section 5, "Sepolia run after the gas fixes"). On Sepolia,
   a write to a new storage slot costs about 100k gas more than a write to a used slot. Two places in
   `settleRound` pay for this (analysed 2026-11-06 with Blockscout call traces):
   - The pot went PostageStampZK → Settlement → winner and fee recipient. The sBZZ balance of Settlement
     went from 0 to the pot and back to 0 in each settlement, so the transfer to Settlement cost
     127,235 gas; the two other transfers cost 15,315 each. **Fixed** (2026-11-06): PostageStampZK pays
     the winner and the fee recipient directly, with two `withdraw` calls (about 110k gas less in each
     settlement with a payout).
   - `setPrice` adds a postage log entry. Each entry wrote a new `eventHashRing` slot until the ring
     wrapped (8192 entries), and one entry in four a new `eventBlockRing` slot (4 `uint64` values in a
     slot). This is why round 188625 cost 97,870 gas more than round 188624. **Fixed** (2026-11-06): the
     rings are replaced by one cut per round (section 2, "The cut of a round").
   To do: PostageStamp against PostageStampZK on Sepolia.
4. ~~Timelock on `setVerifier`~~ **Done** (`proposeVerifier` / `applyVerifier`, delay fixed at
   deployment). To do: the admin as a multisig, and a mainnet value for `VERIFIER_DELAY`.
5. Fee model for provers (section 4).
6. Batch migration from Gnosis PostageStamp to PostageStampZK (`copyBatchBulk`), and a check with the Bee
   team that no Bee version reads `pot` or `validChunkCount`.
7. Forced-inclusion scoping across several rounds (§7.1c of the proposal).
8. Bee integration: the commit, reveal and claim messages, the HTTP API (or Swarm feeds), and when to
   fall back to `forceCommit`/`forceReveal`/`forceClaim`.
9. Nodes don't know the minimum depth for round N+1 until round N is settled. Settling within the round
   (blocks 49-63) avoids that, but needs fast proving. If the settlement is late, an honest node can
   commit below the minimum depth, and its reveal then counts as no reveal (a freeze). A fix: take the
   minimum depth for round N from the game state after round N-2 (Settlement keeps the last two states).
10. The check windows are 4 blocks (48 s). A node must send escape-hatch transactions with a high
    priority fee, replace a transaction that is not mined after a block (same nonce, higher fees), and
    check the receipt. node-sim does all three since 2026-11-06 (section 5, "Escape hatches under full
    blocks"). Bee must do the same. An attacker who raises its own tip in each block can still keep a
    node out, but it pays for full blocks at a rising price; a node must be ready to pay up to the
    value of its freeze.
11. The fee model: at today's prices the costs of a prover (gas, proofs) are higher than the 1% fee
    (ZK-PROVER-OPERATIONS.md, section 4). Without a better fee, only a paid operator runs a prover.
12. ~~A round whose postage cut entry left the postage log ring could never settle~~ **Fixed**
    (2026-11-06): PostageStampZK keeps the cut of each round (section 2, "The cut of a round"). Tests:
    "settles a round whose cut is more than 8192 postage log entries old" and "rounds with no postage log
    entry between their seed blocks share a cut" in `test/Settlement.test.ts`. Not yet on Sepolia: it
    needs a new PostageStampZK.
13. Two provers race for `anchorRound` and `settleRound`. The loser of `anchorRound` pays for a
    reverted transaction (30,067 gas on anvil). The loser of `settleRound` pays nothing on chain (the gas
    estimate fails), but it has already paid for its proof. A turn order (for example by round number)
    removes the waste.
14. One anchored round that cannot settle (its lists are lost) blocks all later rounds until its seed
    block hash is gone: 8191 blocks, about 27 hours (long Sepolia run, section 5). Options: the Swarm
    uploads, so that any prover can get the lists; nodes that send their messages again; or a shorter
    skip time for an anchored round, for example 4 rounds. A shorter skip time gives back part of the
    prover's power to skip a round (section 3, "The prover's power over the payouts"), so it needs a
    decision.
