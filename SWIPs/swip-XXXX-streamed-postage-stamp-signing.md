---
SWIP: XXXX
title: Streamed postage stamp signing (signer-as-client transport)
author: TBD (@github-handle)
discussions-to: TBD (open a GitHub Discussion on ethersphere/SWIPs and link it here)
status: Draft
category: Client
created: 2026-04-29
---

# Streamed postage stamp signing

> **Pattern 3 of three.** This SWIP defines a **self-custody, gateway-assisted** stamping pattern: the end-user device (typically a browser tab, a mobile wallet, or an HSM appliance) holds the postage batch's owner key but does **not** chunk, hash, allocate issuer state, or assemble manifests. Instead the device opens a **persistent streaming connection** to a remote Bee gateway; the gateway does all the heavy upload work and pushes "please sign this digest" frames down the stream as it goes. The device signs and replies; Bee assembles the stamp and pushsyncs the chunk.
>
> The two complementary patterns are:
>
> * **SWIP-XXXX (Server-side delegated postage stamp signing)** — gateway-managed (custodial). Same RemoteStampSigner interface, but Bee dials out to a server-resident signer rather than receiving signer connections in. See `swip-XXXX-remote-postage-stamp-signing.md`.
> * **SWIP-XXXX (Client-side postage stamping)** — full self-custody, client does everything (chunking, hashing, issuer state, signing, pushsync). With Bee v2.7.0's `wss://` libp2p transport this is the recommended self-custody pattern for desktop browsers and CLI clients. See `swip-XXXX-client-side-postage-stamping.md`.

## Abstract

Extends Bee's signer abstraction to support a **streaming, signer-as-client transport** in addition to the request/response server-as-callee transport defined by the Server-side sibling SWIP. A signer (typically a browser, mobile app, or desktop wallet companion) opens a long-lived authenticated session to a Bee gateway and accepts streamed sign requests for the duration of an upload. Bee performs chunking, BMT hashing, issuer state allocation, manifest assembly, and pushsync; the user's device contributes only the per-chunk signature.

The wire payload of a sign request, the digest formula, the stamp layout, and `Stamp.Valid` are all unchanged from the Server-side sibling SWIP. Only the **direction of connection establishment** and the **session lifecycle** are new.

## Motivation

### When this pattern is — and is not — the right answer

Bee's v2.7.0 release added native libp2p `wss://` listeners (with AutoTLS via `libp2p.direct`), which lets a browser become a real libp2p light peer. That capability is the foundation of the **Client-side** sibling SWIP (mode β), and it eliminates what was historically the strongest motivation for Streamed signing: "the browser holds the key but cannot pushsync to the network". A modern desktop browser running `libp2p-js` *can* pushsync, comfortably, today.

Pattern 4 therefore narrows in scope. It is the right pattern when the device holding the owner key:

* **Cannot afford to chunk locally.** Constrained mobile / embedded devices, or browser tabs that must remain responsive while uploading multi-GB files in the background, may prefer to do nothing but sign one digest at a time.
* **Cannot maintain a long-lived libp2p connection.** Tabs that need to background-suspend, devices behind hostile NAT/firewalls, or HSM appliances with strict outbound-only policies may not be able to host even a light libp2p peer.
* **Is decoupled from the upload pipeline.** A mobile wallet on the user's phone signing for an upload originated from their desktop is the canonical example: the wallet has the key, the desktop has the file, the gateway connects them.
* **Needs centralised manifest / transcoding work.** When the gateway is doing more than pushsync (e.g. transcoding video, building large mantaray trees, applying server-side encryption), letting the gateway own the chunk pipeline is the cleanest split.

In **all other browser self-custody scenarios** (modern desktop browser, single-session interactive upload of files up to a few GB, simple manifest), the **Client-side** sibling SWIP with mode (β) is the better choice: no application-layer dependency on the gateway at all, native storer receipts, and one fewer protocol to standardise.

### Concrete remaining use cases

* A **constrained mobile companion app** that holds the postage owner key on the user's phone, paired to a desktop app that drives the actual upload through a remote Bee gateway. The phone does signing; the desktop and gateway do everything else.
* An **HSM appliance** that cannot accept inbound TCP connections, cannot run libp2p, and only signs short digests. It dials out to a known Bee gateway and serves as a remote signer.
* **Background / batch publishing** from a browser tab where the user wants the upload to continue even if the tab is throttled — the upload pipeline lives in Bee and survives client backgrounding, only stalling when actively asked to sign.

## Specification

### Overview

1. **Unchanged:** `ToSignDigest`, the 113-byte stamp layout, `Stamp.Valid`, `RecoverBatchOwner`, `ValidStamp`, and the `RemoteStampSigner` interface defined in the Server-side sibling SWIP. A streamed signer is just another implementation of `RemoteStampSigner` from `pkg/postage`'s perspective.
2. **Inverted transport:** instead of Bee dialling the signer over `POST /v1/postage/sign`, the signer dials Bee over a **WebSocket** (default) or **Server-Sent Events** (alternate) endpoint. Bee then sends `signRequest` frames down the connection as needed; the signer responds with `signResponse` frames.
3. **Session-bound authorisation:** an open signer session declares which `batchID`s it can sign for, proves possession of the corresponding owner key(s), and Bee will only route sign requests for those batches to that session for as long as it remains open.
4. **Liveness coupled to upload:** if the signer disconnects mid-upload, Bee MUST stop allocating new slots and MUST NOT silently fall back to a server-side signer for batches the streamed session was responsible for.

### Architecture

```text
┌────────────────────────────────┐                  ┌─────────────────────────────┐
│ Signer (typically browser tab) │                  │ Bee gateway                 │
│                                │  (1) open WS     │                             │
│  - hot key (in JS memory or    │  ───────────────►│  GET /v1/postage/sign-stream│
│    deterministically derived)  │                  │  (Upgrade: websocket)       │
│                                │                  │                             │
│  - signs digests on demand     │  (2) HELLO       │                             │
│                                │     {batches,    │                             │
│                                │      proofs}     │                             │
│                                │  ───────────────►│                             │
│                                │                  │   verify proofs against     │
│                                │  (3) READY       │   on-chain batches[id].owner│
│                                │  ◄───────────────│                             │
│                                │                  │                             │
│                                │  (4a) signRequest│                             │
│                                │  ◄───────────────│  per chunk produced upstream│
│                                │                  │                             │
│                                │  (4b) signResp   │                             │
│                                │  ───────────────►│  Bee assembles stamp,       │
│                                │                  │  pushsyncs chunk            │
│                                │      …           │                             │
│                                │                  │                             │
│                                │  (5) BYE / close │                             │
│                                │  ────────────────│                             │
└────────────────────────────────┘                  └─────────────────────────────┘
                                                              │
                                                              │  user's separate
                                                              │  POST /bzz upload
                                                              │  references the
                                                              │  same batchID
                                                              ▼
                                                         (file upload
                                                          consuming
                                                          this signer)
```

### Endpoints

#### `GET {bee}/v1/postage/sign-stream` (WebSocket, normative)

* `Upgrade: websocket`, subprotocol `swarm-postage-sign-stream-v1`.
* Authentication: a TLS connection. mTLS is RECOMMENDED for non-loopback deployments. Bee MAY additionally require an `Authorization: Bearer <token>` header at the upgrade request.
* All frames are JSON text frames unless otherwise noted. Binary frames MUST be ignored.

#### `GET {bee}/v1/postage/sign-stream-sse` (Server-Sent Events, optional)

A fallback transport for environments where WebSockets are blocked. SSE is downstream-only; the signer posts `signResponse` frames via correlated `POST {bee}/v1/postage/sign-stream-sse/respond` requests carrying a session cookie issued at SSE handshake. Implementations MAY skip SSE; WebSocket is the normative transport.

### Frame protocol

All frames carry `type` and `id` fields. `id` is a UUID generated by the sender of the frame; responses echo it. Examples below omit framing whitespace.

#### `HELLO` (signer → Bee, first frame after open)

```json
{
  "type": "HELLO",
  "id":   "<uuid-1>",
  "version": 1,
  "batches": [
    {
      "batchID": "0x…64 hex…",
      "ownerProof": {
        "challenge": "0x…64 hex…",
        "signature": "0x…130 hex…"
      }
    }
  ],
  "capabilities": {
    "maxInFlight": 1024
  }
}
```

* `batches[].batchID` — a batch the signer offers to sign for.
* `batches[].ownerProof` — a freshness proof. The signer signs `ownerChallengeDigest = keccak256("swarm-postage-sign-stream-v1\x00" || beeNonce || batchID)` where `beeNonce` is a 32-byte server nonce delivered as a `Sec-Postage-Sign-Stream-Nonce` response header at the WebSocket upgrade. Bee MUST verify the signature recovers to `batches[batchID].owner` on chain.
* `capabilities.maxInFlight` — soft cap on concurrent outstanding `signRequest`s the signer expects to handle.

If `HELLO` is invalid, malformed, or any `ownerProof` fails verification, Bee MUST reply with `ERROR { code: "auth_failed" }` and close the connection with WebSocket close code `4401`.

#### `READY` (Bee → signer)

```json
{
  "type": "READY",
  "id":   "<uuid-of-HELLO>",
  "session": "<opaque-session-id>",
  "acceptedBatches": ["0x…", …],
  "rejectedBatches": [
    { "batchID": "0x…", "reason": "owner_mismatch" }
  ]
}
```

Bee MUST only route `signRequest`s for `acceptedBatches`. The session is then bound to those batches.

#### `signRequest` (Bee → signer)

```json
{
  "type":         "signRequest",
  "id":           "<uuid>",
  "batchID":      "0x…",
  "chunkAddress": "0x…",
  "index":        "0x…",
  "timestamp":    "0x…",
  "deadlineMs":   2000
}
```

Field semantics are identical to the Server-side sibling SWIP. `deadlineMs` is an advisory upper bound; if the signer cannot respond within that window it SHOULD send an `ERROR` referencing `id` rather than time out silently.

#### `signResponse` (signer → Bee)

```json
{
  "type":      "signResponse",
  "id":        "<uuid-of-signRequest>",
  "signature": "0x…130 hex…"
}
```

The signature MUST recover to `batches[batchID].owner` for the requested `batchID`. Bee MUST verify before assembling the stamp.

#### `ERROR` (either direction)

```json
{
  "type":    "ERROR",
  "id":      "<uuid-of-related-frame, or new uuid>",
  "code":    "<code>",
  "message": "<human>"
}
```

Codes (extending the Server-side sibling SWIP's set): `auth_failed`, `unknown_batch`, `idempotency_conflict`, `slot_exhausted`, `unauthorized`, `rate_limited`, `internal`, `signer_overloaded`, `owner_mismatch`.

#### `BYE` (either direction)

```json
{ "type": "BYE", "id": "<uuid>", "reason": "<optional>" }
```

Indicates voluntary close. The receiver SHOULD close the WebSocket cleanly after acknowledging.

### Replay safety and idempotency

Identical to the Server-side sibling SWIP: the signer MUST treat `(batchID, index)` as the idempotency key and MUST refuse a second request with the same key but different `chunkAddress` or `timestamp` with `idempotency_conflict`. Same rationale, same MUSTs.

### Session lifecycle and upload coupling

* **One session, multiple uploads.** A single open session can serve multiple concurrent uploads to its `acceptedBatches`. Bee MUST track per-session in-flight `signRequest`s and respect `capabilities.maxInFlight`.
* **Session loss aborts dependent uploads.** If the WebSocket closes (network drop, tab close, explicit `BYE`) while uploads referencing this session are in flight, Bee MUST:
  1. Cancel any outstanding `signRequest`s and roll back their peeked issuer state (per the peek / sign / commit refactor in the Server-side SWIP).
  2. Fail the corresponding upload requests with `502 Bad Gateway` and a structured error `{ "error": "signer_disconnected" }`.
  3. **NOT** silently fall back to any other configured signer for the affected batches. The upload was authorised by *this* session; another signer's signature would violate that authorisation.
* **Reconnection.** A signer MAY re-open a session and present the same `batches`. Bee MUST treat this as a fresh session (new `session` id, fresh challenge nonce). Whether a previously-failed upload can resume against the new session is a Bee-side concern (depends on issuer-state recovery) and is NOT specified here.
* **Heartbeat.** Bee SHOULD send WebSocket ping frames every 15s; the signer MUST respond with pong. A signer missing two consecutive pongs MUST be treated as disconnected.

### Concurrency and ordering

The peek / sign / commit semantics mandated by the Server-side SWIP apply unchanged: Bee peeks issuer state, releases the issuer mutex, sends `signRequest`, awaits `signResponse` (or `ERROR` / disconnect), commits or rolls back. A slow signer does not stall other batches' uploads but does cap throughput on its own batches.

### Multi-batch authorisation

A single `HELLO` MAY declare multiple `batchID`s with corresponding `ownerProof`s, possibly with **different owner keys** if the signer holds several. Bee MUST verify each proof independently and MUST accept partial success (`acceptedBatches` ∪ `rejectedBatches`).

### Configuration (Bee)

| Variable | Meaning |
| -------- | ------- |
| `postage-stream-signer-enabled` | Boolean; default `false`. Operators MUST opt in. |
| `postage-stream-signer-max-sessions` | Cap on concurrent open signer sessions. |
| `postage-stream-signer-max-batches-per-session` | Cap on `batches[]` length in `HELLO`. |
| `postage-stream-signer-idle-timeout` | Close sessions with no `signRequest` activity after this duration (default `15m`). |
| `postage-stream-signer-require-mtls` | Boolean; default `true` for non-loopback. |

### Optional headers on Bee's upload endpoints

* `Swarm-Postage-Sign-Stream-Session: <session-id>` on `POST /bzz` / `POST /chunks` — pin the upload to a specific signer session. Bee MUST refuse the upload if the session is not currently open and authorised for the upload's `batchID`. Without this header, Bee MAY pick any session that lists the relevant `batchID` in its `acceptedBatches`, with implementation-defined fairness; or fall back to a server-side signer if one is configured (which an integrator MAY refuse via the `Swarm-Postage-Signer-Disable: 1` header from the Server-side SWIP).

### Non-goals

* Defining browser dapp UX. The recommended deterministic-derivation flow from the Client-side sibling SWIP applies if the signer is a browser.
* Resumable uploads across signer reconnects. Out of scope; implementations MAY add this layered on top.
* Federated signing across multiple sessions for a single batch. Single-session-per-batch is normative for v1.

## Rationale

* **Reuses the Pattern-1 RemoteStampSigner interface** — `pkg/postage` only learns one new transport, not a new abstraction.
* **Reuses Pattern-1's idempotency, peek/commit and authentication primitives** — the streaming transport inherits the safety properties already specified for the request/response transport.
* **Inverts the connection direction** so signers behind NAT / in browsers can participate without exposing inbound endpoints.
* **Couples session liveness to upload acceptance** — closing the tab MUST stop the upload, not silently keep stamping under some other key. This is the property that makes the trust model meaningful to the user.
* **Keeps server-side fallback explicitly opt-in via header** — a gateway running both Pattern 1 and Pattern 4 doesn't accidentally promote a custodial signer in for a streamed signer that just disconnected.

## Backwards compatibility

* Fully additive. `postage-stream-signer-enabled` defaults to `false`; existing Bee deployments are unaffected until they opt in.
* The `RemoteStampSigner` interface in `pkg/postage` gains a new implementation backed by an open WebSocket session; existing implementations (HTTP, Unix socket) are unchanged.

## Security implications

* **Tab close = upload aborts.** This is by design and MUST NOT be weakened. A user closing the tab is the on-network equivalent of revoking signing authority; permitting Bee to silently switch signers would re-introduce custodial trust.
* **Session hijack.** The `session` id MUST NOT be transferable; binding to the WebSocket TLS session prevents replay. Implementations MUST NOT expose the session id in URLs, logs, or referrer headers.
* **Owner-proof challenge.** The `beeNonce` MUST be 32 bytes from a CSPRNG, MUST be unique per WebSocket upgrade, and MUST NOT be reused even within the same TLS session.
* **`signRequest` flooding.** Bee MUST respect `capabilities.maxInFlight`. A malicious gateway could try to exhaust the signer's CPU; a signer SHOULD enforce its own per-second cap and respond with `signer_overloaded` once exceeded.
* **Cross-batch leakage.** A `signRequest` MUST only be routed to a session whose `acceptedBatches` contains the request's `batchID`. Bee MUST drop and log any internal attempt to route otherwise.

## Operator surfaces

### Metrics (Bee)

* `postage_stream_sessions_open` (gauge)
* `postage_stream_session_duration_seconds` (histogram)
* `postage_stream_sign_request_duration_seconds` (histogram)
* `postage_stream_sign_request_failures_total` (counter, labels: `code`)
* `postage_stream_disconnect_aborts_total` (counter) — uploads aborted due to mid-flight signer disconnect.

### Alerting

`postage_stream_disconnect_aborts_total` increasing rapidly typically indicates a misconfigured client (network instability, premature tab close logic) and SHOULD surface to operators so they can advise users to switch to the Client-side or Server-side patterns where appropriate.

## Reference implementation

Two components co-published with this SWIP:

1. **Bee server-side**: a `pkg/postage`-internal `RemoteStampSigner` implementation backed by a WebSocket session manager. Wired into Bee's HTTP server at `/v1/postage/sign-stream`.
2. **Browser-side reference signer**: a TypeScript library exposing `openStampSession({ beeURL, hotKey, batchIDs })` → `{ session, close }`. Handles `HELLO`, owner proofs, signRequest dispatch, optional batched signing, and graceful close.

## Testing

* **Conformance:** test vectors for `HELLO`, owner proof, `signRequest` / `signResponse`, `idempotency_conflict` rejection, disconnect-during-flight rollback.
* **Property tests:** randomised concurrent uploads against a streamed signer, asserting no `(batchID, index)` collisions and no orphaned issuer state on disconnect.
* **Browser e2e:** Cypress / Playwright test driving an actual browser through `HELLO` + an upload, then a forced tab-close mid-upload, asserting the upload fails cleanly with `signer_disconnected` and no slot was burned.

## Open questions

* **Resume after disconnect.** Should Bee retain peeked-but-not-committed issuer state for a short grace window, allowing a quick signer reconnect to resume? Useful for flaky mobile networks; complicates state machine. Currently NOT specified.
* **Signer-initiated stamping.** Should the signer be allowed to push stamps for chunks Bee did not request (e.g. for client-side-chunked uploads streamed through a gateway)? This blurs the line with Pattern 3. Currently NOT specified.
* **Multi-signer per batch.** Two browser tabs presenting the same `batchID` simultaneously. Currently single-session-per-batch is normative; the second `HELLO` for an already-active batch SHOULD be rejected with `owner_mismatch` or a new `batch_in_use` code.

## Related SWIPs

| Pattern | Where the hot key lives | Client-to-network transport | Pattern selected when… |
| ------- | ----------------------- | --------------------------- | ---------------------- |
| **Server-side delegated** (`swip-XXXX-remote-postage-stamp-signing.md`) | Gateway operator's HSM / KMS / sidecar | n/a — gateway both stamps and pushsyncs | Custodial UX is acceptable; user needs zero involvement after `createBatch` |
| **Client-side postage stamping**, mode (α) (`swip-XXXX-client-side-postage-stamping.md`) | End-user device | HTTPS to key-less Bee gateway via `presignedStamper` | Self-custody required; client can chunk locally; legacy or HTTP-only Bee endpoints |
| **Client-side postage stamping**, mode (β) (`swip-XXXX-client-side-postage-stamping.md`) | End-user device | Direct libp2p `wss://` to a Bee v2.7.0+ peer | Self-custody required; client can chunk locally; modern desktop browser / CLI |
| **This SWIP — Streamed** | End-user device (typically browser tab or mobile wallet) | Application-layer WebSocket; gateway does chunking + pushsync; device only signs digests | Self-custody required; client **cannot** chunk locally (low-end mobile, background browser tab, HSM appliance), or gateway must own the upload pipeline |

The introduction of `wss://` libp2p in Bee v2.7.0 makes Client-side mode (β) the **default recommendation for desktop-browser self-custody**. This SWIP retains its niche for the constrained-device cases listed in the Motivation.

## References

* [ethersphere/bee](https://github.com/ethersphere/bee) — `pkg/postage/stamp.go`, `pkg/postage/stamper.go`.
* [Bee v2.7.0 release](https://github.com/ethersphere/bee/releases/tag/v2.7.0) and [v2.7.1 release](https://github.com/ethersphere/bee/releases/tag/v2.7.1) — `p2p-wss-enable` and AutoTLS via `libp2p.direct` (relevant background: this is what narrows the scope of Pattern 4 in favour of Client-side mode β for typical browser self-custody scenarios).
* [ethersphere/SWIPs](https://github.com/ethersphere/SWIPs) — SWIP process and template.
* [RFC 6455](https://datatracker.ietf.org/doc/html/rfc6455) — The WebSocket Protocol.
* [RFC 6979](https://datatracker.ietf.org/doc/html/rfc6979) — Deterministic ECDSA (relevant for browser signers).
* [Web Locks API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API) — single-tab signer enforcement in browsers.
