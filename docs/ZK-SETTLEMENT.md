# ZK settlement: implementation (option 4)

Branch `feat/zk-settlement`. This is the working implementation of the proposal in
[ZK-REDISTRIBUTION.md](./ZK-REDISTRIBUTION.md) ("the game off chain, settlement on chain"), option 4 of
the Homecoming deck. It is built so it can be run end to end on Sepolia with simulated nodes.

**Status:** a prototype. The game logic (commit, reveal, eligibility, truth and winner selection,
freezes, redundancy for the price oracle) runs off chain and is proven with SP1. The storage evidence
that `claim` checks today (chunk inclusion proofs, stamp and SOC signatures, reserve size estimate) is
**not in the proof yet**. That is Phase 4 below. Do not read this as "storage is proven".

---

## 1. What changed compared with master

| Contract | Change | Why |
| --- | --- | --- |
| `PostageStamp.sol` | **none** | Settlement calls `withdraw(address(this))` with `REDISTRIBUTOR_ROLE` and splits the pot itself |
| `Staking.sol` (`StakeRegistry`) | **none** | Settlement calls `freezeDeposit` with `REDISTRIBUTOR_ROLE` and reads stake records with existing views |
| `PriceOracle.sol` | **none** | Settlement calls `adjustPrice(redundancy)` with `PRICE_UPDATER_ROLE`. The redundancy number comes out of the proof |
| `Redistribution.sol` | **not deployed** | Left in the tree untouched so master's tests still run. Settlement takes its three roles |
| `settlement/Settlement.sol` | **new**, ~400 lines | Anchors each round, keeps the censorship escape hatches, checks proof inputs against the chain, executes the outcome |
| `settlement/ISP1Verifier.sol` | new | Interface of the SP1 verifier |
| `settlement/SP1MockVerifier.sol` | new | Accepts empty proofs. Local and smoke testing only |

So "removing Redistribution and putting the game off chain" really is all it takes on the contract side.
The three contracts that hold value (pot, stake, price) are master's code, deployed as they are.

### New files

```
src/settlement/Settlement.sol          the one new contract
src/settlement/ISP1Verifier.sol
src/settlement/SP1MockVerifier.sol
test/Settlement.test.ts                contract tests (mock verifier)
deploy/zk/000_deploy_core.ts           token, postage, oracle, staking: master code, unchanged
deploy/zk/001_deploy_settlement.ts     verifier (mock or SP1 gateway) + Settlement
deploy/zk/002_roles_and_pot.ts         roles Redistribution had -> Settlement; price; one batch so the pot grows
scripts/zk/setup-nodes.ts              fund and stake simulated nodes
hardhat.config.ts                      networks zklocal (anvil) and sepoliazk, both use deploy/zk/
helper-hardhat-config.ts               sp1VerifierGateway for sepoliazk
prover/                                Rust workspace, see prover/README.md
  crates/vm/                           the Redistribution VM (game rules as a pure function) + tests
  program/                             the SP1 program (runs the VM, commits public values)
  service/src/main.rs                  swarm-prover: serve | vkey | execute
  service/src/settler.rs               anchor loop, settle loop, round input from chain state
  service/src/server.rs                HTTP API for nodes
  service/src/prover.rs                SP1 execute / prove
  service/src/store.rs                 per-round message store (stand-in for Swarm as DA)
  service/src/bin/node_sim.rs          simulated Bee nodes
docs/ZK-SETTLEMENT.md                  this file
docs/ZK-REDISTRIBUTION.md              the proposal (copied from docs/zk-redistribution-proposal)
```

---

## 2. Architecture

```
  Bee nodes (node-sim)                                     Ethereum / Sepolia
  ─────────────────────                                    ───────────────────────────────────────────
  sign commit ──POST /v1/commit──►┐                         PostageStamp   StakeRegistry   PriceOracle
  reveal      ──POST /v1/reveal──►│                              ▲  withdraw     ▲ freeze       ▲ adjustPrice
                                  │                              └───────┬───────┴──────────────┘
  (censored?) forceCommit / forceReveal ───────────────────────►  Settlement
                                  │                                ▲ anchorRound(commitsHash)   (1 tx/round)
                         swarm-prover (service)                    │ settleRound(pv, proof)     (1 tx/round)
                         ├─ store messages ───────────────────────┘
                         ├─ read chain: anchor, seed, forced events, stake records, game state
                         ├─ swarm-vm::run(input)       native, sanity check
                         └─ SP1: program(input) ─► Groth16 proof ─► settleRound
```

Two transactions per round for the whole network, instead of about three per participating node today.

### Round timing

`ROUND_LENGTH = 152` blocks, the same as Redistribution. On Sepolia and mainnet that is about 30 minutes.

| Blocks in round | Phase | What happens |
| --- | --- | --- |
| 0-37 | commit | Nodes sign commits and send them to a prover, or call `forceCommit` |
| 38-56 | anchor | The prover calls `anchorRound(round, commitsHash, count, dataRef)` once. `forceCommit` is still open, so a node that is missing from the anchored list can still get in |
| 57-113 | reveal | Nodes send reveals to the prover, or call `forceReveal` |
| 114 | seed block | Its block hash becomes the selection seed. Nobody chooses it |
| 115 onward | settle | Anyone with a valid proof calls `settleRound`. Rounds settle in increasing order |

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

Then `verifier.verifyProof(programVKey, publicValues, proof)`. Then it executes the outcome: freezes,
`adjustPrice(redundancy)`, withdraws the pot, pays `proverFeeBps` (default 1%) to the caller and the
rest to the winner.

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

**Storage possession.** Not proven yet (Phase 4). The winner is paid without the three chunk witnesses
that `claim` checks today.

**Prover liveness.** `settleRound` is permissionless. `anchorRound` is limited to `ANCHOR_ROLE` (the
Foundation's prover first, as the proposal says). If nobody settles, the pot stays in PostageStamp and
rolls over. A round can be skipped: rounds settle in increasing order, so settling round N+1 makes
round N unsettleable.

**Upgrade authority.** `setVerifier(verifier, programVKey)` is admin-only and instant. On mainnet it
must sit behind a timelock with an exit window. This is the residual risk L2BEAT flags in Lighter and
Derive.

**Data availability.** The anchored list is held by the prover (`data/rounds/<n>/messages.json`, served
at `/v1/rounds/{n}`). `anchorRound` already takes a `dataRef`. The next step is to upload the list to
Swarm and pass the reference there.

---

## 4. Measured so far

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

**zkVM cycles** (`swarm-prover synth` + `execute`; 80% honest, 10% liars, 10% silent):

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

---

## 5. Sepolia runbook

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

# 4. Prover
cd prover
export RPC_URL=<sepolia rpc> SETTLEMENT_ADDRESS=$(jq -r .address ../deployments/sepoliazk/Settlement.json)
SP1_PROVER=network NETWORK_PRIVATE_KEY=0x.. PROVER_PRIVATE_KEY=0x.. DATA_DIR=data/sepolia \
  ./target/release/swarm-prover serve

# 5. Nodes
NODE_KEYS=0x..,0x.. ./target/release/node-sim --depth 1 --silent 3 --liar 4 --forced 2
```

On Sepolia the selection seed is available for 8191 blocks (about 27 hours) through EIP-2935, so a slow
prover still settles.

---

## 6. Migration phases, and where this branch is

Phases are from [ZK-REDISTRIBUTION.md §11](./ZK-REDISTRIBUTION.md).

| Phase | | State |
| --- | --- | --- |
| 1 | Deterministic VM, no EVM dependency | **Done** for master's rules (`crates/vm`) |
| 2 | Shadow mode: VM against live Gnosis rounds | Not started. Needs a replay tool that turns `Committed`/`Revealed` events into a `RoundInput` |
| 3 | Prove the game logic | **Done** (SP1 program, Settlement, Sepolia setup) |
| 4 | Prove the storage witnesses | **Next.** Port `claim`'s checks (`BMTChunk`, `TransformedBMTChunk`, `Signatures.postageVerify` / `socVerify`, `estimateSize`) into the VM. Postage batch data needs the same treatment as stakes: read on chain at settle time, or Ethereum storage proofs inside the zkVM |
| 5 | Canonical settlement, retire on-chain phases | This branch's deployment shape |
| 6 | Recursive aggregation | Not started |

### Open items (in priority order)

1. Phase 4: storage witnesses in the proof.
2. Timelock or exit window on `setVerifier`.
3. Swarm as the data layer: upload the anchored list and pass the reference as `dataRef`.
4. Forced-inclusion scoping across several rounds (§7.1c of the proposal).
5. Bee integration: the commit and reveal messages, the HTTP API (or Swarm feeds), and when to fall back
   to `forceCommit`/`forceReveal`.
6. Nodes don't know the minimum depth for round N+1 until round N is settled. Settling within the round
   (blocks 115-151) avoids that, but needs fast proving.
