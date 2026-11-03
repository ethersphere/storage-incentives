# ZK settlement: optimization plan

This document gives the next changes for the ZK settlement on branch `feat/zk-settlement`. The goal is
low gas on Ethereum mainnet: few transactions and little computation on chain. The current design is in
[ZK-SETTLEMENT.md](./ZK-SETTLEMENT.md).

**Status:** item 8 (postage accounting in the proof) is implemented, and it replaces item 2. The other
items are plans.

**Decision so far:** keep the ZK validity proof (option A) as the long-term design. The proof cost on
chain stays the same when the rules become more complex, for example with SWIP-49/50 (STS-1).

---

## 1. Summary

| # | Change | Gas effect | Changes the game? | Depends on |
| --- | --- | --- | --- | --- |
| 1 | Read stakes and price from storage proofs in the zkVM | Removes about 13k gas for each participant from `settleRound` | Stakes and price come from the block before the round starts | — |
| 2 | ~~Read postage batches from storage proofs in the zkVM~~ | Done by item 8: the claim reads batches from the proven postage state | — | — |
| 3 | Settle an epoch of K rounds with one proof | Divides the proof check (about 270k gas) by K | Payouts and on-chain freezes arrive at the epoch end | 1, 4 |
| 4 | `PriceOracle.adjustPrice` for a list of rounds | Needed for 3 | No | — |
| 5 | Payouts that winners collect | Removes token transfers from `settleRound` | Winners send one transaction to collect | 3 |
| 6 | A smaller `anchorRound` | About 75k down to about 30k gas for each round | No | — |
| 7 | Faster proof generation | No gas effect. Less time to finality | No | — |
| 8 | **Done.** Postage accounting (expiry and pot) in the proof; `PostageStampZK` without the batch tree | `createBatch` 443k → 177k gas (measured, 50 batches); no expiry sweeps for anybody | Batches expire by comparison; nothing is removed on chain | — |
| 9 | A Merkle postage state | No gas effect. Proof cost no longer grows with all live batches (Gnosis today: 369M cycles per settlement) | No | 8 |

Order of work: 9, 1, 4, 3, 5, 6. Item 7 can occur at any time. Item 9 is first because the proof cost of
item 8 grows with the number of live batches (about 46k cycles each).

---

## 2. Estimated gas

These values are estimates. They use the local measurements in ZK-SETTLEMENT.md (section 5) and a round
of about 10 participants. Measure each step on Sepolia before you use the values in a decision.

| Configuration | Transactions | Gas for each round |
| --- | --- | --- |
| Master today (Redistribution) | About 3 for each participant, 30 for each round | Highest |
| Branch now: `anchorRound` + `settleRound` with a Groth16 proof | 2 for each round | About 0.6M |
| After 1 (8 is done) | 2 for each round | About 0.45M |
| After 3 (K = 8), 4 and 5 | 1 anchor for each round + 1 settle for each epoch | About 0.12M |
| After 6 | Same | About 0.08M |

Stamp buyers: `createBatch` costs 176,950 gas with PostageStampZK against 443,169 with PostageStamp, with 50
batches present (measured). On PostageStamp the cost also increases with the tree size and with the
expired batches that the buyer removes.

---

## 3. Stakes and price from storage proofs (item 1)

### Problem

`settleRound` reads `StakeRegistry.stakes(owner)` for each participant and `PriceOracle.currentPrice()`.
Each cold read costs gas. The read occurs at settlement time, not at round time. Thus a stake change
during the round removes the node from the round. This rule is also a problem for epochs (item 3).

### Design

1. The snapshot block is `roundStart - 1`. Settlement already uses the hash of this block for the round
   anchor: `roundAnchor = keccak256(blockhash(roundStart - 1), round)`. Thus Settlement needs no new
   check.
2. The prover calls `eth_getProof` at the snapshot block for:
   - StakeRegistry: the account proof, and the five storage slots of `stakes[owner]` for each
     participant (overlay, committedStake, potentialStake, lastUpdatedBlockNumber, height);
   - PriceOracle: the account proof and the slot of the price.
3. The zkVM program:
   1. decodes the block header and checks that its hash is the snapshot block hash;
   2. checks each account proof against the state root of the header;
   3. checks each storage proof against the storage root of the account;
   4. reads the stake records and the price from the proven slots.
4. The public inputs keep the snapshot block hash. They lose `participants`, `stakeDigest` and
   `stakePrice`.
5. `settleRound` does not read StakeRegistry or PriceOracle for the inputs.

Use `alloy-trie` (Ethereum Merkle Patricia trie proofs) and `alloy-consensus` (block header) in the VM.
Do not use an EVM inside the zkVM (SP1 `sp1-contract-call`, RISC Zero Steel). The MPT path uses fewer
cycles, and it does not depend on one zkVM.

### Rule change

| | Master | Branch now | After item 1 |
| --- | --- | --- | --- |
| Stake for a round | Snapshot at `commit` | Read at settlement | Snapshot at `roundStart - 1` |
| Stake change during the round | Commit already has the old value | The node is not eligible | No effect on this round |
| Price for effective stake | At `commit` | At settlement | At `roundStart - 1` |

This rule is nearer to master than the branch is now. It also removes the race between a freeze end and
the settlement transaction (regression test in `test/Settlement.test.ts`).

### Points to know

- **Storage layout.** The VM must know the slot numbers of `stakes` in StakeRegistry and of the price in
  PriceOracle. Get the slots from the compiler storage layout (`forge inspect StakeRegistry
  storageLayout`). Add a test that compares the proven values with `stakes(owner)` on a local chain. A new
  StakeRegistry deployment needs a new VM version.
- **RPC.** A full (non-archive) Ethereum node keeps the state of the last 128 blocks only. The settlement
  occurs 116 or more blocks after the snapshot block. Thus:
  - the prover gets the proofs at the end of the anchor phase (block 57), when the participant list is
    final (`forceCommit` closes at block 57);
  - for a late settlement, the prover needs an archive RPC.
- **Cycles.** About 10 participants × 5 slots, each a proof of about 8 trie nodes. Estimate: a few hundred
  thousand cycles. This is small compared with the claim checks (about 2M cycles).

### Tests

1. Rust: verify `eth_getProof` output from anvil for a known stake. Change one byte of a proof and expect
   a failure.
2. Hardhat or anvil: the proven record equals `stakes(owner)` at the snapshot block.
3. End to end: the same local run as in ZK-SETTLEMENT.md, with a node that changes its stake during a
   round. The node must stay in that round.
4. Gas: compare `settleRound` before and after.

---

## 4. Postage batches (item 2): replaced by item 8

The claim needs the batch of each witness: owner, depth, bucket depth, and whether it is alive. With item
8 the proof carries the postage state, so the claim reads the batch from it. No storage proof and no
`batches(id)` read in `settleRound` are necessary.

---

## 5. Epochs: one proof for K rounds (item 3)

### What nodes see

1. Nodes play each round as now: commit, reveal and claim, off chain.
2. The result of each round is known after its seed block (48). Anyone can calculate it from the public
   messages. The prover gives it at `GET /v1/rounds/{n}/outcome`.
3. At the epoch end, one `settleRound` applies the results of the K rounds.
4. The payout and the on-chain freeze come at the epoch end. They do not come at the round end.

### Program

The program runs the K rounds in sequence. It keeps the game state between the rounds:

- `lastClaimRound` and `lastWinnerDepth` (minimum depth rule);
- a freeze table: owner and the block at which the freeze ends.

A node that gets a freeze in round 3 is not eligible in round 4, as with a settlement for each round.
The game result is the same as with a settlement for each round.

### Freezes on chain

At the epoch end, Settlement calls `freezeDeposit(owner, freezeEnd - block.number)` for each freeze that
did not end. It does not call it for a freeze that ended. The total freeze time does not change.

Until the epoch end, StakeRegistry does not show the freeze. During this time, a frozen node can only
withdraw surplus stake (`withdrawFromStake`). This risk is small. Bee must get its freeze status from the
round results, not from StakeRegistry.

### Pot

With item 8 the proof computes the pot. In an epoch, the program can cut the postage accounting at the
end of each round, not only at the epoch end. Thus each round gets its exact pot, with no division:

1. The program replays the log entries of round 1, credits the pot up to the cut of round 1, and plays
   round 1.
2. It does the same for round 2, and so on.
3. A claimed round gets its own pot plus the pot of the unclaimed rounds before it, as on master.
4. Settlement records the amount for each winner (item 5), or pays the winners at the epoch end.

### Epoch length

- **Upper limit:** Settlement must read the seed of each round in the epoch. EIP-2935 keeps 8191 block
  hashes, about 27 hours or 54 rounds.
- **Recommended:** 4 to 8 rounds (2 to 4 hours).
- Make the length a Settlement parameter.

### Points to know

- The epoch design needs item 1. Without it, a stake change in round 6 makes the node not eligible in
  rounds 1 to 5.
- The epoch design needs item 4 for the price.

---

## 6. PriceOracle for a list of rounds (item 4)

`PriceOracle.adjustPrice(uint16 redundancy)` expects one call for each round. If rounds are skipped, it
applies the maximum price increase (`changeRate[0]`) for each skipped round. One call for an epoch of 8
rounds looks like 7 skipped rounds. Thus the price increases incorrectly.

Add a function that applies one step for each round, in sequence:

```solidity
function adjustPrices(uint16[] calldata redundancies) external returns (bool);
```

Rules:

- Only `PRICE_UPDATER_ROLE` can call it.
- It applies `changeRate[redundancy]` once for each value in the list.
- A round without a truth has no redundancy value. `adjustPrice` reverts on 0 (`UnexpectedZero`). On
  master, such a round gets no price adjustment, and the next call treats it as skipped. Agree on the
  rule for such rounds in an epoch before you implement it.
- It sets `lastAdjustedRound` to the current round.

This is the only change to a contract other than Settlement. PriceOracle must be deployed again.

---

## 7. Payouts that winners collect (item 5)

Now `settleRound` sends tokens to the winner and to the prover. With epochs, it sends tokens to up to K
winners.

Instead, Settlement records an amount for each winner. The winner calls `collect()` later. Thus
`settleRound` does one `withdraw` from PostageStamp and no transfers to winners. The winner pays the gas
for the transfer.

---

## 8. A smaller anchor (item 6)

`anchorRound` must stay one transaction for each round. It fixes the commit set before the seed of the
round exists. No other method gives this order without a transaction in the round.

To decrease its cost (now about 75k gas):

1. Keep one rolling hash for all rounds: `anchors = keccak256(anchors, round, commitsHash, count)`. The
   update writes one slot that is not zero. This costs about 5k gas instead of about 22k.
2. Emit the full data in the event. The prover gives the anchors of the epoch to the program, and the
   program checks them against the rolling hash.

Estimate: about 30k gas for each round.

---

## 9. Faster proof generation (item 7)

This item does not change gas. It decreases the time from the seed block to the settlement.

| Option | Expected time for one round (about 3M cycles) | Notes |
| --- | --- | --- |
| Laptop CPU (measured) | About 5.5 min, 10 GB memory | Development only |
| One NVIDIA GPU (`SP1_PROVER=cuda`) | About 10 to 30 s (estimate) | Linux machine. Groth16 files (7.8 GB) download once |
| Succinct Prover Network (`SP1_PROVER=network`) | Not measured. Includes a queue | Pay for each proof |

With epochs, one proof covers K rounds. The STARK part increases with K. The recursion and the Groth16
wrap stay almost the same.

---

## 10. Postage accounting in the proof (item 8, implemented)

This item is implemented. The design, the Bee compatibility and the tests are in
[ZK-SETTLEMENT.md](./ZK-SETTLEMENT.md), section 2, "Postage accounting in the proof". Summary:

- `PostageStampZK` has the batch functions, events and views of PostageStamp, without the batch tree and
  without `expireLimited`. A batch is expired when its balance ended; nothing is removed.
- Each change that affects the pot goes into an event log (hash chain + `PostageLog` event).
- Each settlement replays the new log entries in the proof, credits the pot, removes expired batches from
  the proof's state, and gives the pot amount. Settlement keeps `accruedPot` and pays it to the next
  winner.
- `expiredBatchesExist()` and `expireLimited()` stay as no-ops for current Bee versions.
- The replay gives the same pot and `validChunkCount` as master's PostageStamp at all 18 checkpoints of
  three random histories.

---

## 11. A Merkle postage state (item 9)

### Problem

The proof carries all live batches as one list. At each settlement it reads the list, hashes it two
times (before and after) and credits each batch. The cost is about 46k cycles for each live batch: 50M
cycles for 1,000 batches and 460M for 10,000. Most batches do not change in a round.

Measured with the real Gnosis history (ZK-SETTLEMENT.md, section 5, "Real Gnosis postage history"):
Gnosis has 8,013 live batches. One settlement of one 152-block round is 368,829,867 cycles. The game of
that round costs about 2.5M cycles. In that round, 12 events changed batches and 2 batches expired. A
Merkle state touches only those 14 batches. The Succinct Prover Network proved the full settlement in
127 s for at most 0.64 PROVE (a small round: about 45 s and 0.40 PROVE). Thus today's state fits in a
round, but the time and the variable price grow with the number of live batches.

### Design

Use the method of `expireLimited`, inside the proof:

1. Keep two Merkle trees in the state: batches by id, and batches sorted by `normalisedBalance` (the
   order in which they expire). Settlement stores only the two roots and the global values.
2. Keep `validChunkCount` and the outpayment of the last cut in the state.
3. For a settlement from outpayment `O1` to `O2`:
   - pot += `validChunkCount × (O2 − O1)`, as `expireLimited` does for live batches;
   - for each batch that expired in the period (the start of the sorted tree, up to `O2`): correct the
     pot for the part after its expiry, decrease `validChunkCount`, and remove it from both trees;
   - for each log entry: update only that batch, with a Merkle proof.
4. The prover gives Merkle proofs only for the batches that changed or expired.

Cost: about `(changes + expiries) × log2(batches)` hashes for each settlement, instead of a cost for all
batches.

### Tests

Use the same differential vectors as item 8 (`postage_vectors.rs`). The pot and `validChunkCount` must not
change.

---

## 12. Prover economics

Who calls `anchorRound` and `settleRound`, who pays the gas, and how the fee pays it back: see
[ZK-SETTLEMENT.md](./ZK-SETTLEMENT.md), section 4. The open points there (fee shape, races between
provers, transactions without a fee) are also inputs for the epoch design (item 3).

---

## 13. Prerequisites for mainnet (not optimizations)

These items do not decrease gas. Do them before a mainnet deployment:

1. Put `Settlement.setVerifier` behind a timelock with an exit window.
2. Point Settlement at one verifier version, or examine the control of the SP1 verifier router. See
   [prover/zkvms/README.md](../prover/zkvms/README.md), section 5.
3. Store the anchored commit lists and the postage state on Swarm and give the reference as `dataRef`.
