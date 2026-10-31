# ZK-Redistribution — the game off chain, settlement on chain

**Status:** draft proposal, for discussion. Nothing here is implemented.
**Scope:** how Swarm could keep postage and staking on chain, move the whole redistribution
game off chain, and settle a round with a single verified proof.

---

## Summary

Swarm asks a blockchain to do a job blockchains are bad at. Every round, every participating
node sends five transactions so that a smart contract can re-run a sampling game the node
already ran locally. The contract does the arithmetic a second time, in the most expensive
execution environment we have access to, and pays out.

This proposal keeps the economics exactly as they are and changes only _where the computation
happens_:

- **Postage stays on chain.** Batches are bought, priced, topped up and expired by
  `PostageStamp`, exactly as today. The pot accumulates there.
- **Staking stays on chain.** `StakeRegistry` holds stake, overlays, heights, freezes and
  slashes, exactly as today.
- **Redistribution moves off chain.** Commit, reveal, stamp commit, stamp reveal, witness
  verification, truth selection, weighting and the payout split are computed by the nodes
  themselves, off chain, with no transactions.
- **One on-chain function settles the round.** A succinct proof is submitted saying _"under the
  protocol rules, given this canonical input set and this chain-supplied randomness, these are
  the winners, these are their weights, and these nodes are frozen."_ The contract verifies the
  proof and pays.

The result for a node operator: **you stake, you store, you play. You never send a transaction.**

The result for the protocol: the per-round on-chain cost stops scaling with the number of
participants. Today a fully subscribed round is up to 161 transactions (32 participants × 5,
plus one claim), roughly 18,000 transactions a day at 152-block rounds. Under this proposal it
is one or two transactions per round — around 120 to 230 a day. That is a ~100× reduction, and
more importantly it is a change of _shape_: from `O(participants)` to `O(rounds)`.

This is not a speculative architecture. Lighter runs an order book this way in production today —
off-chain matching, validity proofs, Ethereum holding the state root — and Derive V3 is migrating an
options exchange from an optimistic L2 to exactly this design, with proof verification costing a
flat ~400–500k gas per batch regardless of how much is in it. Section 8 looks at what they do about
the hard parts, and adopts their answer to ours.

It is also the same architectural move Ethereum is making for its own L1: stop having everyone
re-execute, have one party execute and prove, and have everyone verify the proof. Swarm is
unusually well positioned to make it, because the pieces it needs — a deterministic input set, a
cryptographic evidence scheme, and a data layer to publish evidence to — are the things SWIP-049,
SWIP-050 and Swarm itself already are.

---

## 1. The problem, stated plainly

The current design is not failing because anyone designed it badly. It is failing because it is
being pushed past what the EVM is for. The symptoms are all in the open review of SWIP-049 and
SWIP-050:

**It does not fit in a contract.** STS-1 inlined exceeds the EIP-170 contract size limit.
Witness verification and Q64.64 fixed-point maths had to be moved into a deployed library to make
the code deployable at all. We are doing cube roots in Solidity.

**It does not fit in a block.** The `pendingCompletion` path is unbounded; enough accumulated
entries and a claim runs out of gas. Every loop in the contract is a future gas ceiling waiting to
be hit.

**It punishes nodes for the chain's problems, not for storage problems.** STS-1 needs five
sequential transactions per node per round, each in its own narrow window. Miss one — a
reorg, a spiked gas price, a stuck nonce, an RPC hiccup — and the node is frozen for
`152 * 2^depth` blocks. At depth 16 that is a very long time to be punished for a mempool.
The protocol is meant to test whether you hold the data. It currently also tests whether your
Ethereum client had a good afternoon.

**Nobody is paid to finish the round.** `claim()` is permissionless, but once the pot splits N
ways, no single participant wants to pay its gas. The current answer is `suggestedClaimant()` — a
non-binding social convention about who goes first. That is a placeholder, and everyone involved
knows it.

**The cost is a tax on participation.** Every node pays gas to play, whether or not it wins a
share. As transaction costs rise, the marginal node — the small, honest, geographically awkward
node that we most want in the network — is the first to stop playing. We are pricing out exactly
the participants that make the network worth having.

None of these are bugs to be fixed one at a time. They are five readings of one fact: **the EVM is
being used as the execution engine for a distributed storage game, and it is the wrong engine.**

---

## 2. The proposal in one picture

```
                         SETTLEMENT CHAIN
             ┌───────────────────────────────────────┐
             │                                       │
             │   PostageStamp        StakeRegistry   │   (unchanged)
             │   batches, pot        stake, freeze   │
             │        ▲                    ▲         │
             │        └─────────┬──────────┘         │
             │                  │                    │
             │          settleRound(proof)           │   (the one new function)
             │          ├─ verify proof              │
             │          ├─ withdrawShares(...)       │
             │          ├─ freezeDeposit(...)        │
             │          └─ adjustPrice(...)          │
             │                  ▲                    │
             └──────────────────┼────────────────────┘
                                │
                        ONE TX PER ROUND
                                │
                         proof + public inputs
                                │
                      ┌─────────┴─────────┐
                      │    ZK PROVER      │   (permissionless, paid from the pot)
                      └─────────▲─────────┘
                                │
                   ┌────────────┴────────────┐
                   │  REDISTRIBUTION VM      │   deterministic state machine
                   │                         │   — the rules, unchanged
                   │  commit / reveal        │
                   │  stamp commit / reveal  │
                   │  STS-1 witness checks   │
                   │  truth selection        │
                   │  weighting, payout      │
                   │  freezes, price         │
                   └────────────▲────────────┘
                                │
                        signed game messages
                                │
                   ┌────────────┴────────────┐
                   │       SWARM ITSELF      │   as the data availability layer
                   └────────────▲────────────┘
                                │
                            BEE NODES
                     storage · sampling · signing
```

The chain becomes a **referee**, not a **computer**.

---

## 3. What stays on chain — three surfaces

The user-visible on-chain surface reduces to three things. Two of them already exist and do not
change.

### 3.1 PostageStamp — unchanged

`createBatch`, `topUp`, `increaseDepth`, `expireLimited`, `setPrice`, `totalPot`,
`withdrawShares`. Uploaders buy storage on chain, exactly as today. The pot accrues there,
exactly as today. This is the one place where value genuinely enters the system from outside, so
it belongs on chain and should stay there.

SWIP-049 is doing something for this proposal that it was not designed to do, and it is worth
saying out loud. By fixing the eligible batch and index set at `samplingStartBlock(r)` and
exposing `redistributionBatchAt` and `redistributionMinimumNormalisedBalance` as reads against
that block, SWIP-049 gives us **a deterministic, chain-attested postage state for a round**.
A validity proof needs exactly that: an unambiguous answer to "which postage state did the prover
use?". SWIP-049 already eliminates that entire class of ambiguity. It is, accidentally, the
state-freezing mechanism a proof system requires.

### 3.2 StakeRegistry — unchanged

`manageStake`, `withdrawFromStake`, `freezeDeposit`, `slashDeposit`, and the overlay/height reads.
Stake is real money at risk, so it lives on chain and is only moved by the chain. The settlement
function is the only caller permitted to freeze or slash, exactly as `Redistribution` is today.

### 3.3 settleRound — the one new function

This replaces `commit`, `reveal`, `commitStampSampleHash`, `revealStampSampleHash`,
`submitStsProof` and `claim`. All six. With one call, once per round, from anybody.

```solidity
function settleRound(
  uint64 roundNumber,
  bytes32 prevStateRoot, // redistribution state at end of round r-1
  bytes32 newStateRoot, // redistribution state at end of round r
  bytes32 inputRoot, // canonical set of this round's participant messages
  address[] calldata beneficiaries,
  uint256[] calldata weights, // effectiveStakeDensity per winner
  address[] calldata toFreeze,
  uint256[] calldata freezeDurations,
  uint16 redundancy, // for the oracle
  bytes calldata proof
) external;
```

and its body is, in full:

1. check `roundNumber` is the round being settled and `prevStateRoot` is the stored root;
2. recompute the round's anchors and seeds **from the chain's own history** — not from anything
   the submitter supplied;
3. `verifier.verify(proof, publicInputs)` — one succinct verification, constant cost;
4. `postageStamp.withdrawShares(beneficiaries, weights)`;
5. `stakeRegistry.freezeDeposit(...)` for each frozen node;
6. `priceOracle.adjustPrice(redundancy)`;
7. store `newStateRoot`;
8. pay the submitter a bounty from the pot.

That is the entire redistribution contract. No sampling. No Merkle proof verification. No
proximity arithmetic. No Q64.64 cube roots. No `pendingCompletion` array. No EIP-170 problem,
because there is almost nothing left to deploy.

---

## 4. What moves off chain

Everything in the middle. The rules do not change; the venue does.

| Today, in Solidity                      | Tomorrow, in the Redistribution VM    |
| --------------------------------------- | ------------------------------------- |
| `commit` (tx per node)                  | signed message, gossiped              |
| `reveal` (tx per node)                  | signed message, gossiped              |
| `commitStampSampleHash` (tx per node)   | signed message, gossiped              |
| `revealStampSampleHash` (tx per node)   | signed message, gossiped              |
| `submitStsProof` (tx per node)          | witness published to Swarm            |
| proximity / depth eligibility           | circuit constraint                    |
| commit-reveal binding                   | circuit constraint                    |
| STS-1 witness verification              | circuit constraint                    |
| stamp density, utilization coefficients | circuit arithmetic (cheap, off chain) |
| truth selection (weighted draw)         | circuit arithmetic                    |
| payout weights                          | circuit output, checked on chain      |
| freeze determination                    | circuit output, checked on chain      |
| price/redundancy calculation            | circuit output, checked on chain      |

A node's round becomes: sample locally, sign four short messages, publish one witness, and — if
it is on the truth — receive BZZ. No wallet interaction, no gas, no nonce management, no
transaction timing risk.

---

## 5. What the proof actually proves

This is the part worth being precise about, because "we'll ZK it" is not a design.

The proof is **not** "the EVM correctly executed the Redistribution contract". That is the zkEVM
framing, and it is the wrong one here: we would be paying to prove EVM machinery — stack, gas
metering, storage slots — that we have no interest in. It is proving the wrong thing at great
expense.

The proof is a **Swarm-specific state transition statement**:

> Given the previous redistribution state, the postage state frozen at `samplingStartBlock(r)`,
> the stake state, the round's chain-supplied randomness, and the canonical set of participant
> messages committed to by `inputRoot`, the protocol rules of STS-1 produce exactly this new
> state, these beneficiaries, these weights, and these freezes.

**Public inputs** (the chain sees and checks these):

```
roundNumber
prevStateRoot
newStateRoot
inputRoot
postageStateRoot        @ samplingStartBlock(r)
stakeStateRoot
roundAnchor             derived on chain
challengeSeed           derived on chain
selectionSeed           derived on chain
beneficiaries[], weights[]
toFreeze[], freezeDurations[]
redundancy
```

**Private witness** (the prover has these; the chain never sees them):

```
every participant's commit, reveal, stamp commit, stamp reveal
every participant's signature
the three opened STS-1 stamp witnesses per participant
chunk transform Merkle proofs
per-participant stake, overlay, height with Merkle proofs into stakeStateRoot
per-stamp batch data with Merkle proofs into postageStateRoot
```

**What the circuit enforces** — and note that every line here is a rule that already exists in
`Redistribution.sol` today, simply relocated:

- each message carries a valid signature from a staked node, bound to `roundNumber`;
- `H(overlay, depth, chunkSampleHash, chunkTransformRoot, nonce) == committedHash`;
- `inProximity(overlay, anchor, depth - height)`;
- `depth > height`;
- the node has been staked for two rounds;
- each opened stamp witness verifies against the committed stamp sample, is strictly ordered
  against its neighbours, falls within `stampSampleMaxValue`, and its batch was live and
  sufficiently funded at `samplingStartBlock(r)`;
- `bucketDepth >= claimedDepth`;
- the chunk transform Merkle proof verifies against the committed root;
- coefficients are computed as specified and capped at 32× each;
- the stake-weighted draw over proof-validated entries, seeded by `selectionSeed`, selects the
  stated Schelling point;
- the payout weights are the `effectiveStakeDensity` of every proof-validated entry matching it;
- the freezes are exactly the ones the rules require, at the depth the rules require.

The circuit is not smarter than the contract. It is the _same rules_, in a place where running
them costs a fraction of a cent instead of several dollars, and where a cube root is just a cube
root.

---

## 6. Randomness — where it comes from, and why this is an improvement

The single most important constraint: **the prover must never influence the randomness.** If the
prover can choose the seed, it grinds seeds until it wins, and the whole design collapses.

So: all three randomness roles — the round anchor, the challenge seed that picks which stamp
positions get opened, and the selection seed for the weighted draw — are derived by the _contract_
from block randomness at fixed, pre-announced block heights. They are public inputs to the proof.
The prover computes with them. It cannot choose them, and the contract recomputes them
independently before verifying, so a lie about them fails on the first check.

This is worth noticing: **it is strictly better than what we have now.**

Today the stamp anchor is fixed by whoever reveals first, from `prevrandao` at a block of their
choosing inside the reveal window. The residual, accepted in review, is that the first revealer
can observe the resulting seed, decide they do not like it, withhold the transaction and try
again at the next block. It cannot invent a sample — that is already committed — but it can steer
a partly supported sample away from a weak position. Moving reveals off chain removes the lever
entirely: there is no "first revealer" whose transaction timing sets a seed, because there are no
reveal transactions. The seed comes from a block height nobody chose.

A known, accepted, live weakness disappears as a side effect of the architecture. That is usually
a sign the architecture is right.

---

## 7. The four hard problems

A proposal that does not name its weak points is marketing. Here are ours, in order of how much
work they need. All four are solvable; two are genuinely interesting research.

### 7.1 Input completeness — can the prover leave me out?

**This is the central problem.** A validity proof proves that a computation over some input set
was correct. It does not, by itself, prove that the input set was _complete_. A malicious prover
can run a perfectly valid computation over a set that quietly excludes you, and the proof will
verify.

Three mitigations, layered:

**(a) A canonical input root, not a chosen one.** The input set must not be the prover's
selection. Participant messages are published to Swarm — content-addressed, redundant,
neighbourhood-replicated — and the input root is derived _deterministically_ from what is there
at the deadline, by a rule anyone can independently evaluate. The prover discovers the set; it
does not curate it.

**(b) Anchor the input root before the game resolves.** One small transaction per round posts
`inputRoot` at the end of the message window, before the challenge seed is known. This makes the
participant set final and public _before_ anybody can tell who benefits from excluding whom. A
censor must then censor blind. (This is the second of the "one or two transactions per round" —
it can also be folded into the previous round's settlement, at the cost of a slightly longer
pipeline.)

**(c) A forced-inclusion queue, and a circuit that must drain it.** This is the strongest of the
three, and it is borrowed wholesale from production rollups — see section 8. An earlier draft of
this document proposed only a complaint lane: prove you were excluded, slash a prover bond. That is
reactive and weak. It needs somebody to notice, somebody to adjudicate, and a bond large enough to
matter.

The better construction makes exclusion _structurally impossible to profit from_ rather than merely
punishable. A node that suspects censorship posts its signed message to an on-chain queue. The
settlement circuit is then constrained: **a proof for round `N+1` does not verify unless every queue
entry older than round `N`'s deadline appears in round `N`'s input set.** Completeness stops being
an assumption and becomes a checked constraint of the proof, expressed against a set the chain
itself holds.

The prover cannot route around it, because the thing it wants — the settlement bounty, every round,
forever — is downstream of draining the queue. Derive V3 uses exactly this coupling in a sharper
form: its sequencer must process the L1 action queue in order of submission, so it _cannot process
any deposits until pending withdrawals are processed first_. The profitable action is held hostage
to the censorable one. That is the trick worth stealing.

**(d) A takeover timeout.** If no valid proof appears for K rounds, anyone can take over proving;
and stake must always be withdrawable without prover cooperation. Lighter freezes normal operation
after 14 days of ignored forced transactions and lets users exit against the last settled state;
Derive lets anyone permissionlessly take over the sequencer after two weeks. Swarm's equivalent is
cheaper to build because there is no user collateral to unwind — only stake, which `StakeRegistry`
already releases on its own schedule.

**One honest asymmetry.** Forced inclusion works beautifully for a DEX because the censored item is
the user's own balance: a withdrawal is worth far more than the L1 gas to force it, so the escape
hatch is always economically rational to use. In Swarm the censored item is one node's share of one
round's pot, which may well be worth less than the transaction that forces it. Forced inclusion is
therefore available but individually irrational at the per-round level — nobody will pay to rescue a
single round.

That is survivable, and it changes the design rather than breaking it: the queue must not be scoped
to "my share of round N". A single forced entry should re-open the prover's obligation for a
_window_ of rounds, so that one node paying once repairs the censorship for everyone and for a
sustained period. Exclusion then has to be cheap for the victim to punish and expensive for the
prover to sustain — which is the correct shape.

Honest assessment: (a) still needs a precise, deterministic membership rule that two independent
implementations will agree on, and that remains the thing to design first. But (c) means a
membership rule that is merely _good_ is enough, rather than one that has to be perfect: the queue
is the backstop for whatever the rule misses.

### 7.2 Message ordering — how do we know your commit was on time?

Related, and easy to overlook. A commit is only binding if it was made _before_ the challenge
randomness was known. On chain, block ordering gives us that for free. Off chain, it does not
exist by default.

The clean answer is (b) above: anchor `inputRoot` on chain at a block height that precedes the
block the challenge seed is drawn from. Anything not in the anchored root does not play this
round, full stop. Ordering within the window stops mattering, because the only deadline that
matters is chain-enforced.

This is why we suggest two transactions per round rather than one. It buys chain-grade ordering
for the one thing that genuinely needs it, and it is still two transactions instead of 161.

### 7.3 Storage possession — ZK does not make data exist

A ZK proof proves a computation was performed correctly. It does not prove that the chunks are
still on your disk. Nothing about this proposal changes that, and any proposal claiming otherwise
is wrong.

But this is not a new problem and it is not our problem to solve — **STS-1 already solves it.**
The whole point of the sequenced chunk and stamp commitment scheme is to make it impossible to
fetch convenient chunks after seeing the challenge. That property lives in the _evidence scheme_,
not in where the evidence is checked.

So the division of labour is clean:

```
STS-1   defines what counts as valid evidence of storage
  VM    defines how evidence changes the game state
  ZK    proves the VM was run correctly on the real evidence
 chain  enforces the result
```

The witnesses do not get weaker by being verified off chain. They get verified by a prover instead
of by Solidity, and the proof carries the assertion that the verification passed.

### 7.4 Prover liveness and cost — who runs this, and what if nobody does?

**Nobody in particular runs it.** Proving is permissionless and paid. A slice of the pot becomes a
prover bounty, and the first valid proof for a round collects it. If prover A vanishes, prover B
takes the round. The protocol never depends on a named party, which is the only acceptable answer.

Cost is the open engineering question. Proving a round with dozens of participants, each with
stamp witnesses and Merkle proofs, is not free. Three things make it tractable:

- the work is embarrassingly parallel per participant, so per-participant proofs can be generated
  independently and then aggregated recursively;
- a round is 152 blocks, about 12.7 minutes — a generous proving budget by modern standards;
- if it is not enough, settlement moves from per-round to per-epoch: several rounds, one
  recursive proof, one transaction. The economics get _better_ with batching, not worse.

The _verification_ side is already a known quantity: Derive V3 reports a flat 400,000–500,000 gas per
batch whatever the batch contains (§8.3). A Swarm round would sit in that range too, which is roughly
a handful of today's `commit` transactions — in place of all 161 of them. What still needs measuring
is proving time and proving cost, not verification.

And if nobody proves a round? Nothing breaks and nothing is lost. The pot does not vanish — it
stays in `PostageStamp` and rolls into the next settlement. Unsettled rounds are the protocol
idling, not the protocol failing. Compare that to today, where a node that misses one of five
transactions is frozen for months.

---

## 8. What comparable systems do about this

None of the four problems in section 7 are unique to Swarm. Off-chain execution with on-chain
settlement is a solved-enough pattern that several systems run real money on it today, and they have
converged on a recognisable set of answers. Three are worth studying, because they bracket the
design space: one chose not to use proofs at all, and two chose exactly the architecture proposed
here.

### 8.1 Hyperliquid — the alternative architecture, and why not to take it

Hyperliquid did not move computation off chain and prove it. It built a purpose-made chain.
HyperCore is a bespoke Rust execution engine running a full central limit order book as native
state, under HyperBFT — a HotStuff-derived BFT consensus over a validator set, reaching around 0.2s
finality and very high order throughput. There is no proof anywhere; correctness rests on an honest
supermajority of validators.

**What transfers:** the case for an application-specific execution engine. Hyperliquid did not run
an order book inside a general VM, and its performance is the argument. That is the same reasoning
behind proving a Swarm-specific state transition rather than wrapping the existing Solidity contract
in a zkEVM (section 5).

**What does not transfer:** the trust model. With roughly 21–30 validators and the foundation
holding the large majority of stake early on, "honest supermajority" describes a small, identifiable
group. In March 2025 that became concrete: after a trader exploited the liquidation mechanism on the
low-liquidity JELLY market, validators convened and voted within minutes to delist it and settle the
market at a chosen price, nullifying the attacker's position. Whatever one thinks of the outcome —
and there is a real argument it was the least-bad response to an active exploit — it demonstrated
the actual shape of the trust model: a small set of parties can override the rules quickly and
without meaningful dissent.

The Swarm-equivalent would be a committee that can decide who won a round and whose stake gets
frozen. We should not want that, and the reason is not purity. Swarm's participants have stake
locked and face freezes measured in months at high depths; a trader on a perp DEX can withdraw and
walk away in seconds. **The weaker your exit, the stronger your trust model has to be.** Swarm's
exit is very weak, so its guarantees must be cryptographic rather than social.

### 8.2 Lighter — validity proofs over an app-specific engine, in production

Lighter is an application-specific zk-rollup whose only job is an order book. It splits into the
three roles this proposal also needs: a **sequencer** that orders inputs and runs the matching engine
off chain, a **prover** that proves the matching followed published rules, and **L1 contracts** that
hold collateral and the canonical state root. Matching, funding, risk checks and liquidations are
encoded in circuits, so Ethereum verifies that the operator behaved correctly before a state update
finalises — price-time priority is enforced at the proof level, not promised in a blog post.

Its censorship answers are the ones worth copying:

- **Forced transactions from L1.** Users can submit not only deposits and withdrawals but _orders
  and cancellations_ directly on Ethereum, bypassing the sequencer.
- **A deadline with teeth.** If operators ignore forced transactions for 14 days, the system enters
  "desert mode" and normal operation freezes.
- **Exit without cooperation.** In desert mode users reconstruct the last settled state and claim
  their assets on L1 against a zero-knowledge proof of funds.
- **Data availability on L1.** State diffs are published as Ethereum blobs, so anyone can rebuild
  state and take over proving.

That forced _orders_ — not just withdrawals — are in scope is the directly relevant precedent: an
order is Lighter's equivalent of our commit. Somebody has already decided this class of message
needs a forced lane.

Its residual weaknesses are instructive too. L2BEAT flags that Lighter's contracts are instantly
upgradable with no delay, so a malicious upgrade could take funds regardless of how good the
circuits are; and its custom Plonky2 circuits involve a trusted setup. Cryptography does not save
you from governance, which is why section 12 lists verifier upgradeability as an open item here.

### 8.3 Derive V3 — the same migration, one step ahead of us

Derive is the closest analogue, because it is making the exact move this document proposes, from the
exact starting point. V2 matched orders off chain and settled on Derive Chain, an optimistic L2. V3
keeps the off-chain matching and instead proves every state change inside a zkVM, verified on
Ethereum L1, with state diffs posted to Celestia for availability. An optimistic rollup with its own
chain is being replaced by off-chain execution plus validity proofs on L1 — the same direction, for
the same reasons.

The details that matter for us:

- **The operator is bounded, not trusted.** The sequencer orders operations into batches and submits
  proofs, but "cannot forge orders or extend margin beyond the contract parameters". Nothing is final
  until the zkVM proves the stream. Its power is reduced to _delay_.
- **The ordered queue with a hostage.** The sequencer must process the L1 action queue in order of
  submission, so it cannot process deposits until pending withdrawals are processed first. This is
  the construction adopted in section 7.1(c).
- **Permissionless takeover.** After a censorship period — initially two weeks — anyone can take over
  the sequencer and propose batches.
- **Flat verification cost.** Proof verification runs a roughly constant 400,000–500,000 gas per
  batch whether it contains one trade or a million.

That last number is the one to internalise. It is the empirical form of the claim in the summary:
settlement cost stops scaling with participation. For Swarm it means the on-chain cost of a round is
about the same whether four nodes play or four hundred — and it is roughly the gas of a handful of
today's `commit` transactions, replacing all 161 of them.

Derive is honest about what remains: the owner can replace the committed state root or verifying key
and upgrade contracts, with guardian powers over withdrawal throttling. Again — governance is the
residual, not cryptography.

### 8.4 The pattern, and what Swarm should take

All three converge on reducing the operator's power to _delay_, and then making delay
self-defeating. The layers, in order of strength:

| Layer | Mechanism                                                                    | Reduces operator to               | In this proposal          |
| ----- | ---------------------------------------------------------------------------- | --------------------------------- | ------------------------- |
| 1     | Signed intents                                                               | cannot forge, only omit           | §5, signatures in-circuit |
| 2     | Deterministic input set + on-chain anchor                                    | cannot curate quietly             | §7.1(a), §7.1(b)          |
| 3     | Forced-inclusion queue, drained in order, coupled to what the operator wants | cannot omit and keep earning      | §7.1(c)                   |
| 4     | Timeout → permissionless takeover / exit                                     | cannot make delay permanent       | §7.1(d), §7.4             |
| 5     | Published data availability                                                  | anyone can rebuild and replace it | Swarm itself              |

Two closing observations.

**Swarm has an advantage none of them have.** Lighter posts state diffs to Ethereum blobs; Derive
posts them to Celestia. Both are paying an external network to keep the data that makes their system
verifiable. Swarm _is_ that network. The data availability layer this design needs is the product
being incentivised — the redistribution game's own inputs become one more thing Swarm stores, and
the property that makes the game trustworthy is the property the game exists to reward. That is not
a slogan; it is a genuine structural saving, and it removes the external dependency that both
comparables carry.

**And the honest one:** every system in this class still has an upgrade key, and all of them are
weaker at governance than at cryptography. If Swarm builds this, the verifier's upgrade path
deserves at least as much design attention as the circuit — because on current evidence that, not
the proving system, is where this class of system actually breaks.

---

## 9. What does not change

Worth stating explicitly, because it is the reason this is a realistic migration rather than a
redesign:

- **The economics are identical.** Same sampling, same coefficients, same caps, same truth
  selection, same proportional split, same freeze table, same price oracle response.
- **STS-1 is not replaced.** It is the evidence scheme this is built around. SWIP-049 and
  SWIP-050 should be implemented and shipped as specified; this proposal builds on top of them,
  it does not compete with them.
- **No new consensus layer.** This is the most common misreading, so: there is no off-chain
  chain, no validator set, no finality gadget, no committee voting on state. There is a
  deterministic function, evidence published to a data layer, and a single settlement transaction.
  The blockchain remains the only source of consensus in the system. Everything off chain is
  computation, and computation is checked by a proof.
- **Node operators' obligations.** Stake, store, sample honestly. That is the job today and it is
  the job afterwards. We are removing an obligation — paying gas — not adding one.

---

## 10. Why this is the right direction, not just a possible one

Three arguments.

**First: Ethereum is making the same move, for the same reason.** The stated L1 roadmap is to stop
having every validator re-execute every block and instead have a prover execute and produce a
succinct proof that validators cheaply verify. PeerDAS is the same instinct applied to data: not
every node needs everything, provided the cryptography lets you verify what you sampled. Swarm has
believed the data half of this since inception — _not every node holds everything_ is literally
what a Kademlia reserve is. We have simply never applied the same reasoning to our own execution.
Aligning with the settlement layer's direction is not fashion-following; it means the tooling,
the proving systems, the verifier precompiles and the research all move toward us rather than away.

**Second: the alternative is a slow grind against limits that do not move.** Every future feature
gets harder. EIP-170 is a fixed ceiling and we are already under it by moving code into libraries.
Gas per claim grows with participants. Fixed-point maths in Solidity is expensive and awkward and
will stay both. Every design discussion becomes partly a conversation about contract size. Off
chain, none of these are constraints at all — not relaxed, _absent_. Cube roots are free.
Iterating over ten thousand entries is free. The design space reopens.

**Third: it makes participation cheap enough to be universal.** This is the real prize and it is
easy to undersell. Today a node's decision to play is a calculation involving gas price, expected
share, and the risk that a missed transaction costs it months of freeze. That calculation is
hostile to exactly the nodes we want most: small, honest, well-distributed, run by people who are
not watching a mempool. Remove the transactions and the calculation becomes: _do I have the data?_
Which is the only question the protocol was ever supposed to be asking.

There is a fourth, quieter benefit. Today's cost model effectively rules out settling on Ethereum
L1 — 18,000 transactions a day is not an L1 workload at any gas price. One or two transactions a
round is. This proposal does not require moving the settlement chain, but for the first time it
makes the choice open rather than foreclosed, and it lets that choice be made on security and
where BZZ lives rather than on the gas bill of a sampling game.

---

## 11. Migration path

Deliberately incremental. Every phase is independently useful and independently abandonable.

**Phase 0 — ship STS-1 as specified.** No change to current plans. SWIP-049 and SWIP-050 land on
chain as designed. This proposal needs them implemented and the rules pinned down; it does not
need them changed.

**Phase 1 — the deterministic VM.** Extract the redistribution state transition into a
standalone, deterministic implementation with no EVM dependency. Pure function: state, inputs,
randomness in; new state, payouts, freezes out. This is valuable on its own — it becomes the
executable specification the contract is tested against, and a second implementation for client
interop (see scrutiny item 2.9).

**Phase 2 — shadow mode.** Run the VM alongside the live on-chain game, on real round data,
settling nothing. Every round produces two answers, and they must match. Any divergence is a bug
found for free, with no money at stake. Run for months. This phase is where confidence is built,
and it costs nothing but compute.

**Phase 3 — prove the game logic.** Circuit for everything except the storage witnesses:
signatures, commit-reveal binding, eligibility, truth selection, weighting, freezes. Verified on a
testnet against shadow-mode output.

**Phase 4 — prove the witnesses.** Bring STS-1 witness verification and the chunk transform Merkle
proofs into the circuit. This is the engineering-heavy part, and doing it after phase 3 means it is
the only unknown left.

**Phase 5 — canonical settlement.** Deploy `settleRound`. Retire the six on-chain phases.

**Phase 6 — recursive aggregation.** Batch rounds into epochs, one proof each. Optional, purely an
optimisation.

**Phase 7 — and only now, revisit the protocol itself.** There is an open disagreement in the
SWIP-050 review about whether the second commit/reveal is necessary, or whether the scheme could
collapse to `commit → challenge → prove`. That question should _not_ be resolved by introducing
ZK. Settle cryptographic correctness first; consider protocol simplification afterwards, as a
separate decision with its own evidence. Mixing the two would make both harder to reason about.

---

## 12. What this document does not solve

Named honestly, so nobody thinks they are hidden:

- The deterministic input-root membership rule (§7.1a). This is the first thing to design.
- Concrete proving costs and times for realistic round sizes. Nobody should believe a number
  until somebody has measured one.
- Choice of proving system, and whether a general zkVM is fast enough or hand-written circuits are
  needed. Transparent setups (STARK-family) are preferable; a per-circuit trusted setup would be a
  poor fit for a protocol that expects to change its rules.
- Whether the settlement chain stays Gnosis or moves. Out of scope here, but newly an open
  question rather than a closed one.
- The depth-16 ceiling, the price-update guardrails, and the other live items in
  [SWIP-49-50-SCRUTINY.md](./SWIP-49-50-SCRUTINY.md). Those need answering regardless; this
  proposal neither fixes nor worsens them.
- The scoping of the forced-inclusion queue (§7.1c): how long one forced entry re-opens the
  prover's obligation, and how that window is priced so a victim pays once rather than every round.
- Verifier upgrade authority. This is the residual that actually bites comparable systems — L2BEAT's
  standing criticism of Lighter is instantly upgradable contracts with no exit window, and Derive's
  own risk accounting lists an owner who can replace the verifying key. Whatever Swarm builds needs
  a deliberate answer here: timelock, exit window, or a restricted upgrade path.
- What happens if a soundness bug is found in a proving system after deployment. A standard problem
  with standard answers, but it needs writing down.

---

## FAQ

**Do node operators still need gas?**
No. You need stake, disk and bandwidth. You do not need a funded wallet, you do not need to watch
gas prices, and you cannot be penalised for a transaction that failed to land — because you are
not sending any.

**Then who pays for the one transaction?**
The prover, who is reimbursed from the pot plus a bounty. The cost is spread across the whole
round's value instead of being charged to each participant individually, which is the correct
place for it: settling the round is a service to everyone, so everyone pays a sliver of it.

**What if nobody generates a proof?**
The round does not settle. The pot stays in `PostageStamp` and rolls into the next settlement —
nothing is destroyed. Proving is permissionless and paid, so a persistently unsettled round means
the bounty is too low, which is a parameter, not an architecture. Compare with today, where a
stalled round means nodes frozen for months.

**Can the prover steal the pot?**
No. The contract pays the beneficiaries named in the proof's public inputs, and the proof only
verifies if those beneficiaries are the ones the protocol rules produce. A prover submitting
itself as the winner produces a proof that fails verification. The prover's power is limited to
_whether_ a round settles, never _how_.

**Can the prover exclude me from a round?**
This is the hardest problem in the design and §7.1 treats it seriously. Four layers: the input set
is derived deterministically from Swarm rather than chosen by the prover; it is anchored on chain
before anyone knows who benefits from excluding whom; a node can post its signed message to an
on-chain forced-inclusion queue that the _next_ round's proof will not verify without draining, so a
censoring prover simply stops being able to earn; and if proving stalls entirely, anyone can take
over. Layer three is the important one, and it is copied from Lighter and Derive, which both run it
in production (§8). The remaining caveat is economic rather than cryptographic — see §7.1 on why a
forced entry must re-open a window of rounds rather than rescue a single one.

**Is the ZK proof proving that I still have the data?**
No, and be suspicious of anyone who says it is. ZK proves that a computation ran correctly.
Proving you hold the data is STS-1's job, and STS-1 keeps doing it — the same witnesses, the same
sequencing, the same guarantees. ZK proves the witnesses were checked honestly. Two different
jobs, both still done.

**Does this change how much I earn?**
No. Same weighting, same coefficients, same truth selection, same proportional split. What changes
is what you pay to participate, which goes to zero. Net income therefore goes _up_ for every
participant, most for the smallest.

**Is this just a rollup?**
Architecturally, it is the same pattern: execute off chain, prove, verify on chain. The difference
is that a rollup is a general execution environment that must prove arbitrary programs, while this
is one application's state machine with fixed rules. That makes it dramatically simpler: we prove
a known function, not an unknown one.

**Why not just run the existing Solidity contract inside a zkEVM?**
Because we would be proving EVM machinery — gas metering, stack operations, storage layout — that
exists only because we chose the EVM in the first place. It is the expensive way to prove the
wrong statement. A purpose-built state-transition circuit proves what we care about and nothing
else.

**Does Swarm need its own consensus mechanism for this?**
No, and this is the most important thing to get straight. There is no off-chain chain, no
validator set, no voting, no fork-choice rule. There is a deterministic function, evidence
published to a data layer, and one settlement transaction. The blockchain stays the sole authority
on what happened. If two provers compute the same round, they get the same answer, because the
function is deterministic and the inputs are pinned.

**What stops the prover from picking favourable randomness?**
The contract derives the anchor and both seeds itself, from block randomness at fixed heights, and
recomputes them before verifying. They are inputs to the prover, not outputs of it. This is
strictly stronger than the current design, where the first revealer can retry until it likes the
seed it sees.

**What happens to the price oracle?**
The redundancy calculation moves into the VM and is proved along with everything else. The
settlement function passes the proven value to `PriceOracle.adjustPrice`. The oracle's own logic
and cadence are unchanged.

**Does Bee have to change?**
Yes — Bee stops sending transactions and starts signing and gossiping messages, and it needs the
VM implementation. That is real work, comparable to the STS-1 client work already scoped in
[BEE-IMPACT-SWIP-49-50.md](./BEE-IMPACT-SWIP-49-50.md). But the _sampling_ work, which is the hard
part of STS-1 for clients, is the same work either way. The protocol rules a node implements do not
change; only the transport does, and transport is the easy half.

**How long would proving take? Would it fit in a round?**
Unknown until measured, and nobody should accept an estimate in place of a measurement. The budget
is generous — 152 blocks, about 12.7 minutes — the work parallelises cleanly per participant, and
if it does not fit, epoch-based settlement removes the deadline entirely. This is a "needs
benchmarking" item, not a "might be impossible" item.

**Isn't this a lot of new cryptography to trust?**
Less than it looks. Validity proofs verifying on chain are production technology today, securing
billions across multiple live systems. The novel part here is not the proving system — we would
use an existing one — it is the circuit for our state transition, which is exactly the code path
phases 2 and 3 exist to test in shadow mode against the live game, for as long as it takes.

**What if a soundness bug is found in the proving system after we deploy?**
A real risk, shared with every system in this class, and it needs a written answer before mainnet:
verifier upgradeability, a pause path, and conservative limits on what a single settlement can
move. Section 12 lists it as open.

**Why do this now rather than after STS-1 ships?**
We are not proposing doing it instead. Phase 0 _is_ shipping STS-1. But the design work should
start now, because every constraint the STS-1 review keeps running into — contract size, gas
loops, fixed-point maths, five sequential transactions, nobody paid to call claim — is a symptom
of the same root cause, and it is worth knowing that a cure exists while we are still choosing
how to treat the symptoms.

**Is this a hard fork?**
For the incentive system, yes: settlement changes and clients must upgrade. For stored data,
uploads, postage batches and existing stake, no — those contracts are untouched. Users of Swarm
would not notice anything except that the network got cheaper to run.

**Has anyone actually built anything like this?**
Yes, with real money on it. Lighter is an application-specific zk-rollup running a perpetuals order
book: off-chain matching engine, ZK circuits proving that matching followed the rules including
price-time priority, Ethereum holding collateral and the state root. Derive V3 is migrating an
options exchange from an optimistic L2 to off-chain execution proven in a zkVM and verified on
Ethereum L1. Both had to solve our §7.1, and §8 adopts their answer. The novel part of this proposal
is the circuit for STS-1 — not the pattern around it, which is becoming standard.

**Why not just do what Hyperliquid did and build our own chain?**
It is a legitimate design and it performs superbly, but it buys speed with a trust assumption we can
afford less than a DEX can. Hyperliquid's correctness rests on an honest supermajority of a few
dozen validators; the JELLY episode in March 2025 showed that group voting within minutes to delist a
market and settle it at a chosen price. The Swarm equivalent is a committee that can decide who won a
round and whose stake is frozen. A trader who dislikes that can withdraw in seconds; a Swarm node has
stake locked and freezes measured in months. Weaker exit demands a stronger trust model, so we should
prefer proofs to a validator set. §8.1 has the longer version.

**Doesn't Swarm need an external data availability layer for this, like Celestia?**
No — and this is the nicest part. Lighter pays Ethereum for blobs and Derive pays Celestia, because
neither of them is a storage network. Swarm is. The game's inputs become one more thing Swarm stores,
which means the property that makes the game verifiable is the property the game exists to reward.
Neither comparable can do that, and it removes an external dependency both of them carry.

**What is the single biggest risk?**
Governance, not cryptography. Input completeness (§7.1) used to be the answer, and it is still the
thing to design first — but the forced-inclusion construction in §7.1(c) is a known, deployed
mechanism rather than an open research question, which downgrades it from "unsolved" to "needs
careful specification". What genuinely worries the comparable systems is upgrade authority: L2BEAT's
standing criticism of Lighter is instantly upgradable contracts, and Derive's own accounting lists an
owner who can replace the verifying key. A perfect circuit behind an unrestricted upgrade key is not
a secure system. That deserves as much design effort as the proof.
