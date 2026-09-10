# Redistribution Contract

This overview matches `Redistribution.sol` on this PR branch (proposed, under review — not deployed). Bee-facing API: [SWIP-51-OPTION-B.md](./SWIP-51-OPTION-B.md). Attack catalog: [SWIP-51](https://github.com/ethersphere/swip-51/blob/main/swip-51.md).

## Overview

The `Redistribution` contract implements a Schelling coordination game for forming consensus around the Reserve Commitment (RC) hash. This is the core incentive mechanism that rewards nodes for storing data honestly.

## Purpose

The contract:
- Coordinates a three-phase game (Commit, Reveal, Claim)
- Form consensus on what chunks nodes are storing
- Randomly select winners who receive the PostageStamp pot
- Penalize nodes that reveal dishonest data
- Automatically adjust prices based on participation

## Key Concepts

### Schelling Coordination Game

The game works because:
1. Nodes that store data honestly will have similar reserve commitments
2. This shared value becomes a "focal point" (Schelling point)
3. Nodes are incentivized to reveal the true value to maximize chances of winning
4. Nodes that lie can be caught and penalized

### Three-Phase Design

Each round consists of three consecutive phases:

1. **Commit Phase** (25% = 38 blocks ≈ 3 minutes)
   - Nodes commit to hashed values
   - Cannot be decoded until reveal

2. **Reveal Phase** (25% = 38 blocks ≈ 3 minutes)
   - Nodes reveal their actual values
   - Randomness updates after each reveal
   - Only nodes in proximity to anchor can participate

3. **Claim Phase** (50% = 76 blocks ≈ 6 minutes)
   - Truth is determined from reveals (stake-density-weighted lottery)
   - Winner is randomly selected from truth-tellers (same weighting)
   - Anyone may submit `claim()` with proofs; pot goes to `winner.owner`
   - If proofs or withdraw fail, the whole transaction reverts (no pay, no claim)
   - Skipped claims: the next round’s first `commit` freezes non-revealers

### Proximity and Anchors

**Anchor**: A random seed that determines which nodes are "in proximity"  
**Proximity**: Two overlays are in proximity if their XOR is less than 2^(256-depth)

```solidity
function inProximity(bytes32 A, bytes32 B, uint8 minimum) pure returns (bool) {
    if (minimum == 0) return true;
    return uint256(A ^ B) < uint256(2 ** (256 - minimum));
}
```

Higher depth = smaller neighborhood = more specific group

### Round Structure

```solidity
uint256 private constant ROUND_LENGTH = 152 blocks; // ~12.7 minutes at 5s/block

// Phase checks
function currentPhaseCommit() {
    return block.number % ROUND_LENGTH < ROUND_LENGTH / 4;
}

function currentPhaseReveal() {
    uint256 n = block.number % ROUND_LENGTH;
    return n >= ROUND_LENGTH / 4 && n < ROUND_LENGTH / 2;
}

function currentPhaseClaim() {
    return block.number % ROUND_LENGTH >= ROUND_LENGTH / 2;
}
```

## Functions

### Commit Phase Functions

#### commit()
Commits to an obfuscated hash for the current round.

**Parameters**:
- `_obfuscatedHash`: Hash of (overlay, depth, hash, nonce)
- `_roundNumber`: Round number for this commit
- `_depth`: Declared storage depth (must match later reveal)

**Requirements**:
- Must be in commit phase
- Node must be staked for 2+ rounds
- `depth > height` (`DepthNotGreaterThanHeight`)
- Overlay in proximity of the commit-phase anchor with `depth - height` (`OutOfDepth`)
- Node must not have already committed
- Not in last block of commit phase (prevents front-running)

At most `MAX_COMMITS` (128) commits are kept. Extra eligible commits may evict a worse slot (`CommitSelected` / `CommitEvicted`) or be dropped without revert (`CommitRejected`). The first commit of a new round finalizes the previous round if it is still open (freezes non-revealers). If that closer was a non-revealer, they are `CommitRejected` after finalize and are not admitted.

**Logic**:
```solidity
bytes32 overlay = get from StakeRegistry
uint256 stake = get effective stake from StakeRegistry
uint8 height = get from StakeRegistry
// Check 2-round staking, depth > height, proximity
// Finalize prior round if needed; delete previous currentCommits
// Admit under MAX_COMMITS (stake-weighted priority)
```

**Commit Structure**:
```solidity
struct Commit {
    bytes32 overlay;
    address owner;
    bool revealed;
    uint8 height;
    uint8 declaredDepth;
    uint256 stake;
    uint256 priority; // lower is better
    bytes32 obfuscatedHash;
    uint256 revealIndex;
}
```

#### isParticipatingInUpcomingRound()
Checks if node is eligible for NEXT round's commit phase.

**Parameters**:
- `_owner`: Node address
- `_depth`: Intended storage depth

**Returns**: True if the node is staked long enough, `depth > height`, and overlay is in proximity of the current anchor with `depth - height`. Returns `false` (does not revert) when `depth <= height`.

**Use**: Called during reveal/claim phases to check next round eligibility

### Reveal Phase Functions

#### reveal()
Reveals the actual values used to create a commit.

**Parameters**:
- `_depth`: Reported storage depth
- `_hash`: Reserve commitment hash
- `_revealNonce`: Nonce used in commit

**Requirements**:
- Must be in reveal phase
- Revealed depth must equal `declaredDepth` from commit
- Anchor must be in range of `depth - height`
- Commit must exist and match

**Logic**:
```solidity
// Calculate obfuscated hash from inputs
bytes32 obfuscatedHash = wrapCommit(overlay, _depth, _hash, _revealNonce)
// Find matching commit
// Check proximity to anchor
// Store reveal
```

**First Reveal Special Handling**:
- Sets `currentRevealRoundAnchor` from seed
- Initializes reveal array
- Updates randomness

**Reveal Structure**:
```solidity
struct Reveal {
    bytes32 overlay;
    address owner;
    uint8 depth;
    uint256 stake;
    uint256 stakeDensity;  // stake * 2^(depth - height)
    bytes32 hash;
}
```

**Stake Density**: Weighted stake based on reported depth  
Higher depth → Higher density → Better chance of being selected as truth

### Claim Phase Functions

#### claim()
Finalizes the round and pays the pot if proofs verify.

**Parameters**:
- `entryProof1`: Chunk inclusion proof for random index 1
- `entryProof2`: Chunk inclusion proof for random index 2
- `entryProofLast`: Chunk inclusion proof for last index

**Requirements**:
- Must be in claim phase
- At least one reveal in the round (`NoReveals()` otherwise)
- Round not already claimed (`AlreadyClaimed()`)
- Must provide valid proofs for the selected winner's reserve

**Caller:** There is **no `msg.sender` check**. Any party may call `claim()` and pay gas. The pot is withdrawn to `winner.owner`, not the caller. A relayer or griefer can submit the transaction.

**Logic**:
1. Finalize participation if needed (non-reveal freezes + tentative winner)
2. Require reveals for this round; not already claimed
3. Verify proofs against the stored winner (proximity, inclusion, stamp, SOC, order, reserve size)
4. Apply disagreement freezes
5. `OracleContract.adjustPrice(lastRedundancyCount)`
6. `PostageStamp.withdraw(winner.owner)` — reverts the whole claim on failure
7. Set `currentClaimRound`, emit `WinnerSelected` / `ChunkCount`

**Atomicity:** Proofs, penalties, oracle, and withdraw run in one transaction. If proofs fail, withdraw reverts, or the tx runs out of gas, **nothing persists**. Freezes and `currentClaimRound` apply only after a fully successful `claim()`.

#### isWinner()
Determines if caller is the winner for the current round.

**Returns**: True if caller's overlay matches the selected winner

**Logic**: If the round is already finalized, compares overlay to the stored `winner`. Otherwise recomputes the same lottery `claim()` would.

### Admin Functions

#### setFreezingParams()
Sets the penalty multipliers.

**Parameters**:
- `_penaltyMultiplierDisagreement`: Freeze duration multiplier for disagreeing
- `_penaltyMultiplierNonRevealed`: Freeze duration multiplier for not revealing
- `_penaltyRandomFactor`: Random factor for disagreement penalty (0-100)

**Requirements**:
- Only `DEFAULT_ADMIN_ROLE` can call

#### setSampleMaxValue()
Changes the maximum value for reserve size estimation.

**Parameters**:
- `_sampleMaxValue`: New maximum value

**Requirements**:
- Only `DEFAULT_ADMIN_ROLE` can call

#### pause() / unPause()
Pauses or unpauses the contract.

### View Functions

#### currentRound()
Returns current round number: `block.number / ROUND_LENGTH`

#### currentPhaseCommit() / currentPhaseReveal() / currentPhaseClaim()
Returns true if in respective phase

#### isParticipatingInUpcomingRound(address, uint8)
Checks eligibility for next round

#### currentRoundAnchor()
Returns the anchor for the current phase (proximity calculation)

#### inProximity(bytes32, bytes32, uint8)
Checks if two overlays are within proximity

#### currentRevealRoundAnchor
The anchor set during first reveal

#### seed
Current random seed (updated after each reveal)

## Proof Verification

### Chunk Inclusion Proof

Verifies that a chunk is included in a Merkle tree (BMT - Binary Merkle Tree).

**Structure**:
```solidity
struct ChunkInclusionProof {
    bytes32[] proofSegments;      // Merkle proof segments
    bytes32 proveSegment;        // Chunk data
    bytes32[] proofSegments2;    // Proof for transformed address
    bytes32 proveSegment2;       // Transformed chunk
    uint64 chunkSpan;            // Size of chunk span
    bytes32[] proofSegments3;    // Proof for transformed chunk
    PostageProof postageProof;   // Postage stamp proof
    SOCProof[] socProof;          // Single-owner chunk proof
}
```

### Postage Proof

Verifies postage stamp validity for a chunk.

**Structure**:
```solidity
struct PostageProof {
    bytes signature;           // Batch owner signature
    bytes32 postageId;         // Batch ID
    uint64 index;              // Stamp index
    uint64 timeStamp;          // Timestamp
}
```

### SOC Proof

Verifies single-owner chunk ownership.

**Structure**:
```solidity
struct SOCProof {
    address signer;            // Ethereum address of signer
    bytes signature;           // Signature
    bytes32 identifier;       // Content identifier
    bytes32 chunkAddr;        // Chunk address
}
```

## Winner Selection Algorithm

### Truth Selection (from reveals)

Truth is an exact pair `(hash, depth)`. A reveal agrees with truth only if both fields match.

```solidity
function getCurrentTruth() {
    currentSum = 0
    for (each commit in currentCommits order) {
        if (commit.revealed) {
            currentSum += reveal.stakeDensity
            if (random(i) * currentSum < reveal.stakeDensity * (MAX_H + 1)) {
                truthHash = reveal.hash
                truthDepth = reveal.depth
            }
        }
    }
    return (truthHash, truthDepth)
}
```

Each revealed commit is a candidate. A **stake-density-weighted reservoir lottery** (not a median) walks commits in array order and updates the selected truth tuple when the random draw hits. Higher `stakeDensity` increases the chance a reveal becomes truth, but dishonest reveals can still win if they carry enough weight.

### Winner Selection (from truth-tellers)

```solidity
function winnerSelection() {
    (truthHash, truthDepth) = getCurrentTruth()
    currentSum = 0
    redundancyCount = 0
    for (each commit in currentCommits order) {
        if (commit.revealed && reveal matches truth exactly) {
            currentSum += reveal.stakeDensity
            if (random(redundancyCount) * currentSum < reveal.stakeDensity * (MAX_H + 1)) {
                winner = reveal
            }
            redundancyCount++
        }
        // also: freeze non-reveal committers; probabilistic freeze for wrong-truth revealers
    }
    adjustPrice(redundancyCount)
    return winner
}
```

The loop iterates **all commits** (O(N)), not only truth-tellers. Winner lottery and `redundancyCount` include only revealed commits whose `(hash, depth)` exactly matches truth. Non-reveal committers and wrong-truth revealers are penalized in the same loop.

A **single winner** is randomly selected from truth-tellers, weighted by stake density.

## Penalty System

### Non-Reveal Penalty

Nodes that commit but don't reveal are penalized:

```solidity
// has reveals: max(truthDepth, lastClaimedDepth)
// no reveals: lastClaimedDepth (floor MIN_NONREVEAL_FREEZE_DEPTH if unset)
// lastClaimedDepth is set only after a successful claim()
freezeDeposit(committer, penaltyMultiplierNonRevealed * ROUND_LENGTH * 2^freezeDepth)
```

### Disagreement Penalty

Nodes that reveal wrong truth are penalized (randomly):

```solidity
if (revealed but wrong truth && random(100) < penaltyRandomFactor) {
    freezeDeposit(revealer, penaltyMultiplierDisagreement * ROUND_LENGTH * 2^truthDepth)
}
```

### Depth-Based Scaling

Penalties scale exponentially with reported depth:
- Depth 20: 1x freeze duration
- Depth 21: 2x freeze duration
- Depth 22: 4x freeze duration
- etc.

## Price Adjustment Integration

After each claim phase, the contract calls:
```solidity
OracleContract.adjustPrice(uint16(redundancyCount))
```

The `redundancyCount` is the number of nodes that revealed the correct truth, which becomes the input for price adjustment.

## Events

```solidity
event Committed(uint256 roundNumber, bytes32 overlay, uint8 height, uint8 depth);
event Revealed(uint256 roundNumber, bytes32 overlay, uint256 stake, 
               uint256 stakeDensity, bytes32 reserveCommitment, uint8 depth);
event WinnerSelected(Reveal winner);
event TruthSelected(bytes32 hash, uint8 depth);
event ChunkCount(uint256 validChunkCount);
event CurrentRevealAnchor(uint256 roundNumber, bytes32 anchor);
event PriceAdjustmentSkipped(uint16 redundancyCount);
event ParticipationFinalized(uint64 roundNumber, uint256 revealCount);
event CommitSelected(uint256 roundNumber, bytes32 overlay, uint8 height, uint8 depth, uint256 priority);
event CommitEvicted(uint256 roundNumber, bytes32 overlay);
event CommitRejected(uint256 roundNumber, bytes32 overlay);
```

## Deployment Configuration

```typescript
constructor(
    address staking,
    address postageContract,
    address oracleContract
)
```

- `staking`: StakeRegistry address
- `postageContract`: PostageStamp address
- `oracleContract`: PriceOracle address

## Round Lifecycle Example

### Round N: Block 152000

**Commit Phase (152000-152037)**:
```
Block 152000: Node A commits hash_1
Block 152001: Node B commits hash_2
Block 152037: Commit phase ends
```

**Reveal Phase (152038-152075)**:
```
Block 152038: First node reveals
  → currentRevealRoundAnchor = currentSeed()
  → updateRandomness()
Block 152039: Node B reveals
  → updateRandomness()
Block 152075: Reveal phase ends
```

**Claim Phase (152076-152151)**:
```
Block 152076: Node A checks isWinner()
Block 152100: Winner claims pot
  → finalize participation if needed
  → verify proofs against stored winner
  → disagree freezes + adjustPrice
  → withdraw pot
```

### Round N+1: Block 152152

**Commit Phase (152152-152189)**:
- Uses anchor from seed at block 152152
- Different nodes participate (based on proximity)

## Proof Verification Details

### Inclusion Proof Verification

For each chunk in the claim:
1. Verify chunk is in proximity to anchor
2. Verify chunk address matches reserve commitment hash
3. Verify chunk is in transformed address tree
4. Verify chunks are ordered correctly (first < second < last)
5. Verify reserve size estimation

### Stamp Verification

1. Check batch exists and is alive
2. Verify stamp index is valid for batch depth
3. Verify stamp bucket matches chunk bucket
4. Verify batch owner signature on chunk

### SOC Verification

1. Verify signature matches signer
2. Verify SOC address calculation matches chunk address
3. Handle transformed addresses for SOCs

## Error Codes

```solidity
error NotCommitPhase();               // Wrong phase
error NoCommitsReceived();            // No commits in round
error DepthNotGreaterThanHeight();    // depth must exceed height
error OutOfDepth();                    // commit-time proximity failed
error DepthMismatch();                 // reveal depth ≠ declaredDepth
error AlreadyCommitted();              // Already committed this round
error MustStake2Rounds();             // Need to stake 2 rounds first
error NotStaked();                    // Not staked
error NotRevealPhase();                // Wrong phase
error OutOfDepthReveal(bytes32);      // Anchor out of depth
error AlreadyRevealed();               // Already revealed
error NotClaimPhase();                 // Wrong phase
error AlreadyClaimed();                // Round already claimed
error SocVerificationFailed(bytes32); // SOC verification failed
error IndexOutsideSet(bytes32);       // Stamp index invalid
error SigRecoveryFailed(bytes32);      // Signature recovery failed
error BatchDoesNotExist(bytes32);      // Batch not found
error BucketDiffers(bytes32);         // Bucket mismatch
error InclusionProofFailed(uint8, bytes32); // Inclusion proof failed
error RandomElementCheckFailed();      // Chunk order wrong
error LastElementCheckFailed();        // Last element order wrong
error ReserveCheckFailed(bytes32);    // Reserve size too large
```

## Examples

### Committing

```solidity
bytes32 overlay = StakeRegistry(stakes).overlayOfAddress(myAddress);
bytes32 hash = calculateReserveCommitment(); // From stored chunks
bytes32 nonce = randomNonce();

bytes32 obfuscatedHash = Redistribution(redis).wrapCommit(
    overlay,
    depth,
    hash,
    nonce
);

Redistribution(redis).commit(obfuscatedHash, currentRound(), depth);
```

### Revealing

```solidity
Redistribution(redis).reveal(
    reportedDepth,
    reserveCommitment,
    revealNonce
);
```

### Checking if Winner

```solidity
bool winner = Redistribution(redis).isWinner(overlay);
if (winner) {
    // Generate proofs; winner.owner (or any relayer) calls claim()
    claim(proof1, proof2, proofLast);
}
```

`isWinner()` mirrors winner selection without applying penalties. `claim()` may be submitted by any address as long as proofs are valid for the selected winner.

### Checking Eligibility

```solidity
bool eligible = Redistribution(redis).isParticipatingInUpcomingRound(
    myAddress,
    intendedDepth
);
```

## Security Considerations

1. **Random Nonce**: Must be truly random and never reused
2. **Proximity Calculations**: Proper depth responsibility (`depth - height`); `depth > height` is required or proximity is vacuous
3. **Freeze Protection**: Prevents stake manipulation during freeze
4. **Proof Verification**: Comprehensive validation prevents fake claims
5. **Random Selection**: Weighted fairly by stake density
6. **Truth Selection**: Stake-weighted lottery over exact `(hash, depth)` tuples, not majority vote or correctness check
7. **Sybil / claim gas griefing**: `MAX_COMMITS = 128` bounds loops; catalog in [SWIP-51](https://github.com/ethersphere/swip-51/blob/main/swip-51.md)
8. **Zero-reveal rounds**: `claim()` reverts `NoReveals()`; the next round’s first `commit` freezes non-revealers at `lastClaimedDepth` (floor `MIN_NONREVEAL_FREEZE_DEPTH` if unset). A no-show closer is `CommitRejected` after finalize so they cannot take the next round’s slot.
9. **Open caller on `claim()`**: Anyone can submit; economic incentive is on `winner.owner` to provide proofs

## Related Documentation

- [SWIP-51](https://github.com/ethersphere/swip-51/blob/main/swip-51.md): attack catalog and mitigations
- [SWIP-51-OPTION-B.md](./SWIP-51-OPTION-B.md): Bee / client migration for this implementation

## Related Contracts

- **StakeRegistry**: Provides stake and overlay info
- **PostageStamp**: Source of pot, valid chunk count
- **PriceOracle**: Receives redundancy data for price adjustment

