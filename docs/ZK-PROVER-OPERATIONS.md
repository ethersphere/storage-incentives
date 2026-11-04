# ZK settlement: prover operations, keys and costs

This document tells what the prover does, which keys and wallets it uses, what each one costs, how much
money each wallet must hold, and what happens if a key is compromised. It also compares proving on the
Succinct Prover Network with proving on our own GPU.

The design is in [ZK-SETTLEMENT.md](./ZK-SETTLEMENT.md). The measurements in this document come from
section 5 of that document (Sepolia, November 2026). Prices in USD are not given: multiply the
quantities by the market prices of ETH, PROVE and BZZ.

---

## 1. What the prover does

The prover is one service (`swarm-prover serve`) with a Bee node beside it. It does these actions:

| When                                      | Action                                                                            | Transaction                              | Paid with                                    |
| ----------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------- |
| Each round, blocks 16-19                  | Fix the commit list: `anchorRound(round, root, count, dataRef)`                   | Yes, on the settlement chain             | ETH (prover key)                             |
| Each round, blocks 16-19                  | Upload the commit list to Swarm; its reference is `dataRef`                       | No (Bee upload)                          | Postage batch                                |
| Each round, blocks 40-43                  | Fix the reveal list: `anchorReveals(round, root, count, dataRef)`                 | Yes                                      | ETH (prover key)                             |
| Each round, blocks 40-43                  | Upload the reveal list to Swarm                                                   | No (Bee upload)                          | Postage batch                                |
| Each round, after block 48                | Build the round input and prove it                                                | No (proof request)                       | PROVE (Succinct requester key), or own GPU   |
| Each round, after the proof               | `settleRound(publicValues, proof)`                                                | Yes                                      | ETH (prover key); gets 1% of the payout back |
| Once a day (`SNAPSHOT_EVERY`, 112 rounds) | Upload a snapshot of the postage state to Swarm                                   | No (Bee upload)                          | Postage batch                                |
| Every hour                                | Check the postage batch; top it up if `SWARM_TOPUP_DAYS` is set                   | Only for a top-up (on the postage chain) | BZZ and gas (Bee wallet)                     |
| Always                                    | Serve the HTTP API for nodes: commits, reveals, claim witnesses, inclusion proofs | No                                       | —                                            |
| Once                                      | Buy the postage batch (`swarm-prover stamp buy`)                                  | Yes (on the postage chain)               | BZZ and gas (Bee wallet)                     |

There are about 112.5 rounds each day (64 blocks of 12 s = 768 s). Thus the prover sends about 337
transactions each day, three for each round.

A round without a valid claim (unclaimed, or no reveals) still settles. The settlement carries the
postage accounting. A prover cannot skip an anchored round: `settleRound` reverts (`RoundPending`)
while an earlier anchored round can still settle. A round whose data is lost blocks the next rounds until
its seed is gone (about 27 hours); after that, the next rounds settle in order.

---

## 2. Keys and addresses

Use a different key for each role. Then a compromised key does only the damage of its own role.

| Key                                                | Holds                                                                      | Used for                                                                            | Where it lives                                 |
| -------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------- |
| **Admin**                                          | `DEFAULT_ADMIN_ROLE` on Settlement                                         | Grant or revoke `ANCHOR_ROLE`; `setVerifier`; parameters; `warmRing`; pause         | Cold: a multisig, behind a timelock on mainnet |
| **Prover key** (`PROVER_PRIVATE_KEY`)              | `ANCHOR_ROLE`; ETH for gas                                                 | `anchorRound`, `anchorReveals`, `settleRound`. Receives the prover fee              | Hot, on the prover server                      |
| **Succinct requester key** (`NETWORK_PRIVATE_KEY`) | A PROVE balance on the Succinct Prover Network                             | Pays for proof requests                                                             | Hot, on the prover server                      |
| **Bee node wallet**                                | The Bee node's own key (in its keystore); BZZ and gas on the postage chain | Owns the postage batch, signs the stamps of the uploads, buys and tops up the batch | Hot, in the Bee node                           |
| **Fee destination** (optional)                     | —                                                                          | A cold address that the prover sweeps its fees to                                   | Cold                                           |

**Does the prover have its own address?** Yes: the address of `PROVER_PRIVATE_KEY`. Settlement knows it
only through `ANCHOR_ROLE`. `settleRound` is open to everybody. The fee goes to `feeRecipient`, an output
of the proof: the prover puts its own address there. A copy of the transaction (front-running) thus pays
the copier nothing.

**Who owns the postage batch?** The Bee node wallet. A batch's owner signs every stamp, so the owner key
must be in the Bee node that uploads. Do not use the prover key for this. Bee buys the batch with its own
wallet when you run `swarm-prover stamp buy`.

**Which chain is the batch on?** On the chain of the Swarm postage contract that Bee uses. Today that is
Gnosis Chain (xBZZ for the batch, xDAI for gas). After the move to Ethereum it is PostageStampZK on
Ethereum (BZZ and ETH).

---

## 3. If a key is compromised

| Key                        | What an attacker can do                                                                                                                                                                                                                     | What an attacker cannot do                                                                                                       | Recovery                                                                                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Prover key**             | Spend its ETH. Anchor bad or empty lists in each round: the nodes then must use `forceCommit` and `forceReveal`, which costs them gas (about 46k-48k each). Not anchor at all: the rounds cannot settle (lost rounds, the pot carries over) | Change any result: each settlement needs a valid proof. Take the pot: the payout goes to the proven winner. Freeze nodes wrongly | The admin revokes `ANCHOR_ROLE` from the key and grants it to a new key. Keep only a few days of gas on the key                                                              |
| **Succinct requester key** | Spend the PROVE balance on its own proofs                                                                                                                                                                                                   | Anything on chain                                                                                                                | Withdraw or stop the balance; make a new requester key. Keep only a few days of PROVE on it                                                                                  |
| **Bee node wallet**        | Spend its BZZ and gas. Upload junk with the batch: in a mutable batch this pushes out our anchored commit and reveal lists and snapshots                                                                                                    | Change results. The lists and snapshots are checked against hashes on chain, so junk is detected                                 | Make a new Bee wallet and batch. Lost round data: those rounds are skipped. The postage state can be rebuilt from the chain (section 5 of ZK-SETTLEMENT.md)                  |
| **Admin key**              | `setVerifier` to a verifier that accepts anything: then any result, and the pot, can be stolen. Revoke the prover. Pause                                                                                                                    | —                                                                                                                                | This is the critical key. On mainnet: a multisig and a timelock with an exit window, so that a bad change can be seen before it takes effect (open item in ZK-SETTLEMENT.md) |

The prover key and the requester key are hot keys on an internet-facing server. Thus they will be
attacked. The design limits the damage: neither key can change a result or take the pot. The worst case
is a few lost rounds and the funds that are on the keys.

---

## 4. Costs

### 4.1 Gas for each round (measured on Sepolia)

Sepolia charges more than Ethereum mainnet for a new storage slot (about 110k gas). The values below use
the round ring with warmed entries, so they include almost no new-slot writes. Mainnet values are
probably the same or a little lower.

| Transaction                                          | Gas               | Notes                                                                                                          |
| ---------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------- |
| `anchorRound`                                        | 49,256            | Each round                                                                                                     |
| `anchorReveals`                                      | 48,647            | Each round                                                                                                     |
| `settleRound`, a round with a winner                 | 676,474           | Includes about 270k for the Groth16 proof check, stake reads, freezes, payout, price adjustment, postage state |
| `settleRound`, a round without a game (postage only) | about 487,000     | Measured before the ring; an estimate                                                                          |
| `settleRound`, the first after deployment            | 1,177,573         | New storage, once                                                                                              |
| **Total for a typical round**                        | **about 775,000** |                                                                                                                |
| **Total for each day (112.5 rounds)**                | **about 87M**     |                                                                                                                |

ETH for each day and each year, for some gas prices:

| Gas price | ETH per day | ETH per year |
| --------- | ----------- | ------------ |
| 0.5 gwei  | 0.044       | 16           |
| 1 gwei    | 0.087       | 32           |
| 5 gwei    | 0.44        | 159          |
| 20 gwei   | 1.74        | 636          |

The largest part is `settleRound`, and most of that is the proof check. Item 3 of the optimization
plan (one proof for an epoch of K rounds) divides the proof check by K.

One-time and occasional gas:

| Transaction                 | Gas                                                                             | When                                                                           |
| --------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Deploy Settlement           | about 29M (Sepolia)                                                             | Once                                                                           |
| `warmRing`                  | about 663k for each entry on Sepolia: about 170M for all 256 entries (in parts) | Once, optional. Without it, each entry pays the new-slot cost on its first use |
| Grant roles, set parameters | about 130k each                                                                 | Once                                                                           |

### 4.2 Proofs

| Where                       | Price                                                                                                                                        | Time to proof                                                  | Notes                                                |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------- |
| **Succinct Prover Network** | Base fee about 0.40 PROVE, plus at most 0.75 PROVE per billion PGU. A round now uses 1M-10M PGU, so **about 0.40-0.41 PROVE for each proof** | 26-63 s (Sepolia rounds), 52 s (a full Gnosis-size settlement) | The base fee is almost all of the price              |
| Own GPU (`SP1_PROVER=cuda`) | The rent of one machine with an NVIDIA GPU (24 GB or more), all the time                                                                     | About 10-30 s (estimate, not measured)                         | Fixed price, does not depend on the number of proofs |
| Own CPU                     | —                                                                                                                                            | Minutes to tens of minutes                                     | Too slow for each round                              |

For each day: 112.5 proofs × 0.40 PROVE = **about 45 PROVE**. For each year: about 16,400 PROVE.

### 4.3 Swarm (data layer)

One mutable batch of depth 20 (about 1M chunks; holds more than a year of anchored commit and reveal lists and postage snapshots
before old data is overwritten). Uploads: about 2 chunks for each list, 2 lists for each round, and one
snapshot of about 3.5 MB (about 900 chunks) each day.

| Item                           | Cost at today's Gnosis price (198,291 PLUR per chunk per block, 5 s blocks) |
| ------------------------------ | --------------------------------------------------------------------------- |
| Batch, depth 20, for each day  | about 0.36 BZZ                                                              |
| Batch, depth 20, for each year | about 131 BZZ                                                               |
| Buy and each top-up            | One transaction on the postage chain (gas)                                  |

`swarm-prover stamp buy --dry-run` prints the exact amount for the current price.

### 4.4 Income

`settleRound` pays `proverFeeBps` (default 1%) of the payout to the proof's `feeRecipient`, only in rounds
with a winner.
On Gnosis today the pot of one round (152 blocks, about the length of a 64-block round on Ethereum) is
about 24 BZZ, so the fee is about 0.24 BZZ for each round with a winner, at most about 27 BZZ each day.

### 4.5 Summary for each day

| Cost                     | Quantity for each day                         |
| ------------------------ | --------------------------------------------- |
| Gas (prover key)         | about 87M gas (0.087 ETH at 1 gwei)           |
| Proofs (requester key)   | about 45 PROVE (Succinct), or one GPU machine |
| Swarm batch (Bee wallet) | about 0.36 BZZ                                |
| Income (fee)             | up to about 27 BZZ                            |

Whether the fee covers the costs depends on the prices of ETH, PROVE and BZZ. This is the "fee model"
open item in ZK-SETTLEMENT.md. The two largest costs, gas for `settleRound` and the proof base fee, are
both for each settlement. Thus one proof for an epoch of several rounds (optimization item 3) reduces
both.

---

## 5. How much each wallet must hold

Keep a buffer of some days on each hot wallet, and top it up from a cold wallet. A small balance limits
the loss if a key is compromised (section 3).

| Wallet             | Suggested balance                                                                                                                    | For                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| Prover key         | 7 days of gas at the highest gas price you accept. At 5 gwei: about 3 ETH. At 1 gwei: about 0.6 ETH                                  | Anchors and settlements                  |
| Succinct requester | 7 days of proofs: about 315 PROVE                                                                                                    | Proof requests                           |
| Bee node wallet    | The batch (for example 30 days: about 11 BZZ at depth 20) plus one or two top-ups, and gas for 3-4 transactions on the postage chain | Buy and top up the batch                 |
| Fee destination    | —                                                                                                                                    | Receives the fees that the prover sweeps |

Watch these balances. If the prover key runs out of gas, rounds are not anchored and cannot settle. If
the requester runs out of PROVE, rounds wait until their seed is too old (about 27 hours) and are then
lost. If the batch expires, uploads stop; the rounds still settle, but other provers cannot get the anchored commit and reveal lists.

---

## 6. Succinct Prover Network or our own prover?

**What changes with Succinct, and what does not.** On the Succinct Prover Network, each proof request
goes to an auction, and the prover that wins it computes the proof. Different GPU operators prove our
rounds. But the proof is checked on chain, so its correctness never depends on who computed it. The
role that is still central is ours: the service that collects the messages, anchors the lists, builds
the input and calls `settleRound`.

|                         | Succinct Prover Network                                   | Own GPU                                                      |
| ----------------------- | --------------------------------------------------------- | ------------------------------------------------------------ |
| Who computes the proof  | Many independent operators, by auction                    | Us                                                           |
| Correctness             | Checked on chain (the same)                               | Checked on chain (the same)                                  |
| Availability of proving | High: many operators; no single machine                   | One machine: a failure stops proving until it is repaired    |
| Cost                    | About 0.40 PROVE for each proof (about 45 PROVE each day) | A fixed rent, all the time                                   |
| Operations              | None: a key with a balance                                | A GPU server, its drivers, the 7.8 GB Groth16 files, updates |
| Dependency              | Succinct's network and the PROVE token                    | Only our own hardware                                        |
| Speed                   | 26-63 s measured                                          | 10-30 s estimated                                            |

**Decentralization.** Succinct decentralizes the hardware, not the protocol role. The steps that make
the role itself decentralized are:

1. `settleRound` is already open to everybody: any party with a valid proof can settle.
2. Publish the anchored commit and reveal lists and the postage state (the Swarm data layer, now built), so that any party
   can build the input of a round without our files.
3. Grant `ANCHOR_ROLE` to more than one operator (for example the Foundation and some large node
   operators), or replace it with a bonded, open role later.

With these, several independent operators can run the prover service, and each one can choose Succinct
or its own GPU.

**Recommendation.** Use the Succinct Prover Network as the main prover: it needs no hardware, it is
available, and at about 0.40 PROVE for each proof the price is predictable. Keep a GPU setup ready as a
fallback (prover/README.md, "Run the prover on a rented GPU"), because the network is an external
dependency. Then work on items 2 and 3 above, which decentralize the role, not only the hardware.

---

## 7. Setup checklist

1. Make the keys of section 2. Fund them as in section 5.
2. Deploy, or ask the admin to grant `ANCHOR_ROLE` to the prover key.
3. Run a Bee node for the data layer. Buy the batch:

   ```bash
   swarm-prover stamp buy --depth 20 --days 30 --dry-run   # prints the price
   swarm-prover stamp buy --depth 20 --days 30             # buys; prints SWARM_BATCH_ID
   ```

4. Start the prover with the data layer on:

   ```bash
   SWARM_API=http://localhost:1633 SWARM_BATCH_ID=<id> SWARM_TOPUP_DAYS=30 \
     SP1_PROVER=network NETWORK_PRIVATE_KEY=... PROVER_PRIVATE_KEY=... swarm-prover serve
   ```

   Without `SWARM_API` and `SWARM_BATCH_ID`, the prover uploads nothing, and `dataRef` is the keccak256
   of each document. Everything else works the same.

5. Watch: the prover key's ETH, the requester's PROVE, the batch (`swarm-prover stamp status`), and the
   log lines `anchored`, `settled` and `postage snapshot uploaded`.
