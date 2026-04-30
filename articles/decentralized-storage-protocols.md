# Decentralized Storage Protocols: A Technical Comparison

> A neutral, technical survey of the five most consequential decentralized storage protocols in production today: **IPFS**, **Filecoin**, **Swarm**, **Arweave**, and **Walrus**. The goal is to describe how each one actually works, what design trade-offs it makes, where it is strong, where it is fragile, and which use cases it fits best. No protocol is presented as the "winner" — each occupies a distinct corner of the design space.

---

## Table of contents

- [1. Introduction](#1-introduction)
- [2. The comparison framework](#2-the-comparison-framework)
- [3. IPFS](#3-ipfs)
- [4. Filecoin](#4-filecoin)
- [5. Swarm](#5-swarm)
- [6. Arweave](#6-arweave)
- [7. Walrus](#7-walrus)
- [8. Cross-cutting deep dives](#8-cross-cutting-deep-dives)
  - [8.1 Content addressing](#81-content-addressing)
  - [8.2 Storage proofs](#82-storage-proofs)
  - [8.3 Erasure coding](#83-erasure-coding)
  - [8.4 Mutability primitives](#84-mutability-primitives)
  - [8.5 Smart-contract integration](#85-smart-contract-integration)
  - [8.6 Browser participation](#86-browser-participation)
  - [8.7 Censorship resistance](#87-censorship-resistance)
- [9. Side-by-side comparison matrices](#9-side-by-side-comparison-matrices)
- [10. Use-case selection guide](#10-use-case-selection-guide)
- [11. Open challenges in the space](#11-open-challenges-in-the-space)
- [12. Conclusion: five different bets](#12-conclusion-five-different-bets)

---

## 1. Introduction

A "decentralized storage protocol" usually means one of two things:

1. A **content-addressing primitive** that lets anyone refer to a piece of data by a hash of its content rather than by a server-bound URL.
2. A **storage marketplace or network** that arranges for that content to be physically held by some set of unrelated parties, ideally without any single one of them being indispensable.

Different protocols emphasise different parts of this. IPFS is almost entirely (1) and lets you build (2) however you like. Filecoin is (2) layered on top of IPFS-compatible (1). Swarm, Arweave and Walrus each try to do (1) and (2) together as a single coherent system, and they each make very different choices about how persistence, payment, and replication should work.

This article goes deep into each of the five, covers a number of cross-cutting topics that recur across all of them (storage proofs, erasure coding, mutability, browser participation, censorship resistance), and ends with a use-case-driven decision guide. It assumes the reader is comfortable with cryptographic basics (hashes, signatures, public/private keys), distributed-systems concepts (kademlia DHT, BFT, replication), and blockchain fundamentals.

### What is *not* covered

- Centralised "decentralized-branded" services (S3-compatible APIs over a single operator).
- Encryption schemes layered on top of any of these (broadly compatible with all five; orthogonal).
- Specific tooling tutorials.
- Token-economic price predictions.

---

## 2. The comparison framework

To compare these five honestly, it helps to define the dimensions explicitly.

### 2.1 Storage duration model

What does it mean to "upload"? The answer differs:

- **Best-effort caching** — your local node has the data and advertises it; nobody else is obligated. (IPFS by default.)
- **Per-deal rental** — a storage provider has signed a time-bounded contract to keep the data and prove it periodically. (Filecoin.)
- **Stamped-and-distributed obligation** — chunks are routed deterministically to a neighbourhood of nodes that are obligated to store them as long as the upload's payment lasts. (Swarm.)
- **Endowment-funded permanence** — pay once into an endowment whose ongoing returns are designed to keep miners paid forever. (Arweave.)
- **Per-epoch erasure-coded slivers** — each blob is split into many slivers, distributed across many nodes, and renewed each epoch. (Walrus.)

### 2.2 Payment model

Who pays whom, when, and in what currency:

- IPFS: nobody at the protocol level; pay a SaaS pinning service if you want persistence.
- Filecoin: payer-to-SP per deal in FIL (with verified-deal subsidies).
- Swarm: payer-to-network upfront in BZZ on Gnosis Chain, distributed to storers via a redistribution lottery.
- Arweave: payer-to-network one-time in AR; small fraction to current miners, rest to endowment.
- Walrus: payer-to-network per epoch in WAL on Sui.

### 2.3 Cryptographic storage proof

How (and whether) the network proves that data is being stored:

- IPFS: no proofs.
- Filecoin: Proof of Replication (sealing) plus continuous Proof of Spacetime; the strongest cryptographic story available.
- Swarm: sampling-based proofs in the redistribution lottery; storers occasionally prove they have a fragment of their reserve.
- Arweave: Proof of Access — to mine a block, miners must prove access to a randomly selected past block.
- Walrus: per-epoch attestations from storage nodes under a BFT model.

### 2.4 Replication model

How redundancy is achieved:

- Best-effort caching (IPFS).
- Explicit per-deal replication (Filecoin: 1 deal = 1 replica; multiple deals = N replicas).
- Two-layer: deterministic kademlia-neighbourhood replication plus opt-in Reed-Solomon erasure coding chosen by the uploader (Swarm).
- Probabilistic via PoA incentives — miners hold what's most likely to be sampled (Arweave).
- Mandatory erasure coding via RaptorQ — each blob's slivers spread across the entire network (Walrus).

### 2.5 Mutability

Decentralised storage is inherently immutable per upload. To express "the latest version of X":

- IPFS: IPNS (slow, often unreliable), DNSLink, IPNS-over-PubSub.
- Filecoin: no protocol-level mutability; re-upload and update external pointers.
- Swarm: feeds and single-owner chunks (SOC) — first-class signed-update primitives.
- Arweave: SmartWeave / atomic NFTs / AO (lazy-evaluated and process-based).
- Walrus: Sui smart-contract objects pointing at blobs; blobs themselves are immutable per write.

### 2.6 Privacy and censorship resistance

How easy is it to identify, target, refuse or take down specific content:

- IPFS: nothing built in; gateways are takedown surfaces.
- Filecoin: nothing built in; SPs can refuse deals; verified deals are open.
- Swarm: 4 KiB chunks make per-file fingerprinting hard at the storer; PSS for messaging; chunk encryption optional.
- Arweave: data is on the public chain; encryption optional but not the default UX.
- Walrus: encryption optional; sliver model means individual nodes don't hold complete blobs.

### 2.7 Smart-contract integration

How deeply storage and computation are tied:

- IPFS: none.
- Filecoin: full L1 with FVM (EVM-compatible).
- Swarm: Gnosis Chain (a separate EVM chain) handles postage, staking, and redistribution.
- Arweave: SmartWeave (lazy-evaluated, off-chain JS) plus AO (process-based actor model launched 2024).
- Walrus: Sui's Move VM; blobs are first-class Sui objects.

### 2.8 Network maturity

Rough order-of-magnitude as of early 2026:

- IPFS: tens of thousands of nodes; the most mature ecosystem by far.
- Filecoin: hundreds of storage providers committing exabytes of capacity.
- Swarm: hundreds to low thousands of Bee nodes; smaller but coherent.
- Arweave: hundreds of miners; ~190+ TiB on-chain data.
- Walrus: very recent mainnet; growing operator set; ecosystem coupled to Sui.

These eight dimensions recur throughout the article and the comparison matrices.

---

## 3. IPFS

### 3.1 Origin and philosophy

The InterPlanetary File System (IPFS), proposed by Juan Benet and Protocol Labs in 2014, is the **conceptual ancestor** of most of what's discussed in this article. It articulated the case for content-addressed, peer-to-peer file sharing as a successor to the location-addressed web. Crucially, IPFS made one design choice that shaped everything else: it does **not** include an incentive layer. It is a content-addressing and discovery primitive and explicitly leaves storage economics to other systems (Filecoin being the canonical pairing).

The design philosophy is **minimalism and composability**. IPFS does one thing — let you address content by hash and find anyone holding it — and lets you compose persistence, payment, naming, and applications on top.

### 3.2 Architecture

The core stack:

- **CIDs (Content Identifiers)** — self-describing hashes. A CID encodes the hash algorithm (multihash), the encoding (multibase), and the codec used to interpret the bytes (multicodec). This makes CIDs forward-compatible and protocol-agnostic.
- **IPLD (InterPlanetary Linked Data)** — a data model on top of CIDs that lets blocks reference other blocks by CID. UnixFS (a DAG-PB schema) is the most common file representation; DAG-CBOR and DAG-JSON are common for structured data.
- **libp2p** — the pluggable networking stack underlying IPFS. Transports include TCP, QUIC, WebSocket, WebTransport, and WebRTC. NAT traversal via STUN, TURN-equivalent relays, and AutoNAT.
- **Kademlia DHT** — provider records (which peer ID has which CID) are stored in a global DHT. Lookups are O(log N) hops.
- **Bitswap** — block-level exchange protocol; nodes maintain "want lists" of CIDs they're interested in and offer blocks to peers whose want lists they can fulfil.
- **Default chunking** — UnixFS uses 256 KiB chunks by default, configurable. Files are merkelised into a DAG of chunks.

### 3.3 Persistence

IPFS itself provides **no persistence guarantee**. Data lives only on nodes that have explicitly *pinned* it. Without pinning, the local IPFS node's garbage collector eventually evicts blocks. Without other peers also pinning, the data is gone from the network.

In practice, IPFS persistence is delivered by:

- **Pinning services** — Pinata, web3.storage, NFT.Storage, Filebase, and others provide SaaS APIs that pin your CIDs against payment.
- **Filecoin deals** — bridge IPFS data into Filecoin's incentive layer.
- **Self-hosted nodes** — anyone running a Kubo or Helia node pins what they care about.
- **Public gateways** — Cloudflare's gateway, ipfs.io, dweb.link, etc. cache content as it's accessed and serve it via HTTP.

The practical consequence: when most users say "this is on IPFS", they almost always mean "Pinata or web3.storage is hosting it for me, and the CID is published on the IPFS DHT."

### 3.4 Mutability

IPNS (InterPlanetary Naming System) lets a peer publish a signed mapping from their public key to a CID, updateable over time. IPNS is notoriously slow because:

- The default DHT-based publish has multi-hop propagation latency.
- Records have a TTL and need to be republished periodically.
- The lookup path is the same DHT as everything else, with the same variability.

Workarounds: IPNS-over-PubSub for faster propagation, DNSLink (a TXT record in DNS pointing at a CID) for human-readable mutable names.

### 3.5 Privacy and censorship

Nothing built in. CIDs are public; any observer can correlate a CID lookup with a reader. Block content is not encrypted by the protocol. The standard pattern is "encrypt-then-publish": encrypt with a symmetric key, share the key out-of-band.

Censorship surfaces are the gateway operators and pinning services. The protocol is open, so a determined publisher can route around individual takedowns; a casual user dependent on Pinata cannot.

### 3.6 Browser story

IPFS in browsers is mature. **Helia** (the JavaScript implementation succeeding the older js-ipfs) lets a browser tab be a real libp2p peer over WebSocket and WebRTC transports. Delegated routing offloads heavy DHT work to remote nodes. **Verified fetch** patterns let a browser retrieve content from any HTTP gateway and cryptographically verify it matches the requested CID.

### 3.7 Notable design choices

- **CID/IPLD adopted far beyond IPFS.** Filecoin uses it. Ceramic uses it. Many EVM-side archive tools use it. The data model has outgrown its original protocol.
- **Bitswap as a generic block exchange** is a design that scales surprisingly well — peers naturally form swarms around popular content.
- **No native incentive layer is a feature, not a bug** for the design philosophy. It allowed broad adoption that an opinionated incentive layer would have prevented.

### 3.8 Strengths and weaknesses

**Strengths**

- The largest and most mature ecosystem in decentralised storage.
- Excellent for static content distribution; used as a CDN by Cloudflare, Brave, and many web3 projects.
- Multi-implementation (Kubo in Go, Helia in JS, Iroh in Rust) — protocol health is real.
- Browser story works well today.
- The CID/IPLD primitive is a small, well-designed, broadly reusable foundation.

**Weaknesses**

- The gap between "the protocol" and "the user experience". Most production "IPFS" use depends on a small number of pinning services or gateways.
- DHT performance for content discovery has historically been uneven (steadily improving).
- IPNS for mutable references is a known pain point.
- Without an incentive layer, persistence is whatever you pay external services for.

---

## 4. Filecoin

### 4.1 Origin and philosophy

Filecoin, also from Protocol Labs, launched mainnet in October 2020 after a long development cycle. The design philosophy is **cryptographically rigorous storage as a marketplace**: storage providers (SPs) commit to storing data for a defined period under a contract recorded on a dedicated blockchain, and they continuously prove they're still storing it via cryptographic proofs that are verified on-chain.

If IPFS is "git distributed over libp2p", Filecoin is "AWS S3 Glacier with on-chain receipts and a slashing mechanism for non-performance".

### 4.2 Architecture

- **Sectors**, not files, are the storage unit. SPs commit to **32 GiB or 64 GiB sectors**. Multiple smaller deals are packed into a sector by deal-aggregators. The sector size makes per-sector proofs computationally feasible.
- **Proof of Replication (PoRep)** — when an SP first onboards data, it "seals" the sector through a slow, expensive process that produces a unique encoding tied to the SP's identity. This proves they actually allocated unique storage rather than just referencing someone else's copy.
- **Proof of Spacetime (PoSt)** — continuous proofs that the SP is still storing the sealed data. Two flavours:
  - **WindowPoSt**: every ~24 hours, every SP must prove all their committed sectors are intact, sampled randomly.
  - **WinningPoSt**: per-epoch leader election; SPs that "win" produce blocks and earn block rewards.
- **Storage Power Consensus (SPC)** — the consensus mechanism. Block-production probability is proportional to verified storage power.
- **Storage deals** — explicit on-chain contracts between client and SP, with collateral, duration, price, and termination rules. Slashing for failed PoSt or early termination.
- **Filecoin Virtual Machine (FVM)** — launched 2023; EVM-compatible smart contract layer. Enables programmable deal-making, tokenised storage, and storage-aware DeFi.
- **Verified deals + Filecoin+** — datacap mechanism that lets verified clients pay 0 FIL for storage; SPs receive a 10× boost to their effective storage power for verified data.

### 4.3 Persistence

Filecoin gives the **strongest cryptographic persistence guarantees** of any protocol in this article, *for the duration of the deal*. PoSt failures lead to slashing. Deals typically run from 180 days to several years; expired deals require renewal.

Important nuance: Filecoin deals are commitments to store *for a period*, not "forever". Permanence requires renewal, ideally distributed across multiple SPs to avoid single-operator dependence.

### 4.4 Retrieval

Historically the weakest part of Filecoin. SPs have strong incentives to seal data (deal payment) but weaker incentives to serve it back quickly. Multiple efforts address this:

- **Lassie** — a retrieval client that abstracts over multiple sources (Filecoin, IPFS, gateways).
- **Saturn** — a Layer-2 retrieval CDN that caches and serves Filecoin/IPFS content.
- **Retrieval Markets** — paid retrieval as a separate negotiation from storage deals.
- **Proof of Data Possession (PDP)** — a newer, lighter-weight proof regime introduced for "fast data" use cases where retrieval and freshness matter more than long-term cold-storage guarantees.

Retrieval has improved significantly in the last two years but remains the area where Filecoin has the most surface compared to alternatives.

### 4.5 Mutability

None at the protocol level. Mutability is achieved by re-uploading new versions and updating an external pointer (typically on Ethereum or another chain), or by using application-layer indexing.

### 4.6 Privacy

None built in. Encryption is the publisher's responsibility. PoRep produces a unique sealing per SP per sector, so the on-disk bytes differ from the original; this offers some privacy *from* the SP only after sealing, not before transmission.

### 4.7 Smart contracts

The FVM is a genuine differentiator. It makes deal-making programmable — smart contracts can pay for storage on behalf of users, take custody of CIDs, react to PoSt outcomes, and so on. Use cases include perpetual-storage funds, data DAOs, and token-curated registries that maintain on-chain references to off-chain content.

### 4.8 Notable design choices

- **Sealing is a deliberate cost.** PoRep is intentionally slow (hours to days per sector on a single GPU rig). This makes sybil attacks expensive: faking a replica costs almost as much as making a real one.
- **Verified deals are the most consequential UX innovation.** Filecoin+ effectively turns Filecoin into a free archival service for legitimate data, funded by the network's block rewards.
- **Operator economics push toward centralisation.** Sealing rigs cost tens of thousands of dollars; SPs are professional infrastructure operators, not hobbyists. The Filecoin protocol is decentralised; the SP set, in practice, isn't fully so.

### 4.9 Strengths and weaknesses

**Strengths**

- Strongest cryptographic storage proofs of any protocol covered.
- Massive committed capacity (~20 EiB).
- Verified deals make permanent archival economically free for legitimate data.
- FVM brings programmable storage that's genuinely novel.
- Slashing makes the proofs economically meaningful.

**Weaknesses**

- High operator capital requirements push centralisation.
- Deal-making complexity (improving with FVM-based abstractions).
- Retrieval is the chronic weak point (improving with Saturn / PDP).
- Cold-storage-shaped: not a great fit for hot serving of dynamic content.
- Heavy on-chain footprint (deals, proofs all on-chain).

---

## 5. Swarm

### 5.1 Origin and philosophy

Swarm originated alongside Ethereum as one of the "trinity" components (along with Whisper for messaging and the EVM for compute). The first production-grade implementation, **Bee** (in Go), reached mainnet in 2021. The design philosophy is **a single integrated stack for permissionless web hosting**: addressing, payment, storage incentives, mutability, and privacy primitives all live in one protocol.

If IPFS is a primitive and Filecoin is a marketplace, Swarm is an attempt at a complete decentralised-web platform.

### 5.2 Architecture

- **4 KiB fixed chunks**. Files are split into uniform 4 KiB pieces.
- **BMT (Binary Merkle Tree) hashing**. Each chunk is hashed via BMT to produce a 32-byte chunk address. This produces content-addressed chunks similar to CIDs but with a fixed schema.
- **Manifest format: mantaray**. A content-addressed trie that maps file paths within an upload to chunk addresses, allowing browseable directory structures.
- **Postage stamps**. Every chunk on the wire carries a 113-byte stamp: `batchID[32] | index[8] | timestamp[8] | sig[65]`. The signature must recover to the on-chain `owner` of the batch (recorded in the Gnosis Chain `PostageStamp` contract).
- **Kademlia neighbourhood obligation**. A chunk's address determines a neighbourhood of nodes (those whose Bee node ID is closest in XOR distance) that are *obligated* to store any stamped chunk in that neighbourhood. This is unlike IPFS where storage is voluntary.
- **Storage incentives via redistribution lottery**. Every "round", a random storer in a randomly-chosen neighbourhood is selected to prove they hold a sample of their reserve. Successful provers win a portion of the postage payments.
- **Reserve eviction**. A storer's reserve is bounded; when full, lower-stake stamps can be evicted in favour of higher-stake or fresher ones.
- **libp2p** for transport, with TCP and QUIC traditionally and `wss://` (libp2p over secure WebSocket with AutoTLS via `libp2p.direct`) added in Bee v2.7.0.

### 5.3 Persistence

Probabilistic but coherent. As long as the postage batch's funds outlast the reserve pressure on the relevant neighbourhood, chunks remain stored. Two factors govern persistence:

- **Batch balance and depth.** Topping up the batch extends its lifetime. `topUp` is permissionless (anyone can fund any batch).
- **Network reserve pressure.** If the overall network is under-provisioned and storers are evicting low-stake stamps, persistence depends on your batch having competitive stake.

For meaningful persistence, the recommended deployment is to upload with **erasure coding enabled** (see §8.3) and to keep the batch funded.

### 5.4 Erasure coding (Reed-Solomon, opt-in per upload)

Swarm supports user-selectable erasure coding via the `Swarm-Redundancy-Level` header. Five levels:

| Level | Name | Approx data:parity | Tolerates roughly |
| --- | --- | --- | --- |
| 0 | None | 100:0 | 0% chunk loss |
| 1 | Medium | ~95:5 | ~1% chunk loss |
| 2 | Strong | ~70:30 | ~5% chunk loss |
| 3 | Insane | ~50:50 | ~10% chunk loss |
| 4 | Paranoid | ~25:75 | ~50% chunk loss |

The mechanism: at each level of the Bee chunk tree (leaves and intermediate nodes), Reed-Solomon parity chunks are added over the siblings. Parity chunks are stamped and pushsynced like any other chunk. At retrieval, the joiner reconstructs missing chunks from the parity siblings.

This sits **on top** of the kademlia-neighbourhood replication. So Swarm has two redundancy layers: the network-level replication of every chunk to N storers in its neighbourhood, plus the application-level Reed-Solomon parity chunks chosen by the uploader.

### 5.5 Mutability

Two first-class primitives:

- **Feeds** — an owner-keyed mutable reference: at address `keccak256(ownerAddress || topic)`, the owner can publish updates by signing a new chunk with monotonically increasing version. Lookups are kademlia-fast.
- **Single-Owner Chunks (SOC)** — chunks whose address is `keccak256(ownerAddress || identifier)` rather than `BMT(content)`. The owner can update the chunk's content (signed); the address remains stable.

These avoid IPNS-style DHT-republish issues by tying mutability into the same kademlia routing used for everything else.

### 5.6 Privacy

- **Per-chunk fingerprinting is hard.** A storer holds 4 KiB chunks belonging to thousands of unrelated files; they cannot easily tell what content they're storing. Compare to Filecoin's 32 GiB sectors where the content is far more legible.
- **Optional chunk encryption** at upload time (Bee splits the file into chunks and encrypts each).
- **PSS (Postal Service over Swarm)** for off-chain messaging, designed for privacy-preserving message delivery using "trojan chunks".
- **Forwarder pattern for retrieval** obscures the requester from the neighbourhood holding the chunk.

### 5.7 Smart contract integration

The relevant contracts live on Gnosis Chain (chosen for low fees and EVM compatibility). The most important are:

- **`PostageStamp.sol`** — manages batches: `createBatch`, `topUp`, `increaseDepth`, batch ownership.
- **`StakeRegistry.sol`** — manages storer stakes for the redistribution lottery.
- **`Redistribution.sol`** — runs the per-round lottery, selects provers, validates proofs, distributes rewards.
- **`PriceOracle.sol`** — manages dynamic per-chunk pricing.

Application smart contracts can interact with these directly to fund storage on behalf of users.

### 5.8 Browser story

Historically the weakest part of Swarm. As of Bee v2.7.0 / v2.7.1 (released 2026), **secure WebSocket support over libp2p with AutoTLS (`p2p-wss-enable: true`, certs auto-issued via `libp2p.direct`)** lets a browser become a real libp2p light peer, dial Bee nodes directly, and speak the standard `pushsync` protocol — receiving signed storer receipts as cryptographic proof of placement. Two transport modes are now feasible:

- **HTTPS to a key-less Bee gateway** via the existing presigned-stamp upload path.
- **Direct libp2p `wss://` to a v2.7.0+ Bee peer**, with the gateway acting as a libp2p transport hop rather than an application-level intermediary.

### 5.9 Notable design choices

- **Decoupling payer from owner at `createBatch`.** The contract permits `msg.sender` (payer) and `_owner` (the address whose key signs stamps) to differ. This single design choice enables clean delegation patterns where the user pays on chain but the gateway operator stamps with a different key, without compromising the user's wallet.
- **`topUp` is permissionless.** Anyone may extend any batch's lifetime by paying BZZ. Other batch operations (`increaseDepth`) are owner-only.
- **4 KiB chunks for censorship resistance.** Storers hold tiny slices of unrelated content, making per-file targeting genuinely hard.
- **Mantaray is content-addressed.** Browseable file structure without external indexing.

### 5.10 Strengths and weaknesses

**Strengths**

- Single coherent protocol covering addressing, payment, storage obligation, mutability, privacy.
- 4 KiB chunk model is excellent for censorship resistance.
- Feeds and SOCs provide clean mutability, far better than IPNS.
- Two-layer redundancy (kademlia + opt-in Reed-Solomon) gives the uploader explicit control over durability.
- Browser story closing fast post-v2.7.0.
- Postage stamp model is genuinely novel and economically expressive.

**Weaknesses**

- Smaller network than IPFS or Filecoin.
- Postage economics confuse many users (BZZ price volatility, depth/balance/duration interactions).
- No "permanence guarantee" in the Arweave sense; chunks can be evicted from reserves under pressure.
- Tooling and library ecosystem less mature than IPFS.
- Documentation has historically been challenging for newcomers.

---

## 6. Arweave

### 6.1 Origin and philosophy

Arweave launched in 2018 with a single-sentence pitch: **pay once, stored forever**. The design philosophy treats storage as a one-time purchase against a perpetual endowment, betting that the price of storage will continue to fall faster than the endowment depletes. There is no other protocol on this list that takes this approach.

### 6.2 Architecture

- **Blockweave**, not blockchain. Each block references not only the previous block but also a randomly-chosen *recall block* from arbitrarily far in the past. Miners must prove access to the recall block's data to mine.
- **Proof of Access (PoA)** — the consensus mechanism. To produce a valid block, a miner must include data from the recall block, demonstrating they have access to it. Variants over time:
  - **PoA** (original) — direct access proof.
  - **RandomX-PoA / SPoA** — single-proof variants.
  - **SPoRA (Succinct Proof of Random Access)** — current production form, more efficient.
- **Endowment**. The bulk of a one-time storage payment is held in a long-term pool. Each epoch a portion is paid out to miners, calibrated to assumptions about future storage cost trajectories.
- **Bundlers**. Because Arweave's native transaction format isn't great for high-frequency small uploads, **Irys (formerly Bundlr)** and similar services aggregate many small uploads into single Arweave transactions (ANS-104 bundles). In practice, almost all NFT-scale Arweave uploads go through bundlers.
- **AO (Autonomous Object)** — a compute layer launched 2024 that provides actor-model processes running off-chain with messages persisted to Arweave. Distinct from but related to SmartWeave.

### 6.3 Persistence

The Arweave permanence claim is **not** "the protocol guarantees permanence". It's an **economic argument**:

1. Storage cost per byte declines exponentially over time (~30%/year historically).
2. The endowment compounds (held in AR; intended to grow in real terms).
3. Therefore, even though the endowment is finite, it should pay miners enough to keep replicating data indefinitely.

This is a creative bet, but it depends on assumptions:

- **Storage cost decline must continue.** It has slowed in recent years; HDD price/byte improvements have flattened relative to historical trends.
- **AR-denominated endowment introduces token-price risk.** Miners pay for hardware and electricity in fiat; they earn in AR. Sustained AR/USD weakness reduces effective miner income.
- **PoA replication is non-uniform.** Miners are incentivised to hold the most-likely-to-be-recalled data. Actual replication of any specific dataset varies; some content is widely held, some less so.

Arweave has held up well for its first 7+ years. The economic bet is sound for the time horizons people typically care about (years to decades). For multi-decade archival of irreplaceable data, treating Arweave as the *only* copy would be optimistic.

### 6.4 Retrieval

Via gateways primarily — `arweave.net`, `ar.io` gateway federation, `permagate.io`. Native node-level retrieval works but is gateway-mediated for nearly all real use. The ar.io gateway network is itself a notable system: gateway operators stake AR and earn fees for serving content.

### 6.5 Mutability

Three layers, evolved over time:

- **SmartWeave** — lazy-evaluated smart contracts. State is computed by reading the entire history of contract interactions client-side. Fast for small histories, slow for active contracts.
- **Atomic NFTs** — combining SmartWeave and ANS-110 to make NFT contracts that live entirely on Arweave (no L1 dependency).
- **AO** — actor-model processes that run off-chain and persist messages to Arweave. Higher throughput, more programming flexibility than SmartWeave.

For "just point to the latest version of X", an external pointer (e.g., on Ethereum or Solana) referencing an Arweave txid is still common.

### 6.6 Privacy

Data on Arweave is **public by default** in the strongest sense — it's part of the chain itself, not adjacent to it. Encryption is possible but cuts against the typical Arweave use case (publishing NFT art, public documents, etc.). The "encrypt-then-publish" pattern works the same as on any of the other protocols.

### 6.7 Smart contract integration

SmartWeave and AO are Arweave-native, providing computation tightly bound to Arweave-stored state. AO in particular is ambitious: it positions Arweave as a permanent message log for distributed processes, which has interesting implications for verifiable computation and persistent agents.

### 6.8 Notable design choices

- **One-time payment is a UX winner.** No expiry, no renewal logic, no batches to top up. For NFTs, archival documents, and "publish and forget" use cases this is a meaningfully better mental model than every other protocol.
- **The blockweave (PoA) consensus is genuinely novel.** Tying block production to historical-data access creates an incentive to retain the entire chain, not just tip-of-chain state.
- **Bundlers are the de facto entry point.** This is a centralisation risk worth being aware of: most uploaders interact with Arweave through Irys, not directly with miners.

### 6.9 Strengths and weaknesses

**Strengths**

- The only protocol with one-time-pay-permanent UX.
- Mature ecosystem (ArDrive, Irys, AO, atomic NFTs).
- Active for 7+ years with real on-chain data.
- Strong NFT-storage adoption.
- Novel consensus design (blockweave + PoA).
- AO compute layer is a serious recent advancement.

**Weaknesses**

- The endowment economic model is a real bet that could fail under adverse storage-cost trajectories or AR price weakness.
- PoA replication is statistical, not contractual; some data is held by fewer miners than others.
- Heavy reliance on bundlers (Irys) introduces operational centralisation.
- Mutability story (SmartWeave, AO) has been complex and evolving.
- All data is public-by-default; encryption is not the typical UX.

---

## 7. Walrus

### 7.1 Origin and philosophy

Walrus was published as a paper by Mysten Labs (the team behind Sui) in 2024, with mainnet launch in early 2025. The design philosophy is **storage efficiency under Byzantine fault tolerance**: how do you build a decentralised blob store that achieves high availability with low total storage overhead, while tolerating malicious or unavailable storage nodes?

The answer is **erasure coding at the protocol level**, deeply integrated with a smart-contract layer (Sui Move) for coordination and payment.

### 7.2 Architecture

- **Blobs as the primary unit.** Walrus stores opaque blobs of arbitrary size.
- **RaptorQ erasure coding.** Each blob is encoded into many small "slivers" using RaptorQ (RFC 6330), a fountain code with very efficient encoding/decoding.
- **One sliver per blob per storage node.** Each storage node holds **one sliver** of each blob it participates in storing, not the whole blob. With ~1000 storage nodes, each holds ~1/1000th of any given blob.
- **BFT model.** The protocol tolerates up to **1/3 of storage nodes being Byzantine** (lying or unavailable) without losing data.
- **Total storage overhead: roughly 5×.** Compared to ~50× for naive 50-replica replication, this is a major efficiency win.
- **Storage epochs.** Storage is rented per epoch (typically days to weeks). Renewal extends storage; non-renewal expires the blob.
- **Sui chain integration.** Blobs are first-class Sui Move objects: a `Blob` object on Sui carries a reference to the actual data in Walrus, and can be transferred, queried, and used as input to Move smart contracts.
- **Node types**:
  - **Storage nodes** — hold slivers, serve reads/writes, produce attestations.
  - **Aggregators** — read clients that fetch and reconstruct blobs from sliver quorums.
  - **Publishers** — write clients that distribute new blobs across nodes.

### 7.3 Persistence

Per-epoch with renewal, similar in shape to Filecoin per-deal but at a finer granularity. The BFT model means data is robust against significant operator malice (up to 1/3); the erasure coding means data survives any pattern of loss up to the protocol's recovery threshold.

Persistence "forever" requires perpetual renewal — there is no Arweave-style endowment.

### 7.4 Retrieval

Reading a blob requires fetching slivers from a quorum of storage nodes and decoding via RaptorQ. The minimum quorum is small (a fraction of total slivers), so reads have good availability. Aggregator services package this into HTTP-friendly APIs for client convenience.

### 7.5 Mutability

Blobs themselves are immutable per write. Mutability is via Sui smart contracts: a Move object can hold a `Blob` reference and update it (point to a new blob) under whatever access control the contract defines. This is a clean separation: storage is immutable, programmable mutability lives in Sui.

### 7.6 Privacy

Encryption is the publisher's responsibility (encrypt-then-publish). The sliver model offers some privacy at the storage-node level: an individual node never holds a complete blob, only one sliver. This is structurally similar to Swarm's chunk-level privacy benefit.

### 7.7 Smart contract integration

Tight integration with Sui's Move VM. `Blob` is a first-class Move object, which means smart contracts can:

- Take ownership of blobs.
- Pay for storage and renewals.
- Implement application-specific access control.
- Compose storage with other Move-native primitives (NFTs, financial instruments, etc.).

For projects already building on Sui, this integration is excellent. For projects on other chains, the coupling is friction.

### 7.8 Notable design choices

- **Erasure coding at the storage layer is the central design choice.** Naive replication (10 copies of each blob) is wasteful; per-blob erasure coding (one fountain-coded sliver per node) is dramatically more efficient and offers BFT-grade availability.
- **RaptorQ over Reed-Solomon.** Fountain codes (RaptorQ in particular) are well-suited to scenarios where the encoder produces many small symbols and the decoder needs only any sufficient subset. Reed-Solomon (which Swarm uses) requires fixed (data, parity) shapes; RaptorQ is more flexible.
- **Walrus Sites.** A pattern (similar to Arweave's permanent sites or Swarm's bzz hosting) for publishing static websites whose content lives in Walrus and whose routing is mediated by Sui smart contracts.

### 7.9 Strengths and weaknesses

**Strengths**

- The most theoretically rigorous storage design on this list (BFT + erasure coding).
- ~5× total storage overhead is dramatically better than naive replication models.
- Tight, programmable integration with Sui Move smart contracts.
- Modern crypto choices (RaptorQ, BFT consensus).
- Designed from the ground up for "decentralised app data" use cases.

**Weaknesses**

- Very young protocol; limited battle-testing at scale.
- Sui-ecosystem coupling is meaningful friction for non-Sui projects.
- Smaller storage-node set than the older protocols.
- No permanence model; storage requires perpetual renewal.
- Tooling is early (TypeScript SDK, Move integration, but less mature than IPFS or Filecoin libraries).

---

## 8. Cross-cutting deep dives

### 8.1 Content addressing

All five protocols are content-addressed in some sense, but with meaningful differences.

| Protocol | Address scheme | Hash function | Granularity |
| --- | --- | --- | --- |
| IPFS | CID (multihash + multicodec + multibase) | SHA-256 default; pluggable | Per-block (256 KiB default) |
| Filecoin | Piece CID (over a sealed-and-padded sector) + standard CID for unsealed data | SHA-256 + Filecoin-specific padding | Per-piece (within 32–64 GiB sector) |
| Swarm | BMT root | Keccak-256 in BMT structure | Per-chunk (4 KiB) and per-file (BMT root) |
| Arweave | TxID (hash of tx) | SHA-384 | Per-transaction (arbitrary size, often bundled) |
| Walrus | Blob ID (over the encoded sliver set) | BLAKE2b in current design | Per-blob (arbitrary size) |

**CIDs (IPFS, Filecoin)** are self-describing and forward-compatible — the most extensible. **BMT (Swarm)** is fixed-schema but tightly integrated with the rest of the Swarm protocol. **TxIDs (Arweave)** are simple and transaction-shaped. **Blob IDs (Walrus)** abstract over the erasure-coded sliver structure.

The CID/IPLD model has been adopted far beyond IPFS itself, including by Filecoin and many ancillary tools. It is the closest thing to a de facto standard for content addressing in web3.

### 8.2 Storage proofs

This is the area of starkest difference between the five protocols.

| Protocol | Proof family | Frequency | Granularity | Slashing? |
| --- | --- | --- | --- | --- |
| IPFS | None | n/a | n/a | n/a |
| Filecoin | PoRep + WindowPoSt + WinningPoSt | Per-sealing (one-time) + ~24h continuous | Per-sector (32–64 GiB) | Yes — strong |
| Swarm | Sampling-based redistribution lottery | Per-round (continuous) | Per-storer reserve | Yes — stake slashing |
| Arweave | Proof of Access (SPoRA) | Per-block (continuous) | Per-recall-block | No direct slashing; non-mining miners earn nothing |
| Walrus | Per-epoch attestations | Per-epoch | Per-storage-node | Yes — stake slashing |

**Filecoin** offers the most rigorous cryptographic story. PoRep proves that the SP allocated unique storage; PoSt proves they're still storing it. Slashing is real and economically meaningful.

**Walrus** is the second-most cryptographically rigorous, with a BFT-style attestation model that's elegant and fault-tolerant by design.

**Swarm** uses sampling: every round, a random storer in a random neighbourhood is challenged to prove they have a fragment of their reserve. This is much lighter-weight than PoSt but provides probabilistic assurance only.

**Arweave**'s PoA is novel: the consensus rule itself requires data access. A miner without the recall block's data can't mine the next block, so there's an implicit incentive to retain history. But it's not a per-data-item proof — it's a per-block proof that the miner has *some* portion of historical data.

**IPFS** has none. Persistence is whatever you arrange via pinning services or Filecoin deals.

### 8.3 Erasure coding

Two protocols use erasure coding directly; the others rely on replication.

**Swarm** uses Reed-Solomon at the application layer, opt-in per upload via the `Swarm-Redundancy-Level` header. Five levels (None / Medium / Strong / Insane / Paranoid). Parity chunks are added at each level of the chunk tree and stored in the network like any other chunk. This sits **on top of** the kademlia neighbourhood replication, so Swarm has two redundancy layers (network-level + opt-in application-level).

**Walrus** uses RaptorQ at the protocol layer, mandatory and uniform across all blobs. Each blob is split into ~1000 slivers; each storage node holds one sliver per blob. Reading reconstructs from a quorum. Total network storage overhead is ~5× regardless of blob.

**Filecoin** does not use erasure coding within a deal. Multi-replica storage is achieved by making multiple deals with different SPs.

**IPFS** has no built-in erasure coding; users may layer it themselves at the application level (Reed-Solomon, IPFS-cluster orchestration) but it's not protocol-native.

**Arweave** does not use erasure coding; it relies on PoA-incentivised replication across miners.

The trade-off:

- **Walrus's mandatory uniform erasure coding** is the most storage-efficient and provides BFT-grade fault tolerance; users have no control.
- **Swarm's opt-in per-upload erasure coding** is the most economically expressive — pay only for the redundancy you want for this specific upload; users have full control.
- **Filecoin's multi-deal redundancy** is the most operator-distributed — different SPs hold different replicas; the application chooses how many.
- **IPFS's "do it yourself"** is the most flexible but the least convenient.
- **Arweave's PoA-incentivised replication** is the most laissez-faire — the protocol incentivises miners to hold popular data; specific data may be held by few.

### 8.4 Mutability primitives

Storage is fundamentally immutable per upload. Mutability ("the latest version of X") is a separate concern. The protocols handle it differently:

| Protocol | Mutability primitive | Performance | Notes |
| --- | --- | --- | --- |
| IPFS | IPNS, DNSLink, IPNS-over-PubSub | Slow (DHT), better with PubSub | Long-standing pain point |
| Filecoin | None at protocol layer | n/a | Re-upload + external pointer |
| Swarm | Feeds, Single-Owner Chunks (SOC) | Fast (kademlia routing) | First-class signed-update primitives |
| Arweave | SmartWeave, atomic NFTs, AO | Variable (lazy evaluation) | Tight integration with on-chain compute |
| Walrus | Sui Move object pointers | Fast (Sui smart contracts) | Mutability lives in Sui, blob immutable |

**Swarm's feeds and SOCs** are arguably the cleanest design: they reuse the same kademlia routing as everything else, give you signed-update semantics with monotonic versioning, and don't require external indexing.

**IPNS** has been a chronic source of frustration in IPFS and is the most fragile of these primitives in practice.

**Arweave's AO** is the most ambitious — turning the storage layer into a substrate for actor-model computation with persistent message logs.

**Walrus's** approach of "blobs immutable, mutability via smart contracts" is clean and idiomatic for Sui projects.

**Filecoin** has nothing here; you build it yourself.

### 8.5 Smart-contract integration

| Protocol | Native smart contract layer | Integration model |
| --- | --- | --- |
| IPFS | None | Use external L1 (Ethereum, Solana, etc.) for indexing |
| Filecoin | FVM (EVM-compatible) | Programmable deal-making; contracts can own data |
| Swarm | Gnosis Chain (separate L1) | Postage, staking, redistribution; application contracts can fund storage |
| Arweave | SmartWeave + AO | Tightly bound; lazy-evaluated and process-based |
| Walrus | Sui Move VM | Blobs are first-class Move objects |

**Filecoin's FVM** and **Walrus's Sui integration** are the deepest — smart contracts can hold storage as a native object and react to its lifecycle. **Swarm's** Gnosis Chain separation means storage and computation live on different chains; the integration works but is more loosely coupled. **Arweave's** AO is potentially the most novel approach if it succeeds at scale: persistent processes whose state lives in Arweave is a different kind of compute primitive than the EVM-style world. **IPFS** has no native smart contract layer; everything is composed externally.

### 8.6 Browser participation

Whether and how a browser tab can be a real participant in the protocol — not just an HTTP client of a gateway.

| Protocol | Browser participation | Maturity |
| --- | --- | --- |
| IPFS | Helia + libp2p-js with WebSocket / WebRTC transports; full light peer | Mature |
| Filecoin | None directly; gateways only | n/a |
| Swarm | libp2p `wss://` + AutoTLS (Bee v2.7.0+); browser as light peer | Recent |
| Arweave | Gateway-mediated only | n/a |
| Walrus | TypeScript SDK + aggregator/publisher HTTP APIs | Recent |

**IPFS / Helia** is the most mature — it's been viable to run a real IPFS light node in a browser for years.

**Swarm** closed a long-standing gap with v2.7.0's WSS transport: a browser can now be a real libp2p peer and speak `pushsync` directly to Bee nodes that have enabled the WSS listener (with AutoTLS via `libp2p.direct` removing the historical operator friction).

**Filecoin and Arweave** are gateway-only stories; the protocols are not designed for browser participation.

**Walrus** has a TypeScript SDK that talks to aggregator/publisher HTTP services; not "browser as protocol participant" in the libp2p sense, but functionally workable.

### 8.7 Censorship resistance

What does it actually take for a third party to suppress specific content on each protocol?

| Protocol | Per-file fingerprintability at the storage layer | Takedown surfaces |
| --- | --- | --- |
| IPFS | Low (full blocks held by pinning services) | Pinning services, gateways |
| Filecoin | Medium-low (sectors are large but SPs know what they sealed) | SPs (legal pressure on commercial operators) |
| Swarm | High (4 KiB chunks; storers hold slices of unrelated content) | Few — gateway operators in mode α; nothing structural in mode β |
| Arweave | Mixed (data is on the public chain; miners can choose what to mine but consensus pushes toward holding everything) | Gateway operators; miners (rare) |
| Walrus | Medium-high (sliver model; one node holds 1/1000 of each blob) | Storage nodes (smaller set than IPFS, larger than Filecoin) |

The chunk/sliver-level systems (**Swarm**, **Walrus**) are structurally hardest to censor at the storage layer because no single node holds enough of any file to identify it. The sector-level systems (**Filecoin**) are more legible to operators. **Arweave** is interesting: data is public on chain (high transparency, low privacy) but miner-level censorship is technically possible though disincentivised. **IPFS** depends entirely on whether your content lives at a censorship-resistant pinning provider.

---

## 9. Side-by-side comparison matrices

### 9.1 Core characteristics

| Dimension | IPFS | Filecoin | Swarm | Arweave | Walrus |
| --- | --- | --- | --- | --- | --- |
| First mainnet | 2015 | 2020 | 2021 (Bee) | 2018 | 2025 |
| Consensus / coordination | None (libp2p only) | Filecoin L1 (SPC) | Gnosis Chain (separate) | Blockweave (PoA) | Sui (DPoS) |
| Storage unit | Block (~256 KiB default) | Sector (32 / 64 GiB) | Chunk (4 KiB) | Transaction (variable, often bundled) | Blob (variable, sliver-coded) |
| Hash function | SHA-256 default; pluggable | SHA-256 + sealing | Keccak-256 in BMT | SHA-384 | BLAKE2b |
| Address format | CID | Piece CID + CID | BMT root | TxID | Blob ID |
| Network size (rough) | Tens of thousands of nodes | Hundreds of SPs, ~20 EiB | Hundreds–low thousands of nodes | Hundreds of miners, ~190+ TiB | Recent mainnet, growing |

### 9.2 Persistence and proofs

| Dimension | IPFS | Filecoin | Swarm | Arweave | Walrus |
| --- | --- | --- | --- | --- | --- |
| Storage duration | Best-effort | Per-deal (months–years) | Until batch + reserve | "Permanent" (endowment) | Per-epoch (renewable) |
| Storage proofs | None | PoRep + PoSt | Sampling lottery | Proof of Access | Per-epoch attestations |
| Replication | Whoever pins | Per-deal | Kademlia + opt-in Reed-Solomon | PoA-incentivised | RaptorQ slivers (mandatory) |
| Storage overhead | Pinning-service-defined | 1× per deal × N deals | 1× per chunk × N storers (kademlia) + parity if chosen | Variable, statistical | ~5× total |
| Slashing | n/a | Yes | Yes | No (incentive-only) | Yes |

### 9.3 Payment and economics

| Dimension | IPFS | Filecoin | Swarm | Arweave | Walrus |
| --- | --- | --- | --- | --- | --- |
| Native token | None (libp2p) | FIL | BZZ (on Gnosis) | AR | WAL (on Sui) |
| Payment model | Pay external SaaS | Per-deal in FIL | Upfront batch in BZZ | One-time in AR | Per-epoch in WAL |
| Free-storage program | Pinning trial tiers | Filecoin+ verified deals | None | None | None |
| Renewal model | n/a | Per-deal renewal | `topUp` (permissionless) | n/a (one-time) | Per-epoch renewal |

### 9.4 Mutability, privacy, smart contracts

| Dimension | IPFS | Filecoin | Swarm | Arweave | Walrus |
| --- | --- | --- | --- | --- | --- |
| Native mutability | IPNS / DNSLink | None | Feeds / SOC | SmartWeave / AO | Sui Move pointers |
| Native encryption | None | None | Chunk-level optional | None (data public by default) | None |
| Native messaging | Pubsub | None | PSS | None | None |
| Smart contract layer | None | FVM (EVM-compat) | Gnosis Chain (separate) | SmartWeave + AO | Sui Move |
| Browser participation | Helia (mature) | Gateway only | libp2p WSS (Bee v2.7.0+) | Gateway only | SDK + aggregators |

### 9.5 Censorship and privacy posture

| Dimension | IPFS | Filecoin | Swarm | Arweave | Walrus |
| --- | --- | --- | --- | --- | --- |
| Per-file fingerprintability at storage layer | Low (full blocks at pinning service) | Medium-low (sealed sectors) | High (4 KiB chunks) | Mixed (public on chain) | Medium-high (slivers) |
| Operator concentration | Few large pinning services | Few large SPs | Distributed but small | Few large bundlers | Small sliver-node set (early) |
| Default content visibility | Public | Public | Public (or encrypted) | Public | Public (or encrypted) |
| Forwarder/anonymity primitives | None | None | Yes (PSS, retrieval forwarders) | None | None |

---

## 10. Use-case selection guide

The right protocol depends on the failure mode you can least tolerate. The following matches use cases to the protocol that fits them best, with rationale.

### 10.1 NFT metadata and "stick a CID into a token"

**Best fit: IPFS** (with a pinning service or Filecoin redundancy as backstop).

The NFT ecosystem expects CIDs. Tooling (OpenSea, marketplaces, wallets) is built around IPFS. For NFTs that absolutely must persist, **layered storage** is the production answer: pin on IPFS for ecosystem compatibility, also archive on Arweave or Filecoin for permanence.

### 10.2 NFT *art* that must outlive every centralised pinning service

**Best fit: Arweave**.

The one-time-pay-permanent UX is uniquely good here. The economic bet on the endowment is acceptable for NFT-scale data and the failure mode (very long-tail content might eventually be lost) is tolerable for non-critical art. Many high-profile NFT collections (Solana NFTs especially) use Arweave for this reason.

### 10.3 Long-term archival of irreplaceable scientific data

**Best fit: Filecoin verified deals**, ideally with redundant deals across multiple SPs.

The strongest cryptographic per-deal storage proof. Verified deals via Filecoin+ make the storage effectively free for legitimate datasets. The combination of slashing-backed proofs and contractual duration is uniquely strong for "must exist in 50 years with verifiable provenance".

### 10.4 Permissionless web hosting with mutable index (think IPFS-replacement-but-with-incentives)

**Best fit: Swarm**.

The integrated stack (postage stamps + kademlia obligation + feeds for mutability + chunk-level censorship resistance + browser-as-libp2p-peer post v2.7.0) covers all of this in a single protocol without composing three systems. Postage economics introduce complexity but the model is internally consistent.

### 10.5 Sui-ecosystem dapp data and programmable blob storage

**Best fit: Walrus**.

Native integration with Sui Move. `Blob` as a first-class Move object lets smart contracts own storage as a primitive. Erasure-coding efficiency is a real benefit at scale. The Sui coupling is friction for non-Sui projects but the right answer for Sui-native ones.

### 10.6 Mutable application state, inboxes, profiles, social-graph data

**Best fit:** none of these natively. Realistic options:

- **Swarm feeds + SOCs** for the storage layer, with application-layer indexing.
- **AO on Arweave** for actor-model state machines with persistent message logs.
- **Ceramic / OrbitDB on IPFS** for richer document-store semantics.

This is an area where decentralised storage is still maturing. For most production needs today, the answer involves layering an application protocol (Ceramic, OrbitDB, AO, custom indexers) on top of one of the storage protocols.

### 10.7 Censorship-resistant publishing (whistleblowing, banned content)

**Best fit:** parallel use of **Swarm** and **Filecoin verified deals**, with appropriate encryption.

Swarm's chunk-level storage makes per-file targeting structurally hard at the network layer. Filecoin's contractual permanence with multiple SPs makes takedown require coordinating multiple commercial operators across jurisdictions. Together, the attack surface is meaningfully reduced; alone, each has gaps.

### 10.8 CDN replacement for static web assets

**Best fit (today): IPFS via Cloudflare and other public gateways.**
**Best fit (rising): Swarm**, especially with the v2.7.0 WSS browser transport.

The IPFS gateway pool is the operational answer today; nothing else has that scale of deployed capacity. Swarm is more architecturally appropriate (built-in incentivisation means storage doesn't depend on Cloudflare's goodwill) and is closing the operational gap as the WSS transport matures.

### 10.9 Cold-storage archival of large enterprise datasets (the "S3 Glacier replacement")

**Best fit: Filecoin** via a deal-management service (Estuary, Filecoin Saturn, Web3.Storage's Filecoin path).

The protocol shape (large sectors, long deals, cryptographic proofs, slashing) is purpose-built for this. The pricing — especially with Filecoin+ verified deals — is competitive with or better than centralised cold-storage tiers.

### 10.10 Browser-resident dapp publishing without wallet-key-per-chunk pain

**Best fit (rising): Swarm with the recently shipped libp2p WSS transport**, OR **IPFS via Helia** for ecosystem fit.

Both let a browser participate as a real protocol peer. Swarm additionally gives you postage-stamp-paid persistence; IPFS+Helia gives you ecosystem ubiquity but no native incentive layer. The choice depends on whether persistent content matters for the app or whether the user's local browser is the only consumer.

### 10.11 "Best-of-breed" production publishing

**Best fit: triple-pin.**

For high-value content (popular NFT collections, important documents, historical archives), real production teams already do this:

- **IPFS pinning** for ecosystem compatibility (NFT marketplaces resolve CIDs).
- **Arweave** for long-tail permanence.
- **Swarm or Filecoin** for the primary serving layer with strong incentives.

The cost is small for NFT-scale data; the resilience is meaningful.

---

## 11. Open challenges in the space

These are problems none of the five protocols has fully solved, and which the field as a whole is still working through.

### 11.1 Mutability is uniformly hard

Every protocol struggles with "the latest version of X" in a decentralised way. IPNS is slow. Filecoin punts. Swarm feeds are good but kademlia-bounded. SmartWeave was promising but slow; AO is too new to assess. Sui pointers work but tie you to Sui. The ideal — fast, censorship-resistant, atomic, programmable mutability — does not yet exist as a single coherent primitive.

### 11.2 Retrieval markets

Storage is cheap; serving is expensive. Filecoin's retrieval has been chronically weak relative to its sealing. IPFS retrieval depends on whoever has the data being online. Swarm retrieval is good in theory (kademlia direct) but small network. Arweave retrieval is gateway-mediated. Walrus retrieval requires sliver quorum reconstruction. Solutions like Saturn (Filecoin) and the ar.io federation (Arweave) are real but partial.

### 11.3 Operator centralisation

In every protocol, the "decentralised operator set" tends toward a few large operators in practice:

- IPFS pinning services: Pinata, web3.storage, Filebase dominate.
- Filecoin SPs: a handful of large operators hold most of the sealed capacity.
- Arweave bundlers: Irys is the de facto entry point.
- Walrus: brand-new, but the trajectory will depend on operator economics.
- Swarm: smaller network means individual operators have outsized influence.

The protocols are decentralised; the deployments tend toward centralisation. This is a recurring economic gravity that no protocol has fully resisted.

### 11.4 Browser participation as a first-class peer

IPFS / Helia has had this for a while; Swarm shipped it in 2026 with v2.7.0; the others don't really have it. As browser-resident dapps become more sophisticated, the asymmetry between "browser is a client" and "browser is a peer" matters more. Wider WebSocket / WebRTC / WebTransport adoption across the protocols would change a lot of UX assumptions.

### 11.5 Long-horizon economic stability

Filecoin's sealing economics, Arweave's endowment math, Swarm's redistribution-lottery parameters, Walrus's per-epoch pricing — all of these depend on assumptions about future token prices, hardware costs, and operator participation that are hard to model over decades. Protocols that have already operated for 5+ years (IPFS, Filecoin, Arweave, Swarm) provide some empirical evidence; the very long-term picture remains unproven.

### 11.6 Privacy

Of the five, only Swarm has meaningful built-in privacy primitives (chunk-level encryption option, PSS messaging, retrieval forwarders, 4 KiB chunk fingerprint resistance). All others are "encrypt-then-publish" if you care, which works but isn't the default UX. Privacy-preserving decentralised storage at scale is still mostly an unsolved problem.

### 11.7 Cross-protocol composability

Today, using multiple protocols together is largely manual. Pin on IPFS, also archive on Arweave, also seal a Filecoin deal — three separate integrations, three separate payments, three separate failure modes. Cross-protocol abstractions (Lassie covers IPFS+Filecoin retrieval; web3.storage covers IPFS+Filecoin pinning) are useful but partial. There's room for higher-level orchestration that treats storage as a multi-network resource.

---

## 12. Conclusion: five different bets

The five protocols covered here are best understood as **five different bets about what decentralised storage should be**:

- **IPFS** bets that **a minimal primitive that does one thing well** is more valuable than a complete stack — and that the ecosystem will fill in the rest. This bet has paid off enormously; IPFS is the de facto content-addressing layer of web3.
- **Filecoin** bets that **cryptographic rigour, slashing, and a marketplace** are the right architecture for storage at scale. The bet has paid off for archival and for committed-capacity metrics; it has cost the project on the operator-decentralisation and retrieval-experience fronts.
- **Swarm** bets that **integration matters more than composability** — that a single protocol covering addressing, payment, obligation, mutability, and privacy will be more usable than three composed protocols. The bet has been slow to pay off (ecosystem size lags) but the design coherence is real, and recent v2.7.0 / v2.7.1 work on browser participation is closing one of the protocol's last major gaps.
- **Arweave** bets that **one-time payment for permanent storage** is a fundamentally better UX than rental-style models — and that the economics of the endowment will hold long enough to deliver on the promise. The bet has held for 7+ years; whether it holds for 70+ depends on assumptions about storage cost trajectories that are getting harder to validate.
- **Walrus** bets that **erasure coding plus BFT** is the right primitive for decentralised blob storage at scale, and that **deep integration with a programmable smart contract layer** is the right deployment shape. The bet is too new to evaluate but the technical design is the most sophisticated on this list.

None of these is "the right answer" for all cases. Each occupies a coherent corner of the design space and serves a distinct cluster of use cases well. For a serious production system, the answer is rarely "pick one"; it's "pick the right one for each role and layer them where it matters".

The field as a whole is healthier than it was five years ago. There are now multiple production-grade protocols with real adoption, real cryptographic guarantees, and increasingly mature browser stories. The remaining gaps — mutability, retrieval, operator centralisation, privacy, long-horizon economic stability — are real but well-understood, and several of them are being actively worked on across the ecosystem.

Decentralised storage in 2026 is no longer a single protocol or a research bet. It's a small portfolio of distinct designs, each with a defensible niche and a real user base. Picking among them is now a question of matching design trade-offs to use-case priorities — which is a much better problem to have than the question that was being asked in 2015.

---

## Appendix: Glossary

- **AutoTLS** — a libp2p mechanism (via the `p2p-forge` service at `libp2p.direct`) that automatically issues Let's Encrypt TLS certificates to libp2p peers based on their peer ID, enabling browsers to dial nodes over `wss://` without manual TLS provisioning.
- **BMT** — Binary Merkle Tree. Swarm's hash construction for per-chunk addressing.
- **BFT** — Byzantine Fault Tolerance. Property of a system that continues to function correctly even if some participants behave arbitrarily (lying or unavailable).
- **CID** — Content Identifier. IPFS's self-describing content address.
- **DHT** — Distributed Hash Table. Used by IPFS (and others) for peer/content discovery; usually Kademlia-based.
- **FVM** — Filecoin Virtual Machine. EVM-compatible smart-contract layer on Filecoin.
- **IPFS** — InterPlanetary File System.
- **IPLD** — InterPlanetary Linked Data. Data model on top of CIDs.
- **IPNS** — InterPlanetary Naming System. IPFS's mutable-name layer.
- **Mantaray** — Swarm's content-addressed manifest format for browseable file structures.
- **Postage stamp** — Swarm's per-chunk payment proof; signed by the batch owner.
- **PoA** — Proof of Access. Arweave's consensus rule requiring access to historical data.
- **PoRep** — Proof of Replication. Filecoin's one-time proof at sealing.
- **PoSt** — Proof of Spacetime. Filecoin's continuous storage proof.
- **PSS** — Postal Service over Swarm. Swarm's privacy-preserving messaging primitive.
- **RaptorQ** — A modern fountain code (RFC 6330) used by Walrus for blob erasure coding.
- **Reed-Solomon** — A classical erasure code; used by Swarm at the application layer.
- **SOC** — Single-Owner Chunk. Swarm's owner-signed mutable chunk primitive.
- **Sliver** — In Walrus, one of the many erasure-coded fragments of a blob held by a single storage node.
- **SP** — Storage Provider. Filecoin operator.
- **SmartWeave** — Arweave's lazy-evaluated smart contract framework.
- **AO** — Autonomous Object. Arweave's actor-model compute layer (launched 2024).
- **WSS** — Secure WebSocket (`wss://`). The libp2p transport added to Bee in v2.7.0 to support browser participation.
