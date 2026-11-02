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

Not yet done on this version: an end-to-end run with node-sim, and a real (non-mock) proof. Section 5 has
the measurements of the earlier versions.

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
                         swarm-prover (service)                    │ settleRound(pv, proof)     (1 tx/round)
                         ├─ store messages ───────────────────────┘
                         ├─ read chain: anchor, seed, forced events, stake records, PostageLog, game state
                         ├─ swarm-vm::run(input)       native, sanity check
                         └─ SP1: program(input) ─► Groth16 proof ─► settleRound
```

Two transactions per round for the whole network, instead of about three per participating node today.
Uploaders who buy or top up stamps send their own transactions to PostageStampZK, as today, but they do
not pay for the expiry of other batches.

### Round timing

`ROUND_LENGTH = 152` blocks, the same as Redistribution. On Sepolia and mainnet that is about 30 minutes.

| Blocks in round | Phase | What happens |
| --- | --- | --- |
| 0-37 | commit | Nodes sign commits and send them to a prover, or call `forceCommit` |
| 38-56 | anchor | The prover calls `anchorRound(round, commitsHash, count, dataRef)` once. `forceCommit` is still open, so a node that is missing from the anchored list can still get in |
| 57-113 | reveal | Nodes send reveals to the prover, or call `forceReveal` |
| 114 | seed block | Its block hash becomes the selection seed. Nobody chooses it |
| 115-151 | claim | Truth and winner are known. The winner (or any node that holds the truth's sample) sends the three claim proofs to the prover, or calls `forceClaim` |
| 115 onward | settle | Anyone with a valid proof calls `settleRound`. Rounds settle in increasing order. A round whose truth has no valid claim ("unclaimed") settles only from block 152 |

### Randomness

- **Round anchor** (neighbourhood selection) = `keccak256(blockhash(roundStart - 1), round)`. Every node
  knows it from the first block of the round. Stored at `anchorRound`.
- **Selection seed** (truth, winner, freeze lottery) = `keccak256(roundAnchor, blockhash(roundStart + 114))`.
  It's fixed after every commit and reveal deadline has passed. Settlement recomputes it itself, from
  `blockhash` or from the EIP-2935 history contract (8191 blocks, about 27 hours), and rejects a proof
  that used anything else.

This removes the "first revealer chooses the seed block" lever of today's contract
([ZK-REDISTRIBUTION.md §6](./ZK-REDISTRIBUTION.md)). What's left is the usual proposer influence over
one block hash.

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
| `forcedCommitsHash` | hash chain built by `forceCommit` | 4 |
| `forcedRevealsHash` | hash chain built by `forceReveal` | 5 |
| `lastClaimRound`, `lastWinnerDepth` | Settlement state (minimum depth rule) | 6 |
| penalty parameters | Settlement state | 7 |
| `participants`, `stakeDigest` | `StakeRegistry.stakes(owner)` read now, for every participant: overlay, committed and potential stake, height, last update | 8 |
| `stakePrice` | `PriceOracle.currentPrice()` (the VM computes effective stake from it) | 9 |
| `forcedClaimsHash` | hash chain built by `forceClaim` | 10 |
| `postage`: previous state hash, previous and new log position, log hash, cut block | Settlement's stored postage state hash and log position; `PostageStampZK.eventHashAt(index)`; the next log entry, if any, must be after the cut block; the cut block must not be in the future | 11 |
| `sampleMaxValue` | Settlement state (default: Redistribution's value) | 12 |

Then `verifier.verifyProof(programVKey, publicValues, proof)`. Then it executes the outcome:

1. For every round: store the new postage state hash and log position, and add the proven
   `potAmount` to `accruedPot`.
2. For a round with a valid claim: freezes, `adjustPrice(redundancy)`, then withdraw `accruedPot` from
   PostageStampZK. Pay `proverFeeBps` (default 1%) to the caller and the rest to the winner.

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
- freezes: `2 * 152 * 2^truthDepth` for committed but not revealed, and `1 * 152 * 2^truthDepth` for a
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
accepts an unclaimed outcome only after the claim window (block 152), so a prover cannot close the round
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
value, outpayment, block)`. The contract keeps the hash and block of the last 256 entries
(`eventHashAt`, `eventBlockAt`) and emits `PostageLog` with the same fields. This costs about 15k gas for
each change.

**One settlement, step by step.**

1. The prover reads Settlement's `postageStateHash`, `postageEventIndex` and `postageEventHash`, loads the
   postage state with that hash (`$DATA_DIR/postage/<hash>.json`), and reads the `PostageLog` entries
   after `postageEventIndex` up to the cut block (the current block).
2. The program replays the entries in order. Before an entry changes a batch, it credits that batch up
   to the entry's outpayment. It checks each entry's outpayment against the last price change.
3. The program runs the game and the claim. The claim reads the batches from the state after step 2.
4. The program credits every batch up to the outpayment at the cut block, and removes the batches whose
   balance ended. A batch never pays more than its balance.
5. The outputs are the new state hash, the pot amount and `validChunkCount`.
6. Settlement checks the log position and hash against PostageStampZK, and that the next entry (if any)
   is after the cut block. Thus no entry up to the cut is missing. Then it adds the pot amount to
   `accruedPot`.

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
| Stake snapshot at `commit` (`nodeEffectiveStake`) | Raw stake record read at `settleRound`; must be older than `roundStart - 2 rounds`. Effective stake = `min(2^height * committed * price, potential)`, computed in the VM | Avoids a stake snapshot transaction. A stake change or freeze after the round started disqualifies the node for that round. The raw record is used because `nodeEffectiveStake` depends on `block.number` (0 while frozen), which made the first version fail when a freeze expired between proving and settling (regression test in `test/Settlement.test.ts`) |
| Seed updated with `prevrandao` at the first reveal | Block hash of a fixed block (114) | The prover must not influence randomness |
| Disagreement freeze uses `block.prevrandao % 100` | `keccak(seed, "2") % 100` | Same reason |
| Invalid reveal reverts, so the node stays "not revealed" | Invalid reveal is ignored, so the node stays "not revealed" | Same effect |
| Anchored commit with a bad signature | Dropped from the round | A prover that anchored garbage must not make the round unprovable |
| `claim` reads the batch at claim time: "exists" means not yet removed by `expireLimited` | The batch comes from the proven postage state; "alive" means balance above the outpayment at the seed block | Batches are no longer removed on chain. The comparison is exact, and it does not depend on when somebody swept |
| `expireLimited` removes expired batches and credits the pot, paid by whoever buys a stamp or claims | The proof replays PostageStampZK's log, expires batches and credits the pot at each settlement | Stamp buyers pay only for their own batch. The pot is the same (differential test) |
| Anyone can call `claim` during the claim phase | Anyone can send the witness to a prover, or call `forceClaim` (blocks 115-151) | The same, off chain |

---

## 3. The hard problems, and what this version does about each

**Input completeness (can the prover leave me out?).** The prover can drop your off-chain commit or
reveal. The escape hatch: `forceCommit` (blocks 0-56) and `forceReveal` (blocks 57-113) record the
message in a hash chain on chain, and `settleRound` rejects any proof that didn't consume exactly that
chain. A node can check the anchored list at `GET /v1/rounds/{round}` during the anchor phase and force
its commit if it's missing. node-sim's `--forced` flag runs this path. Still open from the proposal
(§7.1c): scoping a forced entry so it re-opens the prover's obligation for several rounds, not one.

**Ordering.** The commit set is fixed on chain (`anchorRound`) before any reveal is accepted and before
the seed block exists.

**Reveal after the seed is known (known issue, from master).** Only the prover enforces the deadline for
off-chain reveals (block 114). Thus a node that colludes with the prover can see the seed first and then
select to reveal or not. A reveal cannot change the committed values, and a node that does not reveal
gets a freeze. This issue is not new. In `Redistribution.sol`, the first reveal sets the seed, so each
later revealer knows the seed and has the same option. Other branches fix the game in general, so this
branch does not fix the issue. A possible fix here is an `anchorReveals(revealsHash)` transaction before
the seed block.

**Storage possession.** Proven, with the same evidence as `claim` today (section 2, "Claim"). A prover can
withhold the winner's witness; `forceClaim` is the escape hatch, the same as for commits and reveals.

**Prover liveness.** `settleRound` is permissionless. `anchorRound` is limited to `ANCHOR_ROLE` (the
Foundation's prover first, as the proposal says). If nobody settles, the payments stay in PostageStampZK.
The next settlement replays the log and credits them. A round can be skipped: rounds settle in increasing
order, so settling round N+1 makes round N unsettleable. Section 4 tells who settles and who pays.

**Upgrade authority.** `setVerifier(verifier, programVKey)` is admin-only and instant. On mainnet it
must sit behind a timelock with an exit window. This is the residual risk L2BEAT flags in Lighter and
Derive.

**Data availability.** The anchored list is held by the prover (`data/rounds/<n>/messages.json`, served
at `/v1/rounds/{n}`). `anchorRound` already takes a `dataRef`. The next step is to upload the list to
Swarm and pass the reference there. The postage state (`data/postage/<hash>.json`) has the same problem:
another prover needs it to continue. It can also be rebuilt from the `PostageLog` history and the cut
blocks of the earlier settlements (`PostageSettled` events), but the prover does not do this yet.

**Size of the postage state.** The proof reads and hashes all live batches at each settlement: about 46k
cycles for each live batch (section 5). That is 50M cycles for 1,000 batches and 460M for 10,000. The
fix is a Merkle tree of the batches, so a settlement touches only the batches that changed or expired
(ZK-SETTLEMENT-OPTIMIZATION.md, item 9).

---

## 4. Prover and settlement: who does what, and who pays

| Action | Who | When | Gas paid by | Paid back |
| --- | --- | --- | --- | --- |
| `createBatch`, `topUp`, `increaseDepth` | Uploader | Any time | Uploader (only its own batch) | — |
| Commit, reveal, claim witness | Node, off chain | Each round | Nobody (HTTP) | — |
| `forceCommit`, `forceReveal`, `forceClaim` | Node | Only if the prover censors it | Node | No |
| `anchorRound` | Prover with `ANCHOR_ROLE` (the Foundation at the start) | Blocks 38-56 of each round | Prover | No |
| Proof | Prover (own GPU or a proving market) | After block 114 | Prover (off chain) | Through the fee |
| `settleRound` | Anyone with a valid proof; in practice the prover service | From block 115 (unclaimed: from block 152) | Caller | `proverFeeBps` (1%) of the payout, only in rounds with a payout |

**Who calls `settleRound`.** It has no role check: the proof is the permission. The prover service
(`swarm-prover serve`, `settler.rs`) calls it when the round is ready. Another prover, or the winner,
can call it with its own proof. The first valid call wins; a second one reverts with `AlreadySettled`.

**At the start.** The Foundation runs the prover. It pays the gas of `anchorRound` (about 75k) and
`settleRound` (about 0.5M with a real proof), and the cost of the proofs. It gets back 1% of the pot in
rounds with a payout. `anchorRound` and rounds without a payout give nothing back.

**Later.** When the round data (commit lists, postage state) is public on Swarm, anyone can prove and
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
115-151, about 7 minutes at 12 s blocks). A round has about 10 participants, so the proving time stays
in this range. For a production prover, use the Succinct Prover Network (`SP1_PROVER=network`) or a GPU.
These options give more margin and do not need a 10 GB laptop.

**Contract cost for each participant:** `settleRound` reads `StakeRegistry.stakes` for each participant
(about 13k gas when cold). It also calls `freezeDeposit` one time for each freeze. A round has about 10
participants, so this adds about 130k gas. The stake read does not cause a scale problem.

**PostageStampZK** (2026-11-02, Hardhat):

| Measurement | Result |
| --- | --- |
| `createBatch` with 50 batches already present: PostageStamp (master) | 443,169 gas |
| The same with PostageStampZK | 176,950 gas (60% less) |
| Pot and `validChunkCount` of the replay against master, 3 random histories, 18 checkpoints | Equal at every checkpoint |

On master the cost of `createBatch` also increases with the size of the tree and with the number of
batches that expired since the last sweep. On PostageStampZK it does not.

**zkVM cycles with postage accounting** (`synth --nodes 10 --batches N`, `execute`, no proof):

| Live batches in the postage state | Cycles |
| --- | --- |
| 1 | 3.71M |
| 1,000 | 49.6M |
| 10,000 | 463M |

About 46k cycles for each live batch and settlement. This is the main cost at mainnet size. See
"Size of the postage state" in section 3.

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
PROGRAM_VKEY=0x00... PROVER_ADDRESS=<prover key address> npx hardhat deploy --network sepoliazk
#    Or a smoke test without proving: ZK_VERIFIER=mock npx hardhat deploy --network sepoliazk

# 3. Stake the simulated nodes (needs the deployer to hold ETH for them; NODE_ETH per node, default 0.02)
NODE_KEYS=0x..,0x..,0x.. npx hardhat run scripts/zk/setup-nodes.ts --network sepoliazk
#    Nodes can play once their stake is older than two rounds (~1 hour on Sepolia).

# 4. Prover. POSTAGE_FROM_BLOCK = deployment block of PostageStampZK (deployments/sepoliazk/PostageStamp.json)
cd prover
export RPC_URL=<sepolia rpc> SETTLEMENT_ADDRESS=$(jq -r .address ../deployments/sepoliazk/Settlement.json)
SP1_PROVER=network NETWORK_PRIVATE_KEY=0x.. PROVER_PRIVATE_KEY=0x.. DATA_DIR=data/sepolia \
  POSTAGE_FROM_BLOCK=$(jq -r .receipt.blockNumber ../deployments/sepoliazk/PostageStamp.json) \
  ./target/release/swarm-prover serve
#    Or prove on a rented GPU with SP1_PROVER=cuda: prover/README.md, "Run the prover on a rented GPU".

# 5. Nodes. BATCH_OWNER_KEY = the deployer key (it owns the batch that stamps the simulated reserve)
NODE_KEYS=0x..,0x.. BATCH_OWNER_KEY=0x.. ./target/release/node-sim --depth 0 --silent 3 --liar 4 --forced 2
```

On Sepolia the selection seed is available for 8191 blocks (about 27 hours) through EIP-2935, so a slow
prover still settles.

---

## 7. Migration phases, and where this branch is

Phases are from [ZK-REDISTRIBUTION.md §11](./ZK-REDISTRIBUTION.md).

| Phase | | State |
| --- | --- | --- |
| 1 | Deterministic VM, no EVM dependency | **Done** for master's rules (`crates/vm`) |
| 2 | Shadow mode: VM against live Gnosis rounds | Not started. Needs a replay tool that turns `Committed`/`Revealed` events into a `RoundInput` |
| 3 | Prove the game logic | **Done** (SP1 program, Settlement, Sepolia setup) |
| 4 | Prove the storage witnesses | **Done** (`claim.rs`, `forceClaim`, differential vectors) |
| 4b | Postage accounting in the proof | **Done** (`PostageStampZK`, `postage.rs`, differential vectors). Not yet run end to end |
| 5 | Canonical settlement, retire on-chain phases | This branch's deployment shape |
| 6 | Recursive aggregation | Not started |

The plan to decrease mainnet gas further (storage proofs for stakes, epochs, oracle change, payouts that
winners collect, a smaller anchor, a Merkle postage state) is in
[ZK-SETTLEMENT-OPTIMIZATION.md](./ZK-SETTLEMENT-OPTIMIZATION.md).

### Open items (in priority order)

1. Run the current version end to end (node-sim, local and Sepolia) and make one real proof on a GPU.
2. Timelock or exit window on `setVerifier`.
3. Swarm as the data layer: upload the anchored list and the postage state; pass the reference as
   `dataRef`.
4. A Merkle postage state, so the proof cost does not grow with all live batches (optimization plan,
   item 9).
5. Fee model for provers (section 4).
6. Batch migration from Gnosis PostageStamp to PostageStampZK (`copyBatchBulk`), and a check with the Bee
   team that no Bee version reads `pot` or `validChunkCount`.
7. Forced-inclusion scoping across several rounds (§7.1c of the proposal).
8. Bee integration: the commit, reveal and claim messages, the HTTP API (or Swarm feeds), and when to
   fall back to `forceCommit`/`forceReveal`/`forceClaim`.
9. Nodes don't know the minimum depth for round N+1 until round N is settled. Settling within the round
   (blocks 115-151) avoids that, but needs fast proving.
