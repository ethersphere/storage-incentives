---
SWIP: XXXX
title: Server-side delegated postage stamp signing (gateway-custody pattern)
author: TBD (@github-handle)
discussions-to: TBD (open a GitHub Discussion on ethersphere/SWIPs and link it here)
status: Draft
category: Client
created: 2026-04-26
---

# Server-side delegated postage stamp signing

> **Pattern 1 of three.** This SWIP defines a **gateway-managed (custodial)** stamp-signing pattern: the Bee node delegates per-chunk signing to an external signer that the gateway operator controls. Two complementary patterns are specified in sibling SWIPs:
>
> * **SWIP-XXXX (Client-side postage stamping)** — self-custody by the user; the client owns the hot key and pre-builds stamps; Bee is a key-less forwarder. See `swip-XXXX-client-side-postage-stamping.md`.
> * **SWIP-XXXX (Streamed postage stamp signing)** — self-custody by the user with a remote Bee that does the heavy lifting; the user's hot key (typically in a browser tab) connects in to Bee and signs digests on demand. See `swip-XXXX-streamed-postage-stamp-signing.md`.
>
> All three share the same on-chain semantics, on-the-wire stamp layout, and `Stamp.Valid` rules. They differ only in where the owner key lives and who initiates the signing call.

## Abstract

Describes a Bee client extension so that **Swarm postage stamps** attached to chunks during upload can be signed with the **batch owner's key** even when that key is **not** the Bee node's configured Ethereum signer. The Bee node continues to manage **stamp issuer state** (per-batch index, buckets, timestamps); only the production of the 65-byte ECDSA signature over the fixed digest `ToSignDigest(chunkAddr, batchID, index, timestamp)` is delegated to an **external signer** reached over a defined API (or to a pluggable in-process module).

The signer is operated by the same party that operates the Bee gateway (or by an infrastructure component the gateway trusts: HSM, KMS, custody service). This is an explicit **custodial** pattern from the user's perspective: the user funds the batch on-chain, but the gateway operates it. Trust implications are spelled out in §User trust model.

`Stamp.Valid`, `RecoverBatchOwner`, the on-the-wire stamp layout, and `ValidStamp(batchStore)` in pushsync/pullsync are **unchanged**: every produced signature must still recover to the on-chain `owner` recorded in `PostageStamp.batches[batchID].owner`.

## Motivation

### Owner key and node key are not always the same

The `PostageStamp` contract allows the **payer** (`msg.sender`) and the **stored `owner`** of a batch to differ. On the network, every valid chunk stamp is checked so that the **ECDSA signature** on the stamp recovers to the **batch `owner` address** (see `Stamp.Valid` and `ValidStamp` in [`pkg/postage`](https://github.com/ethersphere/bee/tree/master/pkg/postage)). The default Bee stamper signs with the node's `crypto.Signer`, so in practice the on-chain `owner` must match the node's key for stamps to be valid.

Gateway operators need deployment patterns where:

* the **owner key** is held by an HSM, a KMS, a custody service, or a per-user derived key managed by the gateway operator;
* a **gateway Bee** still performs chunking, reserve interaction, manifest assembly, and pushsync;
* **no long-lived owner private key** is stored as a file on the gateway VM.

### Existing alternatives and why they are insufficient for this pattern

Today this is solvable in three ways, all with drawbacks for a gateway operator:

1. **Run Bee with the owner key in `crypto.Signer`.** Forces gateway and key custody into the same trust boundary. Operators cannot use HSMs or per-user keys without forking Bee.
2. **Pre-stamp every chunk out-of-band**, then upload via the existing `presignedStamper` path (`pkg/postage/stamper.go: NewPresignedStamper`). This is the path used by the **Client-side** sibling SWIP and is the right answer when the user wants self-custody, but it is a heavy integration for thin gateways: the client has to chunk, hash, allocate issuer state, and assemble manifests itself.
3. **Bespoke gateway-side signing shims.** Some operators have built ad-hoc bridges between their Bee and an HSM. Every operator's wire format is different, every operator's idempotency story is different, and none of them are reviewable as a standard.

A standardised **server-side delegation** interface keeps Bee in charge of chunking, reserve, manifest assembly and issuer state, while moving only the signing primitive out — one wire format that all gateway operators, HSM proxies and custody services implement once.

### Security and operational clarity

A SWIP-level specification makes behaviour predictable for:

* authentication between Bee and the signer (mTLS, bearer tokens, short-lived sessions);
* failure modes when signing lags or fails after issuer index allocation;
* metric and log surfaces for operators;
* **custodial trust boundaries** between gateway operator, end user, and key-management infrastructure.

## Specification

### Overview

1. **Unchanged:** digest construction `ToSignDigest(chunkAddr, batchID, index, timestamp)` and stamp serialisation; `Stamp.Valid` / `RecoverBatchOwner`; `ValidStamp(batchStore)` in pushsync/pullsync; the 113-byte on-the-wire stamp layout `batchID[32]|index[8]|timestamp[8]|sig[65]`.
2. **Changed:** `pkg/postage` introduces a new `RemoteStampSigner` interface with a single method, conceptually:

   ```go
   type RemoteStampSigner interface {
       Sign(ctx context.Context, batchID, chunkAddress, index, timestamp []byte) (sig []byte, err error)
   }
   ```

   When configured for a given batch, `Stamper.Stamp` uses this interface in place of the node's `crypto.Signer`. A new interface (rather than reusing `crypto.Signer.Sign(digest)`) is required because the remote signer needs the four constituent fields to (a) recompute the digest itself and (b) enforce slot-level idempotency — see §Replay safety.
3. **Unchanged responsibility:** Bee remains the source of truth for **issuer increments** and **stamp index / timestamp** assignment for a given batch.

### Architecture

```text
┌─────────────┐  batchID, chunkAddr, index, ts  ┌──────────────────────────┐
│ Bee stamper │ ──────────────────────────────► │ External stamp signer    │
│ (issuer     │ ◄────────────────────────────── │ (HTTP over TCP or Unix)  │
│  state)     │           65-byte sig           │ Holds batch owner key(s) │
└─────────────┘                                 └──────────────────────────┘
```

* **Bee:** holds and advances issuer state, builds the digest *or* the four fields, calls the signer, assembles `postage.Stamp`, attaches it to the chunk.
* **External signer:** authenticates the caller, resolves which owner key corresponds to `batchID`, recomputes `ToSignDigest`, signs, and returns `sig`.
* **Trust boundary:** the signer **MUST** only sign for batches whose owner key it controls; Bee **MUST** authenticate to the signer.

> Future transports (gRPC, JSON-RPC over WebSocket, etc.) are explicitly out of scope of this SWIP; only HTTP over TCP and HTTP over Unix domain socket are normative for v1.

### Configuration (Bee)

Normative keys (names illustrative; exact flags left to implementation):

| Variable | Meaning |
| -------- | ------- |
| `postage-signer-default` | Base URL of the default external signer: `https://host:port`, or `unix:///path/to/sock` for a sidecar. Empty = use local `signer` only (current behaviour). |
| `postage-signer-by-batch` | Optional map `batchID → endpoint` overriding the default per batch. Different batches may have different owners and therefore different signers. |
| `postage-signer-auth` | mTLS configuration (client cert + key + CA bundle) applied to the default endpoint. A bearer token MAY be configured **in addition** to mTLS for application-layer authorisation, but MUST NOT be used as the sole credential over the network. Per-endpoint auth may be configured alongside `postage-signer-by-batch`. |
| `postage-signer-timeout` | Per-request timeout (default `5s`). |
| `postage-signer-batch-allowlist` | Optional explicit allowlist of batch IDs for which delegation is enabled (reduces blast radius when an endpoint is shared). |

If both `postage-signer-by-batch` and `postage-signer-default` are unset, no delegation occurs and Bee behaves exactly as today.

### HTTP signer API (normative minimum)

#### `POST {endpoint}/v1/postage/sign`

Transport: HTTPS with mTLS for any non-loopback / non-Unix-socket deployment (see §Security implications).

Headers:

* `Authorization: Bearer <token>` (optional, application-layer; **not** a substitute for mTLS on the network)
* `Content-Type: application/json`

Body (JSON):

```json
{
  "batchID":      "0x…64 hex…",
  "chunkAddress": "0x…64 hex…",
  "index":        "0x…16 hex…",
  "timestamp":    "0x…16 hex…",
  "requestID":    "optional opaque string for log correlation"
}
```

Encoding rules (normative):

* All byte values are lowercase, `0x`-prefixed hex.
* Exact byte lengths: `batchID` 32, `chunkAddress` 32, `index` 8, `timestamp` 8.
* The signer **MUST** recompute `digest = ToSignDigest(chunkAddress, batchID, index, timestamp)` and sign that. Clients **MUST NOT** send a precomputed `digest`; if a future revision adds one, it is informational only.

> Note: this differs from Bee's internal `stampJson` (which uses base64 for `[]byte`). Hex-with-`0x` is used here because it is what HSM proxies and web3 signers consume.

**Response:** `200 OK`

```json
{
  "signature": "0x…130 hex…",
  "owner":     "0x…40 hex…"
}
```

* `signature` is 65 bytes (`r||s||v`) compatible with `crypto.Recover` used in `RecoverBatchOwner`.
* `owner` is the 20-byte Ethereum address whose key produced the signature. Bee **SHOULD** verify it matches `batches[batchID].owner` and refuse the stamp otherwise (fast-fail before pushsync).

**Errors:** `4xx` / `5xx` with body `{ "error": "<code>", "message": "<human>" }`. Bee **MUST** surface a clear upload error and **MUST NOT** attach an invalid stamp. Recommended error codes: `unknown_batch`, `slot_exhausted`, `idempotency_conflict`, `unauthorized`, `rate_limited`, `internal`.

#### `GET {endpoint}/v1/postage/owners`

Returns the set of owner addresses the signer can sign for, so Bee can pre-flight at startup against the on-chain `owner` of each allowlisted batch and refuse to start in misconfiguration:

```json
{ "owners": ["0x…40 hex…", "0x…40 hex…"] }
```

#### `GET {endpoint}/v1/healthz`

`200 OK` with body `{ "status": "ok" }` when the signer can sign. Used for readiness probes and circuit-breaker logic in Bee.

### Replay safety and idempotency

The **idempotency key** for a sign request is `(batchID, index)` — and only those two fields. The signer:

* **MUST** record, per `(batchID, index)`, the signature it issued.
* **MUST** return the originally issued signature unchanged on retry of the same `(batchID, index)`.
* **MUST** reject with `idempotency_conflict` any request whose `(batchID, index)` matches a prior request but whose `chunkAddress` or `timestamp` differs.

Rationale: a misbehaving Bee could otherwise request signatures for many distinct `chunkAddress` values against the same `(batchID, index)` slot, burning batch capacity (immutable batches in particular cannot recover the slot) on chunks that are never uploaded. Including `chunkAddress` or `timestamp` in the idempotency key would silently allow this; excluding them prevents it.

### Semantics and ordering — peek / sign / commit

In current Bee, `Stamper.Stamp` **persists** the chosen `(index, timestamp)` and the `StampItem` **before** calling `signer.Sign`. With a local signer this is benign; with a remote signer, any signing failure leaves issuer state advanced and a `StampItem` recorded with no stamp ever emitted. For immutable batches, the burned slot is unrecoverable.

This SWIP therefore mandates a **peek / sign / commit** flow:

1. `StampIssuer` is refactored to expose `peek(addr) → (index, timestamp)` and `commit(index, timestamp)` (with implicit rollback if `commit` is never called within the upload session).
2. `Stamper.Stamp` calls `peek` under the issuer mutex, **releases the mutex**, calls the (local or remote) signer, and on success calls `commit` (re-acquiring the mutex briefly). On signer failure, neither the issuer counter nor the `StampItem` is persisted; no batch capacity is consumed.
3. `commit` MUST be deterministic: a re-`peek` after a failed sign attempt MUST yield the same `(index, timestamp)` pair until either committed or explicitly released, so that a retry against the signer hits the slot-level idempotency cache (§Replay safety) rather than racing for a fresh slot.

Local-`crypto.Signer` callers retain identical observable behaviour because `Sign` for a local signer is effectively infallible.

### Concurrency

Because the network round-trip happens **outside** the issuer mutex, a slow or unhealthy signer no longer stalls concurrent uploads to the same batch. Per-batch fairness is governed by the `peek`/`commit` cycle and any backpressure the operator chooses to apply at the signer endpoint.

### Optional HTTP API extensions on Bee's own upload endpoints

* `Swarm-Postage-Signer-Profile: <name>` on `POST /bzz` or `/chunks` — selects among multiple configured signer endpoints for that request.
* `Swarm-Postage-Signer-Disable: 1` — for a request, force the use of the node's local `crypto.Signer` even if a remote signer is configured for that batch (operator-side override; useful for debugging).

There is intentionally **no** "enable" header: a request from a client cannot turn on delegation that the operator has not configured. This is the inverse of the original draft, and is the safer polarity.

### Throughput

A single round-trip per chunk to a TCP-attached signer caps upload throughput at the signer's RTT. Two complementary mechanisms address this:

1. **Recommended deployment:** HTTP over Unix domain socket to a **co-located signer sidecar**. Removes network RTT as a bottleneck and is the default suggestion for production gateways.
2. **Optional batched endpoint:** `POST {endpoint}/v1/postage/sign-batch` (specified below) accepts an array of sign requests and returns an array of signatures, so a single network round-trip can cover N chunks for operators who must run the signer remote.

#### `POST {endpoint}/v1/postage/sign-batch` (optional)

Signers MAY implement this endpoint; Bee uses it opportunistically when configured. Bee MUST first issue `GET {endpoint}/v1/postage/capabilities` (returns `{ "batch": true|false }`) to discover support, and MUST NOT assume support based on version.

Body:

```json
{
  "requests": [
    { "batchID": "0x…", "chunkAddress": "0x…", "index": "0x…", "timestamp": "0x…", "requestID": "…" },
    …
  ]
}
```

Response (`200 OK`):

```json
{
  "results": [
    { "requestID": "…", "signature": "0x…", "owner": "0x…" },
    { "requestID": "…", "error": "idempotency_conflict", "message": "…" },
    …
  ]
}
```

Per-element errors do not fail the batch. Bee MUST process `results` in array order and apply per-element commit/rollback in `peek`/`commit` semantics independently. Idempotency rules (§Replay safety) apply to each element.

### Non-goals (this SWIP)

* Replacing `ValidStamp` or relaxing `owner` checks on the wire.
* Defining UI or wallet flows (browser EIP-712); those may wrap the same digest or call the HTTP signer.
* Changing `PostageStamp.sol` — not required.
* Defining a gRPC, JSON-RPC, or WebSocket transport — see the **Streamed** sibling SWIP for a connect-in transport that supports browser-held keys.
* Specifying client-side stamping (browser as full stamper) — see the **Client-side** sibling SWIP.

## User trust model (custodial pattern)

This pattern is **custodial from the user's perspective**. The user creates the postage batch on chain by paying BZZ from their own wallet (e.g. MetaMask), but sets `_owner = <gateway-controlled address>` in the `createBatch` call. From that moment on, the gateway operates the batch.

Implementations and integrators **MUST** present this honestly to end users. The accurate framing is "**prepaid stamping service operated by the gateway**", not "**user-owned batch**".

### What the user retains

* **Funds in the user wallet are never at risk.** A compromise of the gateway's signer cannot drain the user's wallet, sign other batches the user has not authorised, or perform any on-chain action other than producing stamps for batches the gateway already owns.
* **Direct on-chain `topUp(batchID, amount)`.** `PostageStamp.topUp` is **not** owner-restricted; any address with BZZ may extend any batch's lifetime. The user can keep their batch alive indefinitely without involving the gateway.
* **The decision to participate.** Future batches are not bound to this gateway; the user may set a different `_owner` on the next `createBatch`.
* **The right to walk away.** Stop uploading via the gateway and the batch's remaining capacity simply ceases to be consumed (modulo malicious behaviour by the gateway, see below).

### What the user cedes to the gateway

* **Control over what is stamped against the batch's capacity.** A malicious or buggy gateway can stamp content the user did not request, up to the batch's depth. Slot-level idempotency on the signer (§Replay safety) constrains a buggy *Bee* but not a malicious *gateway operator*.
* **`increaseDepth`.** Owner-only by the contract; the gateway is the only address that can call it.
* **Portability.** Without the hot key, no other gateway can produce valid stamps for this batch. The batch is functionally locked to the gateway for stamping until exhausted.

### Recommendations to integrators

* **UI MUST disclose** that the gateway holds the stamping key.
* **UI SHOULD surface** which gateway address is the on-chain `owner` of each of the user's batches, so the user can verify off-chain.
* **UI SHOULD offer** the **Client-side** sibling pattern as an alternative for users who require non-custodial stamping, when supported by the gateway.

## Rationale

* **Minimal crypto surface:** Only the signing step is delegated; digest construction and validation stay in Bee and match existing peers exactly.
* **Separation of duties:** Gateway Bee does not hold owner keys; HSM / custody stays at the signer.
* **Same upload surfaces:** Avoids requiring clients to implement multipart pre-stamped uploads (`NewPresignedStamper`) for large files unless they choose to.
* **New interface, not overloaded `crypto.Signer`:** allows the signer to enforce slot-level idempotency and recompute the digest, neither of which is possible if all it sees is a 32-byte hash.

## Backwards compatibility

* Default behaviour unchanged when no `postage-signer-*` keys are set: local `crypto.Signer` only.
* Network peers see identical stamp layout and validation rules.
* The new `RemoteStampSigner` interface is additive in `pkg/postage`; existing `Stamper` and `crypto.Signer` consumers are unaffected.

## Operator surfaces

### Key isolation tiers (RECOMMENDED)

Operators **SHOULD** choose an isolation tier explicitly and document it in their UI. From least to most isolated:

| Tier | One key per | Compromise blast radius | KMS overhead |
| ---- | ----------- | ----------------------- | ------------ |
| 1 | Whole gateway | All users' batches | Minimal |
| 2 | User account | All of one user's batches | Low — single HD seed in KMS, derive `m/44'/60'/0'/0/<userIndex>` |
| 3 | Batch | One batch | Moderate — derive `m/44'/60'/<userIndex>'/0/<batchIndex>` per `createBatch` |

Tier 2 is the **recommended default**: the per-user HD-derived key gives meaningful blast-radius reduction at negligible operational cost. Tier 1 **MUST NOT** be used for multi-tenant deployments.

The signer implementation **MUST** maintain an internal `batchID → key handle` routing table and **MUST** reject signing requests for batches outside that table with `unknown_batch`.

### Key custody backends (informative)

The signer process itself **SHOULD NOT** hold raw private key material. Recommended backends:

* AWS KMS asymmetric `ECC_SECG_P256K1` (signs raw 32-byte digests).
* GCP KMS `EC_SIGN_SECP256K1_SHA256`.
* HashiCorp Vault Transit, key type `ecdsa-p256k1`.
* Hardware HSM (YubiHSM 2, AWS CloudHSM, Thales / nCipher).

The signer is then a thin process that authenticates Bee, looks up the key handle, calls the KMS / HSM, and returns the signature.

### Metrics (Bee, normative minimum)

* `postage_signer_request_duration_seconds` (histogram, label: `endpoint`)
* `postage_signer_request_failures_total` (counter, labels: `endpoint`, `code`)
* `postage_signer_inflight_requests` (gauge, label: `endpoint`)
* `postage_signer_idempotency_conflicts_total` (counter, label: `endpoint`) — non-zero indicates a Bee bug or a malicious client and **MUST** alert.

### Audit log (signer side, normative)

The signer **MUST** record, for every accepted sign request, an append-only entry containing at minimum: `(timestamp, callerIdentity, batchID, index, chunkAddress, requestID, result)`. This is the only forensic record available to investigate "where did my batch capacity go" complaints from end users.

### Owner key rotation

The on-chain `owner` of a batch is fixed at `createBatch` time and **cannot be rotated**. Rotating the key inside the external signer therefore invalidates **all future stamps** for any pre-existing batch owned by the previous key; new batches must be created with the new owner. Operators **SHOULD**:

* Track `(batchID → owner address → key handle)` mappings.
* On suspected key compromise, mark all batches owned by the affected key as **at-risk** in the operator's UI.
* Issue users a **fresh per-user / per-batch address** for any new `createBatch` after the rotation event.
* Continue to honour `topUp` requests against at-risk batches if the user wishes (the user may still derive value from the existing batch's capacity).

## Testing

* **Unit tests:** mock signer returns deterministic signatures; `Stamp.Valid` passes for a batch whose `Owner` matches the recovered address; `(batchID, index)` idempotency is enforced.
* **Integration:** Bee uploads against a reference signer; pushsync recipient accepts chunks; `Swarm-Postage-Signer-Disable` round-trip works.
* **Failure injection:** signer timeout, 500, wrong signature length, `idempotency_conflict` → upload errors without corrupting reserve state (per the §"Semantics and ordering" choice).
* **Conformance test vectors:** a small, fixed set of `(privkey, batchID, chunkAddress, index, timestamp) → digest, signature` triples published alongside the SWIP, so independent signer implementations can self-verify.

## Roadmap

1. Draft implementation in Bee (`pkg/postage` `RemoteStampSigner` interface + config).
2. Reference signer (small Go service, with both TCP and Unix-socket transports) for CI and docs.
3. Load testing (latency, concurrent batches, sidecar vs remote).
4. Security review (token scope, replay, TLS).

## Impact

### Security implications

* **Trust in signer:** A compromised signer can produce arbitrary valid stamps for any owner key it holds — exactly the same exposure as a compromise of the key today. Slot-level idempotency limits a compromised *Bee* from griefing the owner's batch capacity, but does not protect against a compromised signer.
* **Trust in transport:** **mTLS is REQUIRED** for any deployment that places the signer across a network boundary from Bee — both Bee and the signer present X.509 client certificates, and each verifies the other against its configured CA. A leaked bearer token alone is insufficient because an attacker without the corresponding client cert cannot establish a session. Unix-domain-socket deployments inherit OS-level access control and **MUST** restrict socket permissions accordingly (typically owner-only `0600`, with Bee and the signer running under the same user or via SO_PEERCRED-checked authorisation).
* **Replay:** see §"Replay safety and idempotency".

### Economic implications

None on-chain; postage economics unchanged. Operational cost: extra latency and infra for the signer service.

## Related SWIPs

This SWIP is one of three coordinated patterns for postage stamp signing. They share the on-chain semantics and the on-the-wire stamp layout, and differ only in *where the owner key lives* and *who initiates each signing call*.

| Pattern | Where the hot key lives | Who calls whom for each signature | Trust placed in gateway |
| ------- | ----------------------- | --------------------------------- | ----------------------- |
| **This SWIP — Server-side delegated** (gateway custody) | Gateway operator's HSM / KMS / sidecar | Bee → signer (HTTP / Unix socket) | High: gateway can stamp on behalf of any batch it owns |
| **Client-side postage stamping**, mode (α) (`swip-XXXX-client-side-postage-stamping.md`) | End-user device (browser / CLI / mobile) | None — client pre-builds the stamp and uploads via the `presignedStamper` HTTP path | Low: gateway is a key-less HTTPS forwarder |
| **Client-side postage stamping**, mode (β) | End-user device | None — client pre-builds the stamp and pushsyncs directly over libp2p `wss://` to a Bee v2.7.0+ peer (AutoTLS via `libp2p.direct`) | Minimal: dialled peer is a libp2p transport hop, not an application intermediary; client receives signed storer receipts |
| **Streamed postage stamp signing** (`swip-XXXX-streamed-postage-stamp-signing.md`) | End-user device (browser tab, mobile wallet, HSM appliance) | Bee → user device (WebSocket / SSE), inverse of this SWIP's transport | None for stamping; gateway holds no key but does own the chunk pipeline; device must stay connected during the upload |

A gateway implementation **MAY** support more than one pattern simultaneously and route based on user choice or batch configuration. With Bee v2.7.0+, a single Bee node can serve all four roles concurrently (Server-side signer endpoint over HTTP/Unix, key-less HTTPS gateway for Client-side mode α, libp2p WSS peer for Client-side mode β, and Streamed-signing WebSocket endpoint).

## References

* [ethersphere/bee](https://github.com/ethersphere/bee) — `pkg/postage/stamp.go` (`ToSignDigest`, `Valid`, `ValidStamp`), [`pkg/postage/stamper.go`](https://github.com/ethersphere/bee/blob/master/pkg/postage/stamper.go) (`Stamper`, `NewPresignedStamper`), `pkg/api/api.go` (`getStamper`, `NewStamper`).
* [Bee v2.7.0 release](https://github.com/ethersphere/bee/releases/tag/v2.7.0) — `p2p-wss-enable`, AutoTLS, multi-underlay address support. Relevant to the Client-side sibling SWIP's mode (β) but not directly required by this SWIP.
* [ethersphere/SWIPs](https://github.com/ethersphere/SWIPs) — SWIP process and template.
* Postage batch ownership — `PostageStamp.sol` `createBatch` and `batches[batchId].owner`.
* `PostageStamp.topUp` — line 337, permissionless: any address may extend any batch.
* `PostageStamp.increaseDepth` — line 377, owner-only.
