# Versioned Registry + Router Architecture for Upgradeable Proxy Systems

## Goal

We want to continue using an upgradeable proxy but **prevent Bee nodes
from automatically trusting new implementations**.\
Instead, Bee nodes should only continue interacting with the system if
the proxy's current implementation matches a **version → implementation
mapping** that they explicitly approve in their Bee release.

Security model:

-   Proxy **can still be upgraded on-chain**
-   Registry publishes which implementation belongs to which version
-   Bee nodes independently decide which versions they accept
-   Unapproved upgrades become effectively unusable by Bee nodes

------------------------------------------------------------------------

# High-Level Architecture

Use a **single contract** combining:

## 1. Registry

Stores mappings:

-   `version → implementation`
-   `implementation → version`

Also stores metadata such as:

-   release status
-   code hash
-   semver string

## 2. Router / Guard

Acts as the canonical entrypoint.

Before forwarding any call to the proxy it:

1.  Reads the proxy's current implementation
2.  Checks if the implementation is registered
3.  Optionally verifies codehash
4.  Forwards the call

------------------------------------------------------------------------

# Trust Layers

There are three independent layers:

### Proxy Upgrade Authority

Whoever can upgrade the proxy.

### Registry Authority

Who can register `(version, implementation)` pairs.

### Bee Node Acceptance

Bee software itself chooses which releases it trusts.

**Key rule:**

> Proxy upgrade does NOT equal network acceptance.

------------------------------------------------------------------------

# Core Concept

When a new implementation is deployed:

1.  New implementation contract deployed
2.  Registry records version mapping
3.  Proxy may upgrade to new implementation
4.  Bee nodes read current proxy implementation
5.  Bee nodes verify it matches approved mapping
6.  If not approved → Bee refuses to interact

------------------------------------------------------------------------

# Contract Storage Design

Suggested struct:

``` solidity
struct ReleaseInfo {
    address implementation;
    bool exists;
    bool deprecated;
    bytes32 codehash;
    string semver;
}
```

Mappings:

``` solidity
mapping(bytes32 => ReleaseInfo) public releaseByVersion;
mapping(address => bytes32) public versionByImplementation;
```

Other state:

``` solidity
address public immutable proxy;
```

Optional:

``` solidity
mapping(bytes4 => bool) public routedSelector;
```

------------------------------------------------------------------------

# Version ID Format

Use:

    bytes32 versionId

Example:

    keccak256("1.2.3")

Semver string can be stored only for readability.

Protocol logic should rely only on the `bytes32` ID.

------------------------------------------------------------------------

# Registry Invariants

### Invariant 1

Version registered only once.

### Invariant 2

Implementation belongs to only one version.

### Invariant 3

Zero address never allowed.

### Invariant 4

Mappings are immutable.

Never allow:

    version -> new implementation

### Invariant 5

Deprecated versions remain queryable.

Never delete history.

------------------------------------------------------------------------

# Proxy Implementation Reading

This assumes an **ERC‑1967 proxy**.

Implementation slot:

    0x360894A13BA1A3210667C828492DB98DCA3E2076CC3735A920A3CA505D382BBC

However Solidity cannot directly read another contract's storage.

Therefore one of the following approaches is required.

------------------------------------------------------------------------

# Implementation Detection Options

## Option A --- Proxy exposes getter

Recommended.

    function getImplementation() external view returns (address);

Router calls this function.

------------------------------------------------------------------------

## Option B --- Bee reads slot off‑chain

Bee performs:

    eth_getStorageAt(proxy, IMPLEMENTATION_SLOT)

This works without modifying proxy.

Router cannot enforce this on‑chain though.

------------------------------------------------------------------------

## Option C --- Custom proxy exposing implementation

Cleanest if router enforcement is required.

------------------------------------------------------------------------

# Recommended Practical Design

Two possible system variants.

------------------------------------------------------------------------

# Variant 1 --- Registry Only (Client Enforced)

Bee nodes verify implementations themselves.

Flow:

1.  Bee reads proxy implementation off‑chain
2.  Bee checks registry mapping
3.  Bee compares with local approved versions
4.  Bee proceeds only if match

Pros:

-   simpler
-   no proxy modification

Cons:

-   no on-chain enforcement

------------------------------------------------------------------------

# Variant 2 --- Registry + Router (On-chain Enforcement)

Bee nodes call router instead of proxy.

Flow:

1.  Router reads proxy implementation
2.  Router checks registry
3.  Router forwards call

Pros:

-   hard enforcement
-   fail‑closed safety

Cons:

-   proxy must expose implementation getter

------------------------------------------------------------------------

# Roles

Recommended access roles.

    REGISTRAR_ROLE
    DEPRECATOR_ROLE
    ROUTER_ADMIN_ROLE

These should ideally be **separate from proxy upgrade authority**.

------------------------------------------------------------------------

# Contract API

## Register Release

``` solidity
function registerRelease(
    bytes32 versionId,
    string calldata semver,
    address implementation,
    bytes32 codehash
) external;
```

Conditions:

-   version unused
-   implementation unused
-   implementation non‑zero

------------------------------------------------------------------------

## Deprecate Release

``` solidity
function deprecateRelease(bytes32 versionId) external;
```

------------------------------------------------------------------------

## Query Release

``` solidity
function getRelease(bytes32 versionId) external view returns (ReleaseInfo memory);
```

------------------------------------------------------------------------

## Lookup Version

``` solidity
function getVersionForImplementation(address implementation) external view returns (bytes32);
```

------------------------------------------------------------------------

## Check Approval

``` solidity
function isImplementationApprovedForVersion(bytes32 versionId, address implementation)
external view returns (bool);
```

------------------------------------------------------------------------

# Router Logic

Router validation steps:

1.  Read proxy implementation
2.  Ensure implementation registered
3.  Ensure release not deprecated
4.  Optional codehash verification
5.  Forward call

------------------------------------------------------------------------

# Bee Node Behaviour

Bee software must ship with a **local allowlist**.

Example:

    approvedReleases = {
      versionA : implA,
      versionB : implB
    }

Runtime verification:

1.  read proxy implementation
2.  read registry mapping
3.  verify match with local allowlist
4.  proceed

Registry alone **must not override Bee local validation**.

------------------------------------------------------------------------

# Release Process

## Step 1

Deploy implementation contract.

## Step 2

Compute metadata:

-   versionId
-   implementation address
-   codehash

## Step 3

Publish for review.

## Step 4

Bee release includes allowlist.

## Step 5

Register release on registry.

## Step 6

Upgrade proxy.

## Step 7

Bee runtime validation occurs.

------------------------------------------------------------------------

# Codehash Verification

Registry can store runtime codehash.

Router or Bee can verify:

    implementation.codehash == expectedHash

Benefits:

-   protects against incorrect deployments
-   improves release traceability

------------------------------------------------------------------------

# Forwarding Design

Prefer selector‑specific routing:

    commit()
    reveal()
    claim()

Each method:

1.  checks implementation
2.  forwards to proxy

Avoid generic unrestricted forwarding.

------------------------------------------------------------------------

# Failure Modes

### Unknown Implementation

Router reverts. Bee refuses to operate.

### Registry Compromise

Bee still relies on local allowlist.

### Proxy Getter Manipulation

Ensure getter reflects true delegate target.

### Version Reuse

Never allow.

### Rollback

Bee may accept previous approved versions.

------------------------------------------------------------------------

# Minimal Implementation Scope

## Contract

`VersionedRegistryRouter`

Responsibilities:

-   version registry
-   reverse lookup
-   optional router guard

## Bee

Must include:

-   approved `(versionId, implementation)` pairs

------------------------------------------------------------------------

# Events

    event ReleaseRegistered(
        bytes32 indexed versionId,
        string semver,
        address indexed implementation,
        bytes32 codehash
    );

    event ReleaseDeprecated(
        bytes32 indexed versionId,
        address indexed implementation
    );

Optional:

    event Forwarded(
        address indexed caller,
        bytes4 indexed selector,
        address indexed implementation
    );

------------------------------------------------------------------------

# Recommended Development Phases

## Phase 1

Registry only.

-   version ↔ implementation mapping
-   Bee verifies off‑chain

## Phase 2

Add router guard.

-   on‑chain enforcement
-   proxy getter required

------------------------------------------------------------------------

# Key Design Principle

> Version is coordination.\
> Implementation is enforcement.
