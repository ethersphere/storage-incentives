# ZK settlement: optimization plan

This document gives the next changes for the ZK settlement on branch `feat/zk-settlement`. The goal is
low gas on Ethereum mainnet: few transactions and little computation on chain. The current design is in
[ZK-SETTLEMENT.md](./ZK-SETTLEMENT.md).

**Status:** plan. Nothing in this document is implemented yet.

**Decision so far:** keep the ZK validity proof (option A) as the long-term design. The proof cost on
chain stays the same when the rules become more complex, for example with SWIP-49/50 (STS-1).

---

## 1. Summary

| # | Change | Gas effect | Changes the game? | Depends on |
| --- | --- | --- | --- | --- |
| 1 | Read stakes and price from storage proofs in the zkVM | Removes about 13k gas for each participant from `settleRound` | Stakes and price come from the block before the round starts | — |
| 2 | Read postage batches from storage proofs in the zkVM | Removes the batch reads from `settleRound` | Batches come from the seed block (114) | 1 |
| 3 | Settle an epoch of K rounds with one proof | Divides the proof check (about 270k gas) by K | Payouts and on-chain freezes arrive at the epoch end | 1, 4 |
| 4 | `PriceOracle.adjustPrice` for a list of rounds | Needed for 3 | No | — |
| 5 | Payouts that winners collect | Removes token transfers from `settleRound` | Winners send one transaction to collect | 3 |
| 6 | A smaller `anchorRound` | About 75k down to about 30k gas for each round | No | — |
| 7 | Faster proof generation | No gas effect. Less time to finality | No | — |

Order of work: 1, 2, 4, 3, 5, 6. Item 7 can occur at any time.

---

## 2. Estimated gas

These values are estimates. They use the local measurements in ZK-SETTLEMENT.md (section 4) and a round
of about 10 participants. Measure each step on Sepolia before you use the values in a decision.

| Configuration | Transactions | Gas for each round |
| --- | --- | --- |
| Master today (Redistribution) | About 3 for each participant, 30 for each round | Highest |
| Branch now: `anchorRound` + `settleRound` with a Groth16 proof | 2 for each round | About 0.6M |
| After 1 and 2 | 2 for each round | About 0.45M |
| After 3 (K = 8), 4 and 5 | 1 anchor for each round + 1 settle for each epoch | About 0.12M |
| After 6 | Same | About 0.08M |

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

## 4. Postage batches from storage proofs (item 2)

The claim checks the batch of each witness: owner, depth, bucket depth. Now `settleRound` reads
`PostageStamp.batches(id)` for each batch id.

Use the same method as item 1, at the seed block (`roundStart + 114`). Settlement already checks the hash
of this block for the selection seed. The batch state at block 114 is near to the claim time of master.

The slots are `batches[id].owner`, `.depth` and `.bucketDepth`. They are packed in one storage slot
(address + uint8 + uint8). Thus one storage proof is sufficient for each batch.

---

## 5. Epochs: one proof for K rounds (item 3)

### What nodes see

1. Nodes play each round as now: commit, reveal and claim, off chain.
2. The result of each round is known after its seed block (114). Anyone can calculate it from the public
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

The pot does not depend on claims:

- `PostageStamp.expireLimited` increases `pot` for each block, from the number of valid chunks and the
  price. It also removes expired batches.
- `createBatch`, `copyBatch`, `increaseDepth`, `totalPot()` and `withdraw()` call `expireLimited`. Anyone
  can also call it. Thus expired batches go out of the tree also when nobody claims.
- `withdraw` sends all of the pot to the caller and sets `pot = 0`.

With epochs, one `withdraw` at the epoch end gets the pot of K rounds. Settlement divides it between the
winners:

1. Each claimed round gets the part of the pot for the blocks since the previous claimed round.
2. An unclaimed round gives its part to the next claimed round, as on master.
3. The program calculates the division from the block numbers. Settlement applies it.

The pot increases almost linearly between price changes. Thus the division by blocks is very near to the
payouts of a claim for each round.

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

## 10. Prerequisites for mainnet (not optimizations)

These items do not decrease gas. Do them before a mainnet deployment:

1. Put `Settlement.setVerifier` behind a timelock with an exit window.
2. Point Settlement at one verifier version, or examine the control of the SP1 verifier router. See
   [prover/zkvms/README.md](../prover/zkvms/README.md), section 5.
3. Store the anchored commit lists on Swarm and give the reference as `dataRef`.
