---
SWIP: XXXX
title: Client-side postage stamping (self-custody upload pattern)
author: TBD (@github-handle)
discussions-to: TBD (open a GitHub Discussion on ethersphere/SWIPs and link it here)
status: Draft
category: Client
created: 2026-04-29
---

# Client-side postage stamping

> **Pattern 2 of three.** This SWIP defines a **self-custody** stamping pattern: the end-user device (browser / CLI / mobile / desktop app) holds the postage batch's owner key, performs all chunking, hashing, issuer-state allocation and stamp signing locally, and ships pre-stamped chunks to the Swarm network through a Bee node that holds **no** key material. Two transport modes are normative:
>
> * **Mode (α)** — HTTPS to a key-less Bee gateway (rides the existing `presignedStamper` path; works against all Bee versions).
> * **Mode (β)** — Direct libp2p over secure WebSocket (`wss://`) to a Bee peer, available since **Bee v2.7.0** with AutoTLS via `libp2p.direct`. The browser becomes a real libp2p light peer, speaking native `pushsync`, and receives signed storer receipts.
>
> Two complementary patterns:
>
> * **SWIP-XXXX (Server-side delegated postage stamp signing)** — gateway-managed (custodial). The gateway holds the key. See `swip-XXXX-remote-postage-stamp-signing.md`.
> * **SWIP-XXXX (Streamed postage stamp signing)** — gateway does the chunking and pushsync, but asks the user's device to sign every digest over a streaming transport. With mode (β) of this SWIP now available, that pattern is narrower in scope; see `swip-XXXX-streamed-postage-stamp-signing.md`.

## Abstract

Standardises a client-side stamping flow in which the client owns the postage batch's owner key, computes each chunk's address, allocates `(index, timestamp)` from a client-side issuer state, signs the digest locally, and ships pre-stamped chunks to the Swarm network. No private key ever leaves the client.

The client-to-network leg has **two normative transport modes**, both of which Bee already supports:

* **(α) HTTPS to a key-less Bee gateway**, riding the existing `presignedStamper` path (`pkg/postage/stamper.go: NewPresignedStamper`, `POST /chunks` + `Swarm-Postage-Stamp` header, `POST /chunks/stream`). Works against every Bee version. The gateway is an application-layer hop.
* **(β) Direct libp2p over secure WebSocket (`wss://`) to a Bee peer**, available since Bee **v2.7.0** (`p2p-wss-enable: true`, AutoTLS via `libp2p.direct`). The client speaks Bee's native `pushsync` and `retrieval` protocols as a real libp2p light peer; the peer it dials is a transport hop, not an application-level intermediary. Storer receipts flow back to the client.

This SWIP does not introduce new Bee endpoints. Its purpose is to (a) specify the client-side stamping algorithm so independent implementations interoperate, (b) specify multi-session collision-avoidance rules, (c) define a recommended deterministic key-derivation flow for browser wallets (e.g. MetaMask), (d) define the two normative network transports and when to use which, and (e) define the trust-dispersion patterns (multi-gateway / multi-peer) that make the "key-less hop" property meaningful in practice.

## Motivation

The **Server-side delegated** pattern (Pattern 1) requires the gateway to hold the batch owner key. For a meaningful class of users — privacy-sensitive applications, regulated environments, archive operators publishing on behalf of third parties, dapps positioning as non-custodial — this trust model is unacceptable. They want the on-chain `owner` of the batch to be a key the gateway has never seen and cannot replicate.

Two upstream developments have together made full self-custody uploads from a browser practical in 2026:

1. **`presignedStamper`** in `pkg/postage/stamper.go` accepts pre-built stamps over `POST /chunks` and `POST /chunks/stream`. Available across all current Bee versions. Forms the basis of transport mode (α).
2. **Bee v2.7.0 `p2p-wss-enable` + AutoTLS** ([release notes](https://github.com/ethersphere/bee/releases/tag/v2.7.0), PR #5187 / #5204) lets any Bee node accept inbound libp2p connections from browsers over `wss://` with zero manual TLS provisioning. Browsers can therefore participate as **real libp2p light peers** rather than HTTP clients of a gateway. Hardened in v2.7.1 for adoption at scale ([release notes](https://github.com/ethersphere/bee/releases/tag/v2.7.1)). Forms the basis of transport mode (β).

What remains missing — and what this SWIP fixes — are the protocol-level interop details:

* No specification documents how a client should compute `(index, timestamp)` consistently with what other clients (and other sessions of the same client) would compute, leading to bucket / slot collisions across sessions.
* No specification covers deterministic key derivation, which is the only realistic way for a browser dapp to provide "same key across devices" UX without exposing the user's wallet to per-chunk signing.
* Bee nodes have no normative obligation to disclose or refuse this mode, leading to inconsistent UX.
* No specification ties together "client-side stamping" with the `wss://` transport story, so dapp authors don't know which to pick when.
* No reference JS/TS library has emerged with a stable shape, so every dapp writes its own.

A SWIP fixes these so a reference library can be built, audited, and reused across Beeport-style products, dapp publishers, archivers and personal-storage tools.

## Specification

### Overview

1. **On-chain:** the user calls `createBatch(_owner = clientHotKeyAddress, ...)` from their wallet (e.g. MetaMask). The on-chain owner of the batch is a key only the client knows.
2. **Locally on the client:** for each chunk produced from the upload, the client allocates `(index, timestamp)` from its own issuer state, computes `digest = ToSignDigest(chunkAddress, batchID, index, timestamp)`, signs with the hot key, and assembles the 113-byte stamp.
3. **Over the network:** the client `POST`s the chunk together with its pre-built stamp to a Bee gateway. The gateway validates the stamp via `presignedStamper.Stamp` and pushsyncs the chunk to the Swarm network.
4. **The gateway holds no key.** The gateway never sees the hot key, cannot produce stamps for any other chunk, and cannot stamp on the user's behalf for future uploads.

### Architecture (two transport modes)

#### Mode (α) — HTTPS to a key-less Bee gateway

```text
┌──────────────────────────────────────┐                ┌───────────────────────────┐
│ Client (browser / CLI / mobile)      │                │ Bee gateway (key-less)    │
│                                      │                │                           │
│  ┌──────────┐                        │                │   POST /chunks            │
│  │ Wallet   │ → createBatch(         │                │   per request:            │
│  │ (cold)   │    _owner = HOT_KEY)   │                │     body: 4 KB chunk      │
│  └──────────┘                        │                │     header: stamp[113]    │
│                                      │                │                           │
│  ┌────────────────────────────────┐  │                │   path: presignedStamper  │
│  │ Hot key (in-memory or          │  │                │     - verify sig          │
│  │ deterministically derived)     │  │                │     - check recovers to   │
│  └────────────────────────────────┘  │                │       on-chain owner      │
│                                      │                │     - check bucket/index  │
│  ┌────────────────────────────────┐  │  per chunk     │       consistency         │
│  │ Stream pipeline:               │  │  POST /chunks  │     - pushsync            │
│  │   read → BMT → addr →          │  │ ─────────────► │                           │
│  │   peek → digest → sign →       │  │                │   Bee never sees a key.   │
│  │   commit → stamp → POST        │  │                │   Bee returns 200 OK,     │
│  └────────────────────────────────┘  │                │   not a storer receipt.   │
│                                      │                │                           │
│  Manifest assembly (mantaray) in     │                └───────────────────────────┘
│  client OR via raw chunk uploads.    │
└──────────────────────────────────────┘
```

* **Trust posture:** the gateway is an application-level intermediary. It validates and forwards. It cannot mint or alter stamps. A malicious gateway can drop chunks (detect via retrieval check from a different gateway) and can *fail to provide a storer receipt* (the gateway's `200 OK` is its own — not the storer's signed acknowledgement).
* **Compatibility:** all Bee versions. Use this mode when the client cannot host a libp2p stack or when the Bee endpoint exposes only HTTP.

#### Mode (β) — Direct libp2p over WSS to a Bee peer (Bee v2.7.0+)

```text
┌──────────────────────────────────────┐                ┌─────────────────────────────┐
│ Client (libp2p-js light peer)        │                │ Bee peer with WSS enabled   │
│                                      │                │ (`p2p-wss-enable: true`,    │
│  ┌──────────┐                        │                │  AutoTLS via libp2p.direct) │
│  │ Wallet   │ → createBatch(         │                │                             │
│  │ (cold)   │    _owner = HOT_KEY)   │                │   wss://<peerID>            │
│  └──────────┘                        │                │       .libp2p.direct/       │
│                                      │                │                             │
│  ┌────────────────────────────────┐  │  libp2p secure │   speaks the standard       │
│  │ libp2p-js                      │  │  channel       │   /swarm/pushsync/<v>       │
│  │   - noise / TLS handshake      │  │ ◄────────────► │   protocol                  │
│  │   - multistream-select         │  │                │                             │
│  │   - protocol: pushsync         │  │   per chunk:   │   - validate stamp via      │
│  │     (length-prefix protobuf)   │  │   pushsync     │     presignedStamper rules  │
│  └────────────────────────────────┘  │   request →    │   - forward to neighbour    │
│                                      │   ← receipt    │     responsible for the     │
│  ┌────────────────────────────────┐  │                │     chunk's neighbourhood   │
│  │ Stream pipeline as above,      │  │                │   - return signed STORER    │
│  │ plus: verify storer receipt    │  │                │     receipt                 │
│  │ for each chunk                 │  │                │                             │
│  └────────────────────────────────┘  │                └─────────────────────────────┘
└──────────────────────────────────────┘
```

* **Trust posture:** the dialled Bee peer is a **transport hop**, equivalent to any other libp2p relay. It cannot mint or alter stamps and **cannot suppress storer receipts** without itself producing detectably-invalid receipts on behalf of others (which the client checks). The client gets cryptographic placement proof per chunk.
* **Compatibility:** Bee v2.7.0+ on the dialled peer; the rest of the Swarm overlay can be any version, since the dialled peer bridges into the standard libp2p mesh over TCP/QUIC.
* **Browser limits:** browser tabs suspend, the OS may kill long-lived sockets, and concurrent connection caps apply per-origin. This mode is usable from desktop browsers for sessions of minutes; for hours-long uploads use a CLI / desktop-app client.

### Hot-key generation (normative)

A conformant client **MUST** support at least one of the following key sources, and **SHOULD** make the choice explicit to the user:

#### (A) Ephemeral session key (RECOMMENDED for one-shot uploads)

* Generated locally with a cryptographically secure RNG (e.g. `crypto.getRandomValues` + `secp256k1.utils.randomPrivateKey()`).
* Held in process memory only; **MUST NOT** be persisted.
* Lifetime is the upload session; on session end the key is unrecoverable.
* `_owner` for `createBatch` is the corresponding 20-byte address.
* Future `topUp` is permissionless and works without the key. Future `increaseDepth` is impossible (no one owns the key).

#### (B) Deterministic derivation from a wallet signature (RECOMMENDED for repeated upload sessions)

A conformant deterministic derivation:

1. The client constructs a **fixed canonical message**:

   ```
   "Swarm postage stamping key derivation v1\nPurpose: " || <purpose> || "\nWallet: " || <walletAddressLowercaseHex>
   ```

   where `<purpose>` is a human-readable application identifier (e.g. `"beeport.app"`).
2. The user signs this message with their wallet via `personal_sign` (EIP-191). MetaMask and other compliant wallets use RFC 6979 deterministic ECDSA, so the signature is stable across sessions and devices for the same wallet and message.
3. The hot key is derived as `hotKey = keccak256(signature)`, interpreted as a secp256k1 private key (rejecting and re-deriving with a counter suffix on the negligibly-rare invalid result).
4. The client **MAY** cache the derived `hotKey` in IndexedDB encrypted under a key obtained from the user (e.g. a passphrase) to avoid prompting MetaMask on every session.

Trade-off: the holder of any one signature of the canonical message can derive the hot key permanently. UI **MUST** make this clear at the prompt.

#### (C) User-imported key

The client **MAY** accept a user-supplied private key or keystore (only when explicitly invoked). **MUST NOT** transmit such a key to any remote service.

### On-the-wire stamp layout

Unchanged from `pkg/postage/stamp.go`:

```
batchID[32] | index[8] | timestamp[8] | sig[65]
```

The `digest` signed is `ToSignDigest(chunkAddress, batchID, index, timestamp)` exactly as in upstream Bee. Encoding for the `Swarm-Postage-Stamp` HTTP header is lowercase `0x`-prefixed hex of the 113-byte concatenation.

### Client-side issuer state (normative)

A client MUST maintain, per `batchID`, an **issuer state** equivalent in semantics to Bee's `StampIssuer`:

* For each chunk address, derive `bucket = toBucket(bucketDepth, chunkAddress)` (top `bucketDepth` bits of the chunk address; `bucketDepth = 16` in upstream Bee).
* Per `bucket`, maintain a monotonically-increasing within-bucket counter `cnt`, starting at `0`.
* Allocation: `index = (bucket << 32) | cnt` packed into 8 bytes big-endian.
* `timestamp` = current unix-time in nanoseconds, big-endian into 8 bytes (matching Bee's `unixTime()`).

The client MUST persist issuer state across sessions for the same `batchID` (typically in IndexedDB / a local file), keyed by `batchID`.

#### Peek / sign / commit (normative)

To avoid burning slots on signing or upload failures, the client **MUST** implement a peek / sign / commit pattern:

1. `peek(chunkAddress) → (index, timestamp)`: compute the slot the chunk would receive, **without** advancing the persistent counter.
2. Sign the digest, build the stamp, `POST /chunks` with the stamp.
3. On `200 OK` from the gateway: `commit(index, timestamp)`, persisting the advanced counter.
4. On any failure prior to commit: discard the peeked allocation. A subsequent `peek` for the same `chunkAddress` MUST return the same `(index, timestamp)` pair until commit, so retries hit the same slot.

This mirrors the peek / sign / commit refactor described in the Server-side sibling SWIP, applied client-side.

### Multi-session collision avoidance (normative)

Two browser tabs uploading to the same `batchID` will allocate identical `(bucket, cnt)` pairs unless they coordinate. Implementations **MUST** implement at least one of:

#### (i) Single-active-session lock

* Use [Web Locks API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API) (`navigator.locks.request`) or the equivalent in non-browser environments to acquire an exclusive lock on `swarm-postage-stamper:<batchID>` for the duration of the upload.
* Other tabs / processes attempting concurrent uploads to the same batch MUST wait or fail visibly.

#### (ii) Bucket-range partitioning

* The client **MAY** partition `bucket` space across concurrent sessions. The partition assignment itself MUST be persisted and exclusive (typically guarded by a lock as in (i) at acquisition time).
* Capacity tradeoff: this can leave buckets under-filled, reducing effective batch utilisation.

A non-conformant client that produces colliding `(batchID, bucket, cnt)` allocations will see the second-arriving chunk's stamp rejected on the wire (the network's `Stamp.Valid` check fails on the bucket-already-used invariant for immutable batches). This is a hard failure observed only after pushsync; clients MUST defend against it locally.

### Upload protocol

#### In Mode (α) — HTTPS

A conformant client **MUST** support one of:

* `POST /chunks` per chunk, with `Swarm-Postage-Stamp: 0x<113-byte-hex>` header. Simple, but HTTP/1.1 head-of-line blocking caps throughput.
* `POST /chunks/stream` (WebSocket variant in upstream Bee). RECOMMENDED for any upload over ~1 MB.

#### In Mode (β) — libp2p WSS

A conformant client **MUST**:

* Open a libp2p connection over `/wss/...` to a peer whose multiaddr is reachable. Recommended via `libp2p-js` with the WebSocket transport.
* Use the standard Bee `pushsync` protocol identifier (`/swarm/pushsync/<version>` — exact name and protobuf shape per upstream Bee). The pushsync request body carries the chunk content and the 113-byte stamp.
* Verify the **storer receipt** returned by the dialled peer recovers to a peer ID that lies in the chunk's expected neighbourhood (per Bee's standard receipt validation rules).
* Discover candidate WSS peers via either: (i) a configured static bootnode list, (ii) the `/addresses` HTTP endpoint of any reachable Bee returning the node's `wss` underlay if any, or (iii) a community-maintained registry. At least one method MUST be configurable.

#### Manifest assembly (both modes)

After all leaf chunks are uploaded, the client either:

* Builds the manifest (mantaray) locally and uploads it as one more chunk with the same per-chunk stamping flow. This keeps the upload fully client-side.
* Uploads via `POST /bzz` with `Swarm-Postage-Stamp` and `Swarm-Custom-Manifest` semantics — out of scope here; described per Bee's existing `/bzz` API. Mode (α) only; not all gateways enable this. Mode (β) requires client-side manifest assembly because there is no `/bzz` endpoint over libp2p.

### Multi-gateway / multi-peer dispersion (RECOMMENDED)

The "key-less hop" property of either transport mode is meaningful only if the user can switch hops freely. A conformant client SHOULD be configured with **multiple independent endpoints** (gateways in mode (α), peers in mode (β)) and SHOULD round-robin or fan-out chunks across them. Concretely:

* The client library API SHOULD treat the endpoint list as plural: `endpoints: string[]` (URLs in mode (α), multiaddrs in mode (β)).
* Per-chunk failure SHOULD trigger retry against a different endpoint before surfacing to the application.
* The client SHOULD periodically (e.g. every N chunks) re-fetch a recently-uploaded chunk from a *different* endpoint than the one it was uploaded through, to detect silent dropping.
* Rationale: any single hop becomes statistically unable to grief the upload; trust in any one operator approaches zero as the endpoint set grows.

### Bee node requirements

A Bee node supporting this pattern in **Mode (α)** MUST:

* Accept `POST /chunks` (and SHOULD accept `POST /chunks/stream`) with the `Swarm-Postage-Stamp` header set, routing to the existing `presignedStamper.Stamp` path.
* Verify the supplied stamp with `Stamp.Valid` against the on-chain `owner` of the supplied `batchID` before pushsync.
* Refuse the chunk with a structured error if validation fails (`{ "error": "<code>", "message": "..." }`).
* **NOT** maintain per-batch issuer state for client-stamped batches: if the node later receives a *server-stamping* request for the same `batchID` (i.e. the user contradicts themselves), it MUST refuse. (Mixing client-stamped and server-stamped uploads on the same batch is a configuration error and risks slot collisions.)

A Bee node supporting this pattern in **Mode (β)** MUST (in addition to standard libp2p / pushsync behaviour):

* Have `p2p-wss-enable: true` and EITHER an operator-provisioned TLS cert on `p2p-wss-addr` OR AutoTLS configured (`autotls-domain: libp2p.direct` and the registration / CA endpoints).
* Advertise its `wss` multiaddr via the standard Bee `/addresses` API and via libp2p's hive gossip, so clients can discover it.
* Validate `presignedStamper`-style stamps on inbound pushsync requests just as it would for any other peer.

A Bee node **SHOULD** advertise its support via the discovery endpoint `GET /v1/postage/capabilities` returning at minimum:

```json
{
  "clientSideStamping":  { "http": true, "wssLibp2p": true },
  "serverSideStamping":  true|false,
  "streamedSigning":     true|false
}
```

(Aligned with the Server-side sibling SWIP's `capabilities` endpoint; the `clientSideStamping` field is structured to indicate which transport modes are accepted.)

### Configuration knobs (Bee node)

| Variable | Meaning |
| -------- | ------- |
| `postage-clientside-enabled` | Boolean; default `true`. Operators MAY disable to refuse client-stamped uploads in mode (α). |
| `postage-clientside-batch-allowlist` | Optional explicit list of `batchID`s for which client-stamped uploads are accepted (applies to both modes). |
| `postage-clientside-rate-limit` | Per-source-identifier rate limit on `presignedStamper` validations; see §Operator surfaces. |
| `p2p-wss-enable` | Upstream Bee v2.7.0+ flag. Required for mode (β). |
| `autotls-domain` | Upstream Bee v2.7.0+ flag, default `libp2p.direct`. Required for zero-touch TLS in mode (β). |

### Storer receipts and placement proof

* **Mode (α)** returns `200 OK` from the gateway. This is the *gateway's* acknowledgement, not the storer's. A client requiring cryptographic proof of placement in mode (α) MUST perform an independent retrieval check from a different gateway, and even then receives only "the chunk is fetchable", not a signed receipt from the storer responsible for the neighbourhood.
* **Mode (β)** returns the standard Bee storer receipt — a signature by the storing peer over the chunk address — at the libp2p `pushsync` protocol level. The client MUST verify the receipt's signer ID lies within the chunk's expected neighbourhood per Bee's standard receipt-validation rules. This delivers actual cryptographic placement proof to the client, not just transport acknowledgement.

Mode (β) is therefore strictly stronger on placement proof; mode (α) compensates with retrieval-based sampling. Conformant implementations of either mode SHOULD make the chosen verification strategy observable in their public API (e.g. `result.placementProof: { kind: "storer-receipt" | "retrieval-sample" | "none" }`).

### Throughput and CPU cost (informative)

For a typical 1 GB upload (~250 000 chunks):

* **secp256k1 sign**, browser, single-threaded `@noble/secp256k1`: 3–10 k/s ⇒ 25–80 s of CPU.
* **secp256k1 sign**, browser, 4× Web Workers: typically <10 s of CPU.
* **BMT hash**, browser: similar order of magnitude as signing per chunk.
* **Streaming the file**: required; clients MUST stream input via `File.stream()` / `ReadableStream` rather than loading the file into memory.
* **Network in mode (α)** dominated by `POST /chunks/stream` round-trips; HTTP/2 or the WebSocket stream variant reduces head-of-line blocking.
* **Network in mode (β)** dominated by libp2p stream multiplexing; pushsync requests can be pipelined down a single multiplexed connection. Per-chunk overhead is lower than HTTP framing.

Implementations targeting >100 GB uploads SHOULD be CLI/desktop tools, not browser tabs (regardless of transport mode — the limit is browser process lifetime, not the protocol).

### Non-goals

* Modifying `Stamp.Valid` or any consensus-affecting on-chain or off-chain check.
* Defining a new Bee endpoint. This SWIP rides existing endpoints.
* Authenticating the *client to the gateway*. Gateways may apply their own access control (rate limits, API keys, captchas) orthogonally.
* Specifying browser wallet UI flows. The recommended deterministic-derivation flow is one option among several.

## Rationale

* **Two transports, one stamping algorithm:** the client-side stamping work — chunking, hashing, issuer state, signing — is identical regardless of transport. Only the "how do these chunks get into the network" leg differs. Specifying both modes lets the client library treat transport as a pluggable layer.
* **Reuse the existing `presignedStamper` path** in mode (α): already-merged across all Bee versions; the only thing missing was shared client-side semantics.
* **Reuse Bee v2.7.0+ `wss://` libp2p transport** in mode (β): no new Bee work is required. AutoTLS via `libp2p.direct` removes the historical operator friction.
* **Normative client-side issuer state:** the single biggest interop hazard is two clients allocating the same `(bucket, cnt)`. Specifying the algorithm and the multi-session lock makes a reference library tractable.
* **Recommend deterministic derivation:** without it, every dapp would either prompt MetaMask 250 000 times (unusable) or invent its own "let me hold your private key in localStorage" pattern (insecure). RFC-6979-based derivation is a known-safe primitive that fits browser wallet capabilities.
* **Hop is always a forwarder:** in either mode, the dialled Bee node cannot stamp anything beyond what the user signs. The trust difference is in *placement proof* and in whether the hop sits at HTTP layer (mode α) or libp2p layer (mode β).
* **Multi-hop dispersion as first-class:** any single hop becomes inert as N grows; the SWIP recommends this as the default deployment shape rather than an optional extra.

## Backwards compatibility

Fully compatible. Uses only existing Bee surfaces:

* Mode (α) uses `POST /chunks` / `POST /chunks/stream` and `presignedStamper` — present in every supported Bee version.
* Mode (β) uses the libp2p WSS listener introduced in Bee v2.7.0 plus the standard `pushsync` protocol that all Bee nodes already speak.

Bee deployments not exposing the relevant endpoints / transports simply cannot serve the corresponding mode; no upgrade is forced on any node, and clients can fall back from mode (β) to mode (α) at runtime if no WSS-enabled peer is reachable.

## Security implications

* **Hot key in client process:** the user trusts their own device. A compromised browser process can sign arbitrary stamps on the user's batch. This is the core trade-off of self-custody.
* **Deterministic derivation:** any party who can prompt the user to sign the canonical message — including a phishing dapp — can derive the same hot key. Wallet UIs that show "Beeport wants to sign a message" are NOT sufficient mitigation; users must be educated. Implementations SHOULD scope `<purpose>` to a domain to limit cross-application key reuse.
* **Gateway misbehaviour:** a dishonest gateway can drop chunks, return false `200 OK`s without pushsync, or silently re-route. The client SHOULD verify uploads by re-fetching at least a sample of chunks from a different gateway.
* **Network observability:** chunks are content-addressed; a passive observer can correlate uploads on the wire with later retrievals. This is independent of stamping pattern.

## Operator surfaces

### Metrics (gateway, normative minimum)

* `presigned_stamp_requests_total` (counter, labels: `result` ∈ {`accepted`, `invalid_signature`, `unknown_batch`, `bucket_conflict`, `rate_limited`})
* `presigned_stamp_validation_duration_seconds` (histogram)
* `presigned_stamp_inflight` (gauge)

### Rate limiting

Operators **SHOULD** rate-limit `presignedStamper` validations per source identifier to prevent DoS. Validation is cheap (~1 ms) but pushsync is not.

## Reference implementation

A normative reference TypeScript / JavaScript library is to be published alongside this SWIP, providing:

* `createSession({ batchID, hotKeySource, transport })` — opens an exclusive `navigator.locks` lock on the batch, loads issuer state from IndexedDB. `transport` is one of `{ kind: "http", endpoints: [...] } | { kind: "wssLibp2p", peers: [...] }`.
* `uploadFile(file, { manifest: 'client' | 'gateway' })` — streams the file, performs peek / sign / commit per chunk, dispatches to the configured transport (with multi-endpoint dispersion built in), returns the swarm reference and a `placementProof` per chunk.
* `derivePostageKey(wallet, purpose)` — implements the deterministic derivation flow.
* `discoverWssPeers(seedURLs)` — queries `/addresses` on a small seed set of known Bee gateways and returns any advertised `wss` multiaddrs, for transport (β) bootstrap.

The reference is intended to be reused by Beeport, gateway dapps, archivers and personal-storage tools; non-reference implementations MUST conform to the algorithms in §Specification but MAY differ in API shape.

The library SHOULD prefer mode (β) when at least one WSS-enabled peer is reachable (better placement proof, fewer trust assumptions), and gracefully fall back to mode (α) otherwise.

## Testing

* **Conformance test vectors** for client-side issuer state: a fixed sequence of `chunkAddress` values and the expected `(bucket, cnt, index, timestamp)` allocations.
* **Conformance test vectors** for deterministic derivation: a fixed `(walletPrivateKey, purpose) → derivedHotKey` mapping using a deterministic mock wallet.
* **Integration tests, mode (α):** browser uploads against an off-the-shelf Bee with `postage-clientside-enabled=true`; pushsync recipient accepts chunks; `Stamp.Valid` passes against the on-chain `owner`.
* **Integration tests, mode (β):** browser opens a `wss://` libp2p connection to a Bee v2.7.1+ peer with `p2p-wss-enable: true` (AutoTLS-issued cert); performs pushsync; verifies storer receipt against expected neighbourhood.
* **Multi-session test:** concurrent uploads from two tabs to the same `batchID`; the second tab MUST either block or fail visibly with `lock_unavailable`.
* **Multi-endpoint dispersion test:** with N=3 endpoints and one configured to silently drop chunks, the upload completes successfully and the dropped chunks are detected via cross-endpoint retrieval sampling.
* **Failure injection:** signing failure, gateway 5xx, lost commit, libp2p connection drop — issuer state MUST NOT advance.

## Roadmap

1. Publish reference TypeScript library implementing both transport modes of this SWIP, with mode (α) as primary on day one and mode (β) added as `libp2p-js` integration matures.
2. Land conformance test vectors in `ethersphere/swarm-test-vectors` (or equivalent).
3. Coordinate with Swarm Foundation / Beeport / public gateway operators to enable `p2p-wss-enable: true` on a baseline set of nodes that browser clients can bootstrap against.
4. Establish a small bootstrap registry (static JSON list, or feed-published) of known WSS-enabled Bee peers, refreshed by community.
5. Browser dapp tutorial: "publish a site to Swarm with self-custody stamping in 50 lines" — covering both modes.

## Related SWIPs

| Pattern | Where the hot key lives | Client-to-network transport | Trust placed in any single hop |
| ------- | ----------------------- | --------------------------- | ------------------------------ |
| **Server-side delegated** (`swip-XXXX-remote-postage-stamp-signing.md`) | Gateway operator's HSM / KMS / sidecar | n/a — gateway both stamps and pushsyncs | High (gateway is the operator) |
| **This SWIP — Client-side**, mode (α) | End-user device | HTTPS to key-less Bee gateway via `presignedStamper` | Low (gateway can drop, cannot stamp) |
| **This SWIP — Client-side**, mode (β) | End-user device | Direct libp2p over `wss://` to a v2.7.0+ Bee peer; native pushsync with storer receipts | Minimal (peer is a transport hop) |
| **Streamed postage stamp signing** (`swip-XXXX-streamed-postage-stamp-signing.md`) | End-user device (typically browser) | Application-layer WebSocket; gateway does chunking + pushsync | Low for stamping; relies on gateway for assembly |

The introduction of mode (β) in Bee v2.7.0 narrows the use case for the **Streamed postage stamp signing** SWIP: when chunking and manifest assembly can run in the client (this SWIP), Streamed signing's main motivation — "browser holds the key but can't pushsync" — no longer applies. Streamed signing remains valuable for clients too constrained to chunk locally; see that SWIP's updated motivation.

## References

* [ethersphere/bee](https://github.com/ethersphere/bee) — `pkg/postage/stamp.go` (`ToSignDigest`, `Valid`, `BucketIndexFromBytes`), [`pkg/postage/stamper.go`](https://github.com/ethersphere/bee/blob/master/pkg/postage/stamper.go) (`NewPresignedStamper`).
* `POST /chunks`, `POST /chunks/stream`, `GET /addresses` — Bee OpenAPI spec.
* [Bee v2.7.0 release](https://github.com/ethersphere/bee/releases/tag/v2.7.0) — `p2p-wss-enable`, `nat-wss-addr`, AutoTLS via `libp2p.direct`, multi-underlay address advertisement (PR #5187, #5204).
* [Bee v2.7.1 release](https://github.com/ethersphere/bee/releases/tag/v2.7.1) — WSS adoption-at-scale stability fixes.
* [p2p-forge / libp2p.direct](https://github.com/ipshipyard/p2p-forge) — AutoTLS service used by Bee.
* [libp2p WebSocket transport spec](https://github.com/libp2p/specs/blob/master/websockets/README.md).
* [RFC 6979](https://datatracker.ietf.org/doc/html/rfc6979) — Deterministic Usage of the DSA and ECDSA.
* [EIP-191](https://eips.ethereum.org/EIPS/eip-191) — Signed Data Standard (used by `personal_sign`).
* [Web Locks API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API).
