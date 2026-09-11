// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.19;
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "./Util/TransformedChunkProof.sol";
import "./Util/ChunkProof.sol";
import "./Util/Signatures.sol";
import "./Util/StsTypes.sol";
import "./Util/StsWitness.sol";
import "./interface/IPostageStamp.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IPriceOracle {
    function adjustPrice(uint16 redundancy) external returns (bool);
}

interface IStakeRegistry {
    struct Stake {
        bytes32 overlay;
        uint256 stakeAmount;
        uint256 lastUpdatedBlockNumber;
    }

    function freezeDeposit(address _owner, uint256 _time) external;

    function lastUpdatedBlockNumberOfAddress(address _owner) external view returns (uint256);

    function overlayOfAddress(address _owner) external view returns (bytes32);

    function heightOfAddress(address _owner) external view returns (uint8);

    function nodeEffectiveStake(address _owner) external view returns (uint256);
}

/**
 * @title Redistribution contract
 * @author The Swarm Authors
 * @dev Implements the Sequential Transformation Scheme 1 (SWIP-050) Schelling game. A round is
 * 152 blocks and runs in six phases:
 *
 *   blocks   0..37    chunk sample hash commit
 *   blocks  38..56    chunk sample hash reveal
 *   blocks  57..94    stamp sample hash commit
 *   blocks  95..113   stamp sample hash reveal
 *   blocks 114..132   proof submission
 *   blocks 133..151   claim
 *
 * Three randomness roles are introduced in strict order, each only after the commitment that
 * must not know it. The round anchor already exists when the round opens: it selects the
 * neighbourhood and transforms chunk addresses. The first valid chunk sample hash reveal creates
 * the stamp anchor, which orders transformed stamp values for this round. The first valid stamp
 * sample hash reveal creates the proof seed, which selects the sample positions that must be
 * opened, and the selection seed used by the weighted truth draw.
 *
 * A participant commits to (chunkSampleHash, chunkTransformRoot, depth) in stage one, then to a
 * stamp sample hash in stage two, then opens three of its sixteen stamp sample positions. Each
 * opened witness proves that the transformed stamp value sits at that position and is ordered
 * against its neighbours; that the batch and index were inside this round's SWIP-049 scope and
 * the batch owner signed for the stamped chunk address; and that the first anchor transformed
 * address of that same chunk was already a leaf of the chunk transform root fixed in stage one.
 * Since the stamp anchor and proof seed are unknown when that root is fixed, a participant
 * cannot wait to learn which chunks will be useful.
 *
 * Only a proof validated entry carries selection weight, which is its stake density multiplied
 * by two cube root coefficients rewarding a denser stamp sample and lower within-bucket index
 * use. The weighted draw picks one entry; its (chunkSampleHash, stampSampleHash, depth) becomes
 * the Schelling point, and the round pot is divided among every proof validated entry that
 * reported it, in proportion to the same weight. Entries that reported something else are
 * frozen; stage one commits that never became proof validated are frozen like non-revealers.
 */

contract Redistribution is AccessControl, Pausable {
    // ----------------------------- Type declarations ------------------------------

    // An eligible user may commit to an _obfuscatedHash_ during the commit phase...
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
        // SWIP-050 stage two: the obfuscated stamp sample hash commitment, accepted only after
        // this overlay has a valid stage one reveal in the same round.
        bytes32 stampObfuscatedHash;
    }
    // ...then provide the actual values that are the constituents of the pre-image of the _obfuscatedHash_
    // during the reveal phase.
    struct Reveal {
        bytes32 overlay;
        address owner;
        uint8 depth;
        uint256 stake;
        uint256 stakeDensity;
        // The chunk side Schelling value. STS-1 does not open chunk sample witnesses.
        bytes32 hash;
        // Participant specific root over the claimed complete list of first anchor transformed
        // chunk addresses. Fixed in stage one, while the stamp anchor and proof seed are still
        // unknown, which is what stops a node picking chunks to suit the stamps it will be asked
        // to prove. Not part of the Schelling point, so every paid node must prove its own.
        bytes32 chunkTransformRoot;
        // The stamp side Schelling value, set at stage two reveal.
        bytes32 stampHash;
        // Base stake density multiplied by the two STS-1 coefficients. Zero until the witnesses
        // and bindings have passed, and only a non zero value carries selection weight.
        uint256 effectiveStakeDensity;
        bool stampRevealed;
        bool proofSubmitted;
    }

    /**
     * @dev The value selected as truth for a round.
     */
    struct SelectedSchellingPoint {
        bytes32 hash;
        bytes32 stampHash;
        uint8 depth;
        bool selected;
    }

    // The address of the linked PostageStamp contract.
    IPostageStamp public PostageContract;
    // The address of the linked PriceOracle contract.
    IPriceOracle public OracleContract;
    // The address of the linked Staking contract.
    IStakeRegistry public Stakes;

    // Commits for the current round.
    Commit[] public currentCommits;
    // Reveals for the current round.
    Reveal[] public currentReveals;

    // The current anchor that being processed for the reveal and claim phases of the round.
    bytes32 private currentRevealRoundAnchor;

    // The current random value from which we will random.
    // inputs for selection of the truth teller and beneficiary.
    bytes32 private seed;

    // The number of the currently active round phases.
    uint64 public currentCommitRound;
    uint64 public currentRevealRound;
    uint64 public currentClaimRound;

    // Settings for slashing and freezing
    uint8 private penaltyMultiplierDisagreement = 1;
    uint8 private penaltyMultiplierNonRevealed = 2;
    uint8 private penaltyRandomFactor = 100; // Use 100 as value to ignore random factor in freezing penalty

    // The length of a round in blocks.
    uint256 private constant ROUND_LENGTH = 152;

    // ----------------------------- SWIP-050 round schedule ------------------------------

    // Six phases, inclusive start offsets within the round. Each randomness role is introduced
    // only after the commitment that must not know it: the round anchor is already fixed when
    // the round opens, the stamp anchor is created by the first chunk sample hash reveal, and
    // the proof and selection seeds by the first stamp sample hash reveal.
    uint256 private constant CHUNK_REVEAL_START = 38; // 38 blocks of chunk sample hash commit
    uint256 private constant STAMP_COMMIT_START = 57; // 19 blocks of chunk sample hash reveal
    uint256 private constant STAMP_REVEAL_START = 95; // 38 blocks of stamp sample hash commit
    uint256 private constant PROOF_START = 114; // 19 blocks of stamp sample hash reveal
    uint256 private constant CLAIM_START = 133; // 19 blocks of proof submission, then 19 of claim

    // Maximum value of the keccack256 hash.
    bytes32 private constant MAX_H = 0x00000000000000000000000000000000ffffffffffffffffffffffffffffffff;

    // ----------------------------- SWIP-51 Option B ------------------------------

    // Maximum number of commits admitted per round. Bounds every loop over commits/reveals.
    uint8 public constant MAX_COMMITS = 128;

    // Floor so a zero-reveal finalize before any winner exists cannot freeze at 2^0.
    uint8 public constant MIN_NONREVEAL_FREEZE_DEPTH = 8;

    // Tracks rounds whose participation (non-reveal freezes + tentative winner) has been finalized.
    mapping(uint64 => bool) public participationFinalized;
    // Redundancy count (matching reveals) of the finalized round, consumed by the oracle in claim.
    uint16 public lastRedundancyCount;
    // ----------------------------- SWIP-050 STS-1 ------------------------------

    // Fixed stamp sample size, and the positions opened during proof submission: two drawn from
    // 0..14 without replacement, plus position 15 which is always opened as the density witness.
    uint32 public constant STAMP_SAMPLE_SIZE = 16;
    uint32 public constant STS_WITNESS_COUNT = 3;
    uint32 public constant STAMP_DENSITY_WITNESS = 15;

    // The ERC20 the pot is denominated in. STS-1 pays several nodes per round, so the pot is
    // withdrawn into this contract and drawn down by each beneficiary.
    IERC20 public immutable bzzToken;

    // Anchor that orders transformed stamp values for the active reveal round. Created by the
    // first valid chunk sample hash reveal, so it is unknown while stage one is committed.
    bytes32 public currentRevealRoundStampAnchor;
    bool public currentRevealRoundStampAnchorSet;

    // Randomness created by the first valid stamp sample hash reveal, after the stamp sample is
    // already committed. currentProofSeed selects which sample positions must be opened;
    // currentSelectionSeed drives the weighted truth draw.
    uint64 public currentStampSampleHashRevealRound;
    bytes32 private currentProofSeed;
    bytes32 private currentSelectionSeed;
    bool public currentProofSeedSet;

    // The Schelling point selected as truth for the finalized round.
    SelectedSchellingPoint public selectedTruth;

    // Earned but not yet withdrawn redistribution payouts.
    mapping(address => uint256) public pendingRedistributionPayouts;

    // Ceiling the density witness must fall under. Depth independent on purpose: a depth scaled
    // ceiling would grow in step with the largest proven value and leave depth overreporting a
    // free gain on base stake density. See docs/SWIP-49-50-SCRUTINY.md 2.1.
    uint256 public stampSampleMaxValue = 1284401000000000000000000000000000000000000000000000000000000000000000000;

    // Depth of the last successfully claimed winner. Used so an unproven / skipped-claim
    // truth cannot shrink non-reveal freeze duration below a proven network depth.
    uint8 public lastClaimedDepth;

    // ----------------------------- Events ------------------------------

    // Next two events to be removed after testing phase pending some other usefulness being found.
    /**
     * @dev Emits the number of commits being processed by the claim phase.
     */
    event CountCommits(uint256 _count);

    /**
     * @dev Emits the number of reveals being processed by the claim phase.
     */
    event CountReveals(uint256 _count);

    /**
     * @dev Logs that an overlay has committed
     */
    event Committed(uint256 roundNumber, bytes32 overlay, uint8 height, uint8 depth);
    /**
     * @dev Emit from Postagestamp contract valid chunk count at the end of claim
     */
    event ChunkCount(uint256 validChunkCount);

    /**
     * @dev Emitted when a round's participation is finalized (non-reveal freezes + tentative winner).
     */
    event ParticipationFinalized(uint64 roundNumber, uint256 revealCount);

    /**
     * @dev Emitted when a commit is admitted into the bounded commit set.
     */
    event CommitSelected(uint256 roundNumber, bytes32 overlay, uint8 height, uint8 depth, uint256 priority);

    /**
     * @dev Emitted when an admitted commit is evicted by a strictly better newcomer.
     */
    event CommitEvicted(uint256 roundNumber, bytes32 overlay);

    /**
     * @dev Emitted when a newcomer is rejected because the commit set is full and it is not better.
     */
    event CommitRejected(uint256 roundNumber, bytes32 overlay);

    /**
     * @dev Bytes32 anhor of current reveal round
     */
    event CurrentRevealAnchor(uint256 roundNumber, bytes32 anchor);

    /**
     * @dev Output external call status
     */
    event PriceAdjustmentSkipped(uint16 redundancyCount);

    /**
     * @dev Logs that an overlay has revealed
     */
    event Revealed(
        uint256 roundNumber,
        bytes32 overlay,
        uint256 stake,
        uint256 stakeDensity,
        bytes32 reserveCommitment,
        uint8 depth
    );

    /**
     * @dev Emitted when the stamp anchor for a round is opened by the first stage one reveal.
     */
    event StampAnchorOpened(uint64 roundNumber, bytes32 stampAnchor);

    /**
     * @dev Emitted when an overlay reveals its stamp sample hash.
     */
    event StampSampleRevealed(uint64 roundNumber, bytes32 overlay, bytes32 stampHash);

    /**
     * @dev Emitted when an overlay's STS-1 witnesses and bindings have passed.
     */
    event StsProofAccepted(uint64 roundNumber, bytes32 overlay, uint256 effectiveStakeDensity);

    /**
     * @dev Emitted once per claim with the Schelling point selected as truth.
     */
    event StsTruthSelected(uint64 roundNumber, bytes32 hash, bytes32 stampHash, uint8 depth);

    /**
     * @dev Emitted for each beneficiary of a claim.
     */
    event PayoutAccrued(uint64 roundNumber, bytes32 overlay, address owner, uint256 amount);

    /**
     * @dev Emitted when a beneficiary draws down an accrued payout.
     */
    event PayoutWithdrawn(address owner, address receiver, uint256 amount);

    // ----------------------------- Errors ------------------------------

    error NotCommitPhase(); // Game is not in commit phase
    error DepthNotGreaterThanHeight(); // Reported depth must be strictly greater than the node's height
    error OutOfDepth(); // Overlay is out of reported depth of the commit anchor
    error DepthMismatch(); // Revealed depth does not match the committed declared depth
    error NoCommitsReceived(); // Round didn't receive any commits
    error PhaseLastBlock(); // We don't permit commits in last block of the phase
    error CommitRoundOver(); // Commit phase in this round is over
    error CommitRoundNotStarted(); // Commit phase in this round has not started yet
    error MustStake2Rounds(); // Before entering the game node must stake 2 rounds prior
    error NotStaked(); // Node didn't add any staking
    error WrongPhase(); // Checking in wrong phase, need to check duing claim phase of current round for next round or commit in current round
    error AlreadyCommitted(); // Node already committed in this round
    error NotRevealPhase(); // Game is not in reveal phase
    error OutOfDepthReveal(bytes32); // Anchor is out of reported depth in Reveal phase, anchor data available as argument
    error OutOfDepthClaim(uint32); // Stamped chunk is out of the reported depth of the round anchor
    error AlreadyRevealed(); // Node already revealed
    error NoMatchingCommit(); // No matching commit and hash
    error NotClaimPhase(); // Game is not in the claim phase
    error NoReveals(); // Round did not receive any reveals
    error FirstRevealDone(); // We don't want to return value after first reveal
    error AlreadyClaimed(); // This round was already claimed
    error NotAdmin(); // Caller of trx is not admin
    error OnlyPauser(); // Only account with pauser role can call pause/unpause
    error SocVerificationFailed(bytes32); // Soc verification failed for this element
    error SocCalcNotMatching(bytes32); // Soc address calculation does not match with the witness
    error IndexOutsideSet(bytes32); // Stamp available: index resides outside of the valid index set
    error SigRecoveryFailed(bytes32); // Stamp authorized: signature recovery failed for element
    error BatchDoesNotExist(bytes32); // Deprecated by SWIP-049: absent/expired batches now revert BatchNotUsableForRedistribution from PostageStamp
    error BucketDiffers(bytes32); // Stamp aligned: postage bucket differs from address bucket
    error InclusionProofFailed(uint8, bytes32);
    // 2 = First sister segment in the opened data must match between the two proofs
    // 3 = Inclusion proof failed for the original address of the stamped chunk
    error TransferFailed(); // Payout token transfer failed
    error BatchNotUsableForTargetRound(bytes32); // Stamp usable: batch balance below the round's fixed threshold
    error InvalidTargetRound(); // Round zero has no preceding sampling phase
    error NotStampCommitPhase(); // Game is not in the stamp sample hash commit phase
    error NotStampRevealPhase(); // Game is not in the stamp sample hash reveal phase
    error NotProofPhase(); // Game is not in the proof submission phase
    error NoChunkSampleHashReveal(); // Caller has no valid stage one reveal in this round
    error NoStampSampleHashReveal(); // Caller has no valid stamp sample hash reveal in this round
    error MissingAnchor(); // The stamp anchor or proof seed for this round has not been opened
    error ProofAlreadySubmitted(); // STS proof already submitted for this round
    error StampWitnessPositionMismatch(); // Opened position is not the one the proof seed selected
    error StampInclusionProofFailed(uint32); // Stamp sample inclusion proof failed at this position
    error StampLocalOrderCheckFailed(uint32); // Opened value is not ordered against its neighbour
    error StampReserveCheckFailed(bytes32); // Density witness is not below the stamp sample ceiling
    error ChunkTransformMembershipFailed(); // Transformed chunk address is not in chunkTransformRoot
    error ChunkAddressMismatch(); // Opened chunk data does not hash to the stamped chunk address
    error NoClaimableTruth(); // No proof validated entry, so no Schelling point was selected
    error NoPayout(); // Nothing accrued for this caller

    // ----------------------------- CONSTRUCTOR ------------------------------

    /**
     * @param staking the address of the linked Staking contract.
     * @param postageContract the address of the linked PostageStamp contract.
     * @param oracleContract the address of the linked PriceOracle contract.
     */
    constructor(address staking, address postageContract, address oracleContract, address token) {
        Stakes = IStakeRegistry(staking);
        PostageContract = IPostageStamp(postageContract);
        OracleContract = IPriceOracle(oracleContract);
        // STS-1 splits the pot across every proof validated entry on the selected Schelling
        // point, so this contract withdraws the pot and holds it until each beneficiary draws
        // its share. See docs/SWIP-49-50-SCRUTINY.md 2.5.
        bzzToken = IERC20(token);
        _setupRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    ////////////////////////////////////////
    //           STATE CHANGING           //
    ////////////////////////////////////////

    /**
     * @notice Begin application for a round if eligible. Commit a hashed value for which the pre-image will be
     * subsequently revealed.
     * @dev If a node's overlay is _inProximity_(_depth_) of the _currentRoundAnchor_, that node may compute an
     * _obfuscatedHash_ by providing their _overlay_, reported storage _depth_, reserve commitment _hash_ and a
     * randomly generated, and secret _revealNonce_ to the _wrapCommit_ method.
     * @param _obfuscatedHash The calculated hash resultant of the required pre-image values.
     * and be derived from the same key pair as the message sender.
     * @param _roundNumber Node needs to provide round number for which commit is valid
     */
    function commit(bytes32 _obfuscatedHash, uint64 _roundNumber, uint8 _depth) external whenNotPaused {
        uint64 cr = currentRound();
        bytes32 _overlay = Stakes.overlayOfAddress(msg.sender);
        uint256 _stake = Stakes.nodeEffectiveStake(msg.sender);
        uint256 _lastUpdate = Stakes.lastUpdatedBlockNumberOfAddress(msg.sender);
        uint8 _height = Stakes.heightOfAddress(msg.sender);

        // 1. Run reverting checks before finalizing a prior round.
        if (_lastUpdate == 0) {
            revert NotStaked();
        }

        if (_lastUpdate >= block.number - 2 * ROUND_LENGTH) {
            revert MustStake2Rounds();
        }

        if (cr > _roundNumber) {
            revert CommitRoundOver();
        }

        if (cr < _roundNumber) {
            revert CommitRoundNotStarted();
        }

        if (!currentPhaseCommit()) {
            revert NotCommitPhase();
        }

        if (block.number % ROUND_LENGTH == (ROUND_LENGTH / 4) - 1) {
            revert PhaseLastBlock();
        }

        // 2. Eligibility: depth must exceed height and the overlay must be in proximity of the anchor.
        if (_depth <= _height) {
            revert DepthNotGreaterThanHeight();
        }

        if (!inProximity(_overlay, currentRoundAnchor(), _depth - _height)) {
            revert OutOfDepth();
        }

        // 3. Finalize prior rounds before we mutate the commit set for the new round.
        _ensurePriorRoundsFinalized(cr);

        // 4. If we are in a new commit phase, clear the previous round's commits
        // and set the currentCommitRound to be the current one.
        if (cr != currentCommitRound) {
            delete currentCommits;
            currentCommitRound = cr;
        }

        // 5. A no-show closer is frozen by step 3. Do not revert (finalize must stick);
        // reject admission so they cannot take a slot in this round with pre-freeze stake.
        _lastUpdate = Stakes.lastUpdatedBlockNumberOfAddress(msg.sender);
        _stake = Stakes.nodeEffectiveStake(msg.sender);
        if (_lastUpdate >= block.number - 2 * ROUND_LENGTH || _stake == 0) {
            emit CommitRejected(_roundNumber, _overlay);
            return;
        }

        // 6. Reject duplicate overlay for this round.
        uint256 commitsArrayLength = currentCommits.length;
        for (uint256 i = 0; i < commitsArrayLength; ) {
            if (currentCommits[i].overlay == _overlay) {
                revert AlreadyCommitted();
            }
            unchecked {
                ++i;
            }
        }

        // 7. Admit under MAX_COMMITS using stake-weighted priority (lower is better).
        Commit memory newCommit = Commit({
            overlay: _overlay,
            owner: msg.sender,
            revealed: false,
            height: _height,
            declaredDepth: _depth,
            stake: _stake,
            priority: admissionPriority(cr, currentSeed(), _overlay, _stake),
            obfuscatedHash: _obfuscatedHash,
            revealIndex: 0,
            stampObfuscatedHash: bytes32(0)
        });

        if (_admitCommit(newCommit, _roundNumber)) {
            emit Committed(_roundNumber, _overlay, _height, _depth);
        }
    }

    /**
     * @notice Admit a commit into the bounded set, evicting the worst commit when full.
     * @return admitted True if the commit was admitted (pushed or replaced), false if rejected.
     * @dev Never reverts on rejection so that any finalize performed earlier in the tx persists.
     */
    function _admitCommit(Commit memory newCommit, uint64 roundNumber) internal returns (bool admitted) {
        uint256 commitsArrayLength = currentCommits.length;

        // Early exit if the commit set is not full.
        if (commitsArrayLength < MAX_COMMITS) {
            currentCommits.push(newCommit);
            emit CommitSelected(
                roundNumber,
                newCommit.overlay,
                newCommit.height,
                newCommit.declaredDepth,
                newCommit.priority
            );
            return true;
        }

        // Find the worst admitted commit: highest priority, tie-break by higher overlay uint.
        uint256 worstIndex = 0;
        uint256 worstPriority = currentCommits[0].priority;
        bytes32 worstOverlay = currentCommits[0].overlay;
        for (uint256 i = 1; i < commitsArrayLength; ) {
            uint256 p = currentCommits[i].priority;
            bytes32 o = currentCommits[i].overlay;
            if (p > worstPriority || (p == worstPriority && uint256(o) > uint256(worstOverlay))) {
                worstIndex = i;
                worstPriority = p;
                worstOverlay = o;
            }
            unchecked {
                ++i;
            }
        }

        // Newcomer must be strictly better than the worst admitted commit.
        bool betterThanWorst = newCommit.priority < worstPriority ||
            (newCommit.priority == worstPriority && uint256(newCommit.overlay) < uint256(worstOverlay));

        if (!betterThanWorst) {
            emit CommitRejected(roundNumber, newCommit.overlay);
            return false;
        }

        emit CommitEvicted(roundNumber, worstOverlay);
        currentCommits[worstIndex] = newCommit;
        emit CommitSelected(
            roundNumber,
            newCommit.overlay,
            newCommit.height,
            newCommit.declaredDepth,
            newCommit.priority
        );
        return true;
    }

    /**
     * @notice Ensures the previous participation rounds are finalized before a new commit round begins.
     * @dev Finalizes the last round that received commits, and marks empty skipped rounds as finalized.
     */
    function _ensurePriorRoundsFinalized(uint64 cr) internal {
        if (currentCommitRound != 0 && currentCommitRound < cr && !participationFinalized[currentCommitRound]) {
            _finalizeParticipation(currentCommitRound);
        }

        // Covers rounds that were skipped entirely (no commits) so they are never left dangling.
        if (cr > 0 && !participationFinalized[cr - 1]) {
            participationFinalized[cr - 1] = true;
        }
    }

    /**
     * @notice Internal finalize: freeze non-revealers and, when reveals exist, store the tentative winner.
     * @dev Freeze duration is max(selected truth, lastClaimedDepth) when reveals exist, otherwise
     * lastClaimedDepth, floored at MIN_NONREVEAL_FREEZE_DEPTH. lastClaimedDepth is only written after
     * a successful claim, so a skipped-claim fake-low truth cannot shrink the freeze. Called from
     * claim() and from the next round's first commit. Does not apply disagreement penalties, adjust
     * the oracle, or withdraw the pot.
     */
    function _finalizeParticipation(uint64 round) internal {
        if (participationFinalized[round]) {
            return;
        }

        uint256 commitsArrayLength = currentCommits.length;
        emit CountCommits(commitsArrayLength);
        emit CountReveals(currentReveals.length);

        bool hasReveals = currentRevealRound == round && currentReveals.length > 0;
        uint8 freezeDepth = lastClaimedDepth;
        uint256 revealCount = 0;

        if (hasReveals) {
            revealCount = currentReveals.length;

            SelectedSchellingPoint memory truth = _selectStsTruth();
            if (truth.selected) {
                selectedTruth = truth;
                freezeDepth = truth.depth > lastClaimedDepth ? truth.depth : lastClaimedDepth;
                emit StsTruthSelected(round, truth.hash, truth.stampHash, truth.depth);
            }
        }

        // Under STS-1 a stage one commit is unfinished until it becomes proof validated, so the
        // existing non-reveal freeze covers both no-shows and participants that revealed but
        // never proved. SWIP-050 carries unfinished entries across rounds in a separate list;
        // that list is unbounded and its freeze loop can brick claim, so the same invariant is
        // kept here on the commit array, which MAX_COMMITS already bounds. See
        // docs/SWIP-49-50-SCRUTINY.md 2.4.
        uint256 freezeDuration = _nonRevealFreezeDuration(freezeDepth);
        for (uint256 i = 0; i < commitsArrayLength; ) {
            Commit memory currentCommit = currentCommits[i];
            bool proven = currentCommit.revealed && currentReveals[currentCommit.revealIndex].proofSubmitted;
            if (!proven) {
                Stakes.freezeDeposit(currentCommit.owner, freezeDuration);
            }
            unchecked {
                ++i;
            }
        }

        participationFinalized[round] = true;
        emit ParticipationFinalized(round, revealCount);
    }

    /**
     * @notice Non-reveal freeze length: multiplier * ROUND_LENGTH * 2^depth, never using a zero depth.
     */
    function _nonRevealFreezeDuration(uint8 freezeDepth) private view returns (uint256) {
        if (freezeDepth == 0) {
            freezeDepth = MIN_NONREVEAL_FREEZE_DEPTH;
        }
        return penaltyMultiplierNonRevealed * ROUND_LENGTH * uint256(2 ** freezeDepth);
    }

    /**
     * @notice Reveal the pre-image values used to generate commit provided during this round's commit phase.
     * @param _depth The reported depth.
     * @param _hash The reserve commitment hash.
     * @param _revealNonce The nonce used to generate the commit that is being revealed.
     */
    function reveal(
        uint8 _depth,
        bytes32 _hash,
        bytes32 _chunkTransformRoot,
        bytes32 _revealNonce
    ) external whenNotPaused {
        uint64 cr = currentRound();
        bytes32 _overlay = Stakes.overlayOfAddress(msg.sender);

        if (cr != currentCommitRound) {
            revert NoCommitsReceived();
        }

        if (!currentPhaseReveal()) {
            revert NotRevealPhase();
        }

        if (cr != currentRevealRound) {
            currentRevealRoundAnchor = currentRoundAnchor();
            // Reveals are capped by MAX_COMMITS, so delete is bounded.
            delete currentReveals;
            // We set currentRevealRound ONLY after we set current anchor
            currentRevealRound = cr;
            emit CurrentRevealAnchor(cr, currentRevealRoundAnchor);
            updateRandomness();
            _resetStsStateForNewRevealRound();
        }

        // Locate the sender's commit by overlay first so DepthMismatch is reachable
        // before the wrapCommit pre-image check (depth is part of the pre-image).
        uint256 id = findCommitByOverlay(_overlay);
        Commit memory revealedCommit = currentCommits[id];

        // Reported depth must match the depth declared at commit time.
        if (_depth != revealedCommit.declaredDepth) {
            revert DepthMismatch();
        }

        bytes32 obfuscatedHash = wrapCommit(cr, _overlay, _depth, _hash, _chunkTransformRoot, _revealNonce);
        if (obfuscatedHash != revealedCommit.obfuscatedHash) {
            revert NoMatchingCommit();
        }

        uint8 depthResponsibility = _depth - revealedCommit.height;

        // Check that commit is in proximity of the current anchor
        if (!inProximity(revealedCommit.overlay, currentRevealRoundAnchor, depthResponsibility)) {
            revert OutOfDepthReveal(currentRevealRoundAnchor);
        }
        // Check that the commit has not already been revealed
        if (revealedCommit.revealed) {
            revert AlreadyRevealed();
        }

        currentCommits[id].revealed = true;
        currentCommits[id].revealIndex = currentReveals.length;

        currentReveals.push(
            Reveal({
                overlay: revealedCommit.overlay,
                owner: revealedCommit.owner,
                depth: _depth,
                stake: revealedCommit.stake,
                stakeDensity: revealedCommit.stake * uint256(2 ** depthResponsibility),
                hash: _hash,
                chunkTransformRoot: _chunkTransformRoot,
                stampHash: bytes32(0),
                effectiveStakeDensity: 0,
                stampRevealed: false,
                proofSubmitted: false
            })
        );

        // The first accepted stage one reveal opens the stamp anchor. Stage one commitments are
        // already fixed at this point, so no participant could have known which stamp indexes
        // would be useful when it chose its chunk transform root.
        _openStampAnchor(cr);

        emit Revealed(
            cr,
            revealedCommit.overlay,
            revealedCommit.stake,
            revealedCommit.stake * uint256(2 ** depthResponsibility),
            _hash,
            _depth
        );
    }

    /**
     * @notice Clear the previous round's STS randomness when a new reveal round opens.
     */
    function _resetStsStateForNewRevealRound() internal {
        currentRevealRoundStampAnchor = bytes32(0);
        currentRevealRoundStampAnchorSet = false;
        currentStampSampleHashRevealRound = 0;
        currentProofSeed = bytes32(0);
        currentSelectionSeed = bytes32(0);
        currentProofSeedSet = false;
        delete selectedTruth;
    }

    /**
     * @notice Derive the anchor that orders transformed stamp values for this round.
     */
    function _openStampAnchor(uint64 roundNumber) internal {
        if (currentRevealRoundStampAnchorSet) {
            return;
        }

        currentRevealRoundStampAnchor = keccak256(abi.encodePacked(seed, roundNumber, "STS1_STAMP_ANCHOR"));
        currentRevealRoundStampAnchorSet = true;
        emit StampAnchorOpened(roundNumber, currentRevealRoundStampAnchor);
    }

    /**
     * @notice Commit to a stamp sample hash for the round this caller already revealed in.
     * @dev Stage two is linked to stage one by requiring a valid stage one reveal for the same
     * round; the depth, chunk sample hash and chunk transform root are read from that reveal
     * rather than recommitted here.
     */
    function commitStampSampleHash(bytes32 _obfuscatedHash, uint64 _roundNumber) external whenNotPaused {
        if (!currentPhaseStampCommit()) {
            revert NotStampCommitPhase();
        }

        uint64 cr = currentRound();
        if (_roundNumber != cr || cr != currentRevealRound) {
            revert NoChunkSampleHashReveal();
        }

        bytes32 _overlay = Stakes.overlayOfAddress(msg.sender);
        uint256 commitIndex = findCommitByOverlay(_overlay);
        Commit storage stageOne = currentCommits[commitIndex];

        if (!stageOne.revealed) {
            revert NoChunkSampleHashReveal();
        }
        if (currentReveals[stageOne.revealIndex].stampRevealed) {
            revert AlreadyRevealed();
        }
        if (stageOne.stampObfuscatedHash != bytes32(0)) {
            revert AlreadyCommitted();
        }

        stageOne.stampObfuscatedHash = _obfuscatedHash;
    }

    /**
     * @notice Open the committed stamp sample hash.
     * @dev The first accepted stamp sample hash reveal opens the proof and selection seeds. It
     * must not advance the round seed: that already moved during the chunk sample hash reveal.
     */
    function revealStampSampleHash(
        uint64 _roundNumber,
        bytes32 _stampSampleHash,
        bytes32 _revealNonce
    ) external whenNotPaused {
        if (!currentPhaseStampReveal()) {
            revert NotStampRevealPhase();
        }

        uint64 cr = currentRound();
        if (_roundNumber != cr || cr != currentRevealRound) {
            revert NoChunkSampleHashReveal();
        }

        bytes32 _overlay = Stakes.overlayOfAddress(msg.sender);
        Commit storage stageOne = currentCommits[findCommitByOverlay(_overlay)];

        if (!stageOne.revealed || stageOne.stampObfuscatedHash == bytes32(0)) {
            revert NoStampSampleHashReveal();
        }

        Reveal storage revealRecord = currentReveals[stageOne.revealIndex];
        if (revealRecord.stampRevealed) {
            revert AlreadyRevealed();
        }

        if (wrapStampCommit(cr, _overlay, _stampSampleHash, _revealNonce) != stageOne.stampObfuscatedHash) {
            revert NoStampSampleHashReveal();
        }

        revealRecord.stampHash = _stampSampleHash;
        revealRecord.stampRevealed = true;

        _openProofSeed(cr);

        emit StampSampleRevealed(cr, _overlay, _stampSampleHash);
    }

    /**
     * @notice Derive the proof and selection seeds, once the stamp samples are already committed.
     * @dev The first stamp sample hash revealer of the round picks the block this lands in and
     * can therefore re-roll the draw by delaying within the reveal window. SWIP-050 specifies
     * this derivation; see docs/SWIP-49-50-SCRUTINY.md 2.7 for the grinding exposure and the
     * accumulate-across-reveals alternative.
     */
    function _openProofSeed(uint64 roundNumber) internal {
        if (currentProofSeedSet && currentStampSampleHashRevealRound == roundNumber) {
            return;
        }
        if (!currentRevealRoundStampAnchorSet) {
            revert MissingAnchor();
        }

        currentStampSampleHashRevealRound = roundNumber;
        currentProofSeed = keccak256(
            abi.encodePacked(currentRevealRoundStampAnchor, block.prevrandao, roundNumber, "STS1_PROOF_SEED")
        );
        currentSelectionSeed = keccak256(
            abi.encodePacked(currentRevealRoundStampAnchor, block.prevrandao, roundNumber, "STS1_SELECTION_SEED")
        );
        currentProofSeedSet = true;
    }

    // ----------------------------- SWIP-050 proof submission ------------------------------

    /**
     * @notice The three stamp sample positions this round must open.
     * @dev Two drawn from 0..14 without replacement and returned in ascending order, plus the
     * density witness at position 15. Because the seed only exists after the stamp samples are
     * committed, a sample padded with a few repeated provable values risks being asked for a
     * position it cannot support.
     */
    function selectedStampPositions(uint64 roundNumber) public view returns (uint32[3] memory positions) {
        if (currentStampSampleHashRevealRound != roundNumber || !currentProofSeedSet) {
            revert MissingAnchor();
        }

        uint32 a = uint32(uint256(keccak256(abi.encodePacked(currentProofSeed, uint256(0)))) % STAMP_DENSITY_WITNESS);
        uint32 b = uint32(
            uint256(keccak256(abi.encodePacked(currentProofSeed, uint256(1)))) % (STAMP_DENSITY_WITNESS - 1)
        );

        if (b >= a) b += 1;
        if (b < a) (a, b) = (b, a);

        positions[0] = a;
        positions[1] = b;
        positions[2] = STAMP_DENSITY_WITNESS;
    }

    /**
     * @notice Open the selected stamp witnesses and claim proof-validated status for this round.
     * @dev Each witness proves four things: that the transformed stamp value sits at the
     * selected position of the committed sample and is ordered against its neighbours; that the
     * batch and index were inside this round's SWIP-049 scope and the batch owner signed for
     * this chunk address; that the first-anchor transformed chunk address comes from the same
     * opened data as that chunk address; and that this transformed address was already a leaf of
     * the chunk transform root fixed in stage one.
     *
     * The last two are the participant-specific binding. Two nodes can reveal the same Schelling
     * point, but only one of them may hold the selected stamped chunks in its own root, which is
     * why every paid node proves for itself.
     */
    function submitStsProof(uint64 roundNumber, StampProof[3] calldata proofs) external whenNotPaused {
        if (!currentPhaseProof()) {
            revert NotProofPhase();
        }

        uint64 cr = currentRound();
        if (roundNumber != cr || cr != currentRevealRound) {
            revert NoChunkSampleHashReveal();
        }

        bytes32 _overlay = Stakes.overlayOfAddress(msg.sender);
        Commit storage stageOne = currentCommits[findCommitByOverlay(_overlay)];
        if (!stageOne.revealed) {
            revert NoChunkSampleHashReveal();
        }

        Reveal storage revealRecord = currentReveals[stageOne.revealIndex];
        if (!revealRecord.stampRevealed) {
            revert NoStampSampleHashReveal();
        }
        if (revealRecord.proofSubmitted) {
            revert ProofAlreadySubmitted();
        }

        uint32[3] memory positions = selectedStampPositions(cr);
        uint256 samplingStart = samplingStartBlock(cr);
        uint256 requiredNormalisedBalance = PostageContract.redistributionMinimumNormalisedBalance(samplingStart);

        uint256 sumIndexRatioQ64;
        bytes32 densityValue;

        for (uint256 i = 0; i < STS_WITNESS_COUNT; ) {
            if (proofs[i].sampleIndex != positions[i]) {
                revert StampWitnessPositionMismatch();
            }

            (bytes32 transformedStamp, uint256 indexRatioQ64) = _verifyOneStampWitness(
                revealRecord,
                proofs[i],
                samplingStart,
                requiredNormalisedBalance
            );

            sumIndexRatioQ64 += indexRatioQ64;
            if (proofs[i].sampleIndex == STAMP_DENSITY_WITNESS) {
                densityValue = transformedStamp;
            }

            unchecked {
                ++i;
            }
        }

        uint256 weight = StsWitness.weightFor(
            revealRecord.stakeDensity,
            uint256(densityValue),
            stampSampleMaxValue,
            sumIndexRatioQ64,
            STS_WITNESS_COUNT
        );
        if (weight == 0) {
            revert StampReserveCheckFailed(densityValue);
        }

        revealRecord.effectiveStakeDensity = weight;
        revealRecord.proofSubmitted = true;

        emit StsProofAccepted(cr, _overlay, weight);
    }

    /**
     * @notice Run one witness through StsWitness and translate its failure code into a revert.
     * @dev The library is deployed separately because this contract does not fit under EIP-170
     * with the verification inlined. It reports failures rather than reverting so that every
     * custom error stays in this contract's ABI and remains decodable by clients.
     */
    function _verifyOneStampWitness(
        Reveal storage revealRecord,
        StampProof calldata proof,
        uint256 samplingStart,
        uint256 requiredNormalisedBalance
    ) internal view returns (bytes32 transformedStamp, uint256 indexRatioQ64) {
        StsWitness.Result memory result = StsWitness.verifyWitness(
            proof,
            StsWitness.Context({
                stampAnchor: currentRevealRoundStampAnchor,
                roundAnchor: currentRevealRoundAnchor,
                proofSeed: currentProofSeed,
                stampHash: revealRecord.stampHash,
                chunkTransformRoot: revealRecord.chunkTransformRoot,
                claimedDepth: revealRecord.depth,
                samplingStart: samplingStart,
                requiredNormalisedBalance: requiredNormalisedBalance,
                postageContract: PostageContract
            })
        );

        _requireWitnessAccepted(result, proof.sampleIndex);

        return (result.transformedStamp, result.indexRatioQ64);
    }

    function _requireWitnessAccepted(StsWitness.Result memory result, uint32 sampleIndex) private pure {
        uint8 failure = result.failure;
        if (failure == StsWitness.FAIL_NONE) return;

        if (failure == StsWitness.FAIL_POSITION) revert StampWitnessPositionMismatch();
        if (failure == StsWitness.FAIL_INCLUSION) revert StampInclusionProofFailed(sampleIndex);
        if (failure == StsWitness.FAIL_ORDER) revert StampLocalOrderCheckFailed(sampleIndex);
        if (failure == StsWitness.FAIL_BALANCE) revert BatchNotUsableForTargetRound(result.subject);
        if (failure == StsWitness.FAIL_INDEX) revert IndexOutsideSet(result.subject);
        if (failure == StsWitness.FAIL_BUCKET) revert BucketDiffers(result.subject);
        if (failure == StsWitness.FAIL_SIGNATURE) revert SigRecoveryFailed(result.subject);
        if (failure == StsWitness.FAIL_PROXIMITY) revert OutOfDepthClaim(sampleIndex);
        if (failure == StsWitness.FAIL_SISTER_SEGMENT) revert InclusionProofFailed(2, result.subject);
        if (failure == StsWitness.FAIL_ORIGINAL_ADDRESS) revert InclusionProofFailed(3, result.subject);
        if (failure == StsWitness.FAIL_CHUNK_MISMATCH) revert ChunkAddressMismatch();
        if (failure == StsWitness.FAIL_SOC_SIGNATURE) revert SocVerificationFailed(result.subject);
        if (failure == StsWitness.FAIL_SOC_ADDRESS) revert SocCalcNotMatching(result.subject);
        revert ChunkTransformMembershipFailed();
    }

    // ----------------------------- SWIP-050 truth selection and claim ------------------------------

    /**
     * @notice Running weighted draw over proof validated entries.
     * @dev Only an entry whose witnesses and bindings have passed carries weight, so an
     * unproven sample hash can neither become the truth nor influence who does. The drawn
     * entry's (chunkSampleHash, stampSampleHash, depth) becomes the Schelling point.
     */
    function _selectStsTruth() internal view returns (SelectedSchellingPoint memory truth) {
        bytes32 anchor = keccak256(abi.encodePacked(currentSelectionSeed, uint256(0)));
        uint256 totalWeight;
        uint256 revealsLength = currentReveals.length;

        for (uint256 i = 0; i < revealsLength; ) {
            Reveal storage revealRecord = currentReveals[i];

            if (revealRecord.proofSubmitted && revealRecord.effectiveStakeDensity > 0) {
                totalWeight += revealRecord.effectiveStakeDensity;
                uint256 draw = uint256(keccak256(abi.encodePacked(anchor, i)) & MAX_H);

                if (draw * totalWeight < revealRecord.effectiveStakeDensity * (uint256(MAX_H) + 1)) {
                    truth = SelectedSchellingPoint({
                        hash: revealRecord.hash,
                        stampHash: revealRecord.stampHash,
                        depth: revealRecord.depth,
                        selected: true
                    });
                }
            }

            unchecked {
                ++i;
            }
        }
    }

    function _matchesTruth(
        Reveal storage revealRecord,
        SelectedSchellingPoint memory truth
    ) internal view returns (bool) {
        return
            revealRecord.proofSubmitted &&
            revealRecord.hash == truth.hash &&
            revealRecord.stampHash == truth.stampHash &&
            revealRecord.depth == truth.depth;
    }

    /**
     * @notice Divide the round pot among every proof validated entry on the selected Schelling
     * point, and freeze the proof validated entries that disagree with it.
     * @dev Shares are proportional to effective stake density. SWIP-050 hands the rounding
     * remainder to whichever matching entry happens to be last in the reveal array, which is
     * both arbitrary and a reason to reorder one's reveal; it goes to the highest weight entry
     * here instead. See docs/SWIP-49-50-SCRUTINY.md 2.5.
     */
    function _applyPayoutsAndFreezes(
        uint64 round,
        SelectedSchellingPoint memory truth,
        uint256 pot
    ) internal returns (uint16 redundancy) {
        uint256 revealsLength = currentReveals.length;
        uint256 totalTruthyWeight;
        uint256 bestWeight;
        uint256 bestIndex;

        for (uint256 i = 0; i < revealsLength; ) {
            Reveal storage revealRecord = currentReveals[i];
            if (_matchesTruth(revealRecord, truth)) {
                totalTruthyWeight += revealRecord.effectiveStakeDensity;
                if (revealRecord.effectiveStakeDensity > bestWeight) {
                    bestWeight = revealRecord.effectiveStakeDensity;
                    bestIndex = i;
                }
            }
            unchecked {
                ++i;
            }
        }

        if (totalTruthyWeight == 0) {
            revert NoClaimableTruth();
        }

        uint256 paid;
        uint256 disagreementFreeze = penaltyMultiplierDisagreement * ROUND_LENGTH * uint256(2 ** truth.depth);

        for (uint256 i = 0; i < revealsLength; ) {
            Reveal storage revealRecord = currentReveals[i];

            if (_matchesTruth(revealRecord, truth)) {
                uint256 share = Math.mulDiv(pot, revealRecord.effectiveStakeDensity, totalTruthyWeight);
                pendingRedistributionPayouts[revealRecord.owner] += share;
                paid += share;
                redundancy += 1;
                emit PayoutAccrued(round, revealRecord.overlay, revealRecord.owner, share);
            } else if (revealRecord.proofSubmitted && block.prevrandao % 100 < penaltyRandomFactor) {
                Stakes.freezeDeposit(revealRecord.owner, disagreementFreeze);
            }

            unchecked {
                ++i;
            }
        }

        if (pot > paid) {
            pendingRedistributionPayouts[currentReveals[bestIndex].owner] += pot - paid;
        }
    }

    /**
     * @notice Close the round: pay every proof validated entry on the selected Schelling point.
     * @dev The price is adjusted only here, after every witness of this round has already been
     * verified in the proof phase. That ordering is what lets PostageStamp reconstruct a single
     * unambiguous price for this round's sampling start.
     */
    function claim() external whenNotPaused {
        uint64 cr = currentRound();

        if (!currentPhaseClaim()) {
            revert NotClaimPhase();
        }

        if (!participationFinalized[cr]) {
            _finalizeParticipation(cr);
        }

        if (cr != currentRevealRound || currentReveals.length == 0) {
            revert NoReveals();
        }

        if (cr <= currentClaimRound) {
            revert AlreadyClaimed();
        }

        SelectedSchellingPoint memory truth = selectedTruth;
        if (!truth.selected) {
            revert NoClaimableTruth();
        }

        // The pot is withdrawn into this contract and drawn down per beneficiary. Measuring the
        // delta keeps payouts already accrued in earlier rounds out of this round's split.
        uint256 balanceBefore = bzzToken.balanceOf(address(this));
        PostageContract.withdraw(address(this));
        uint256 pot = bzzToken.balanceOf(address(this)) - balanceBefore;

        uint16 redundancy = _applyPayoutsAndFreezes(cr, truth, pot);

        bool success = OracleContract.adjustPrice(redundancy);
        if (!success) {
            emit PriceAdjustmentSkipped(redundancy);
        }

        lastRedundancyCount = redundancy;
        lastClaimedDepth = truth.depth;
        currentClaimRound = cr;
        emit ChunkCount(PostageContract.validChunkCount());
    }

    /**
     * @notice Draw down an accrued redistribution payout.
     * @dev Deliberately callable while paused: a pause must not strand funds that were already
     * earned. See docs/SWIP-49-50-SCRUTINY.md 2.5.
     */
    function withdrawRedistributionPayout(address receiver) external {
        uint256 amount = pendingRedistributionPayouts[msg.sender];
        if (amount == 0) {
            revert NoPayout();
        }

        pendingRedistributionPayouts[msg.sender] = 0;
        if (!bzzToken.transfer(receiver, amount)) {
            revert TransferFailed();
        }

        emit PayoutWithdrawn(msg.sender, receiver, amount);
    }

    /**
     * @notice Set freezing parameters
     */
    function setFreezingParams(
        uint8 _penaltyMultiplierDisagreement,
        uint8 _penaltyMultiplierNonRevealed,
        uint8 _penaltyRandomFactor
    ) external {
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
            revert NotAdmin();
        }

        penaltyMultiplierDisagreement = _penaltyMultiplierDisagreement;
        penaltyMultiplierNonRevealed = _penaltyMultiplierNonRevealed;
        penaltyRandomFactor = _penaltyRandomFactor;
    }

    /**
     * @notice Changes the ceiling the stamp sample density witness must fall under.
     * @dev Depth independent by design. See docs/SWIP-49-50-SCRUTINY.md 2.1.
     */
    function setStampSampleMaxValue(uint256 _stampSampleMaxValue) external {
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
            revert NotAdmin();
        }

        stampSampleMaxValue = _stampSampleMaxValue;
    }

    /**
     * @notice Updates the source of randomness. Uses block.difficulty in pre-merge chains, this is substituted
     * to block.prevrandao in post merge chains.
     */
    function updateRandomness() private {
        seed = keccak256(abi.encode(seed, block.prevrandao));
    }

    /**
    * @dev Pause the contract. The contract is provably stopped by renouncing
     the pauser role and the admin role after pausing, can only be called by the `PAUSER`
     */
    function pause() public {
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
            revert OnlyPauser();
        }

        _pause();
    }

    /**
     * @dev Unpause the contract, can only be called by the pauser when paused
     */
    function unPause() public {
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
            revert OnlyPauser();
        }
        _unpause();
    }

    ////////////////////////////////////////
    //            STATE READING           //
    ////////////////////////////////////////

    // ----------------------------- Anchor calculations ------------------------------

    /**
     * @notice Returns the current random seed which is used to determine later utilised random numbers.
     * If rounds have elapsed without reveals, hash the seed with an incremented nonce to produce a new
     * random seed and hence a new round anchor.
     */
    function currentSeed() public view returns (bytes32) {
        uint64 cr = currentRound();
        bytes32 currentSeedValue = seed;

        if (cr > currentRevealRound + 1) {
            uint256 difference = cr - currentRevealRound - 1;
            currentSeedValue = keccak256(abi.encodePacked(currentSeedValue, difference));
        }

        return currentSeedValue;
    }

    /**
     * @notice Returns the seed which will become current once the next commit phase begins.
     * Used to determine what the next round's anchor will be.
     */
    function nextSeed() public view returns (bytes32) {
        uint64 cr = currentRound() + 1;
        bytes32 currentSeedValue = seed;

        if (cr > currentRevealRound + 1) {
            uint256 difference = cr - currentRevealRound - 1;
            currentSeedValue = keccak256(abi.encodePacked(currentSeedValue, difference));
        }

        return currentSeedValue;
    }

    /**
     * @notice The anchor used to determine eligibility for the current round.
     * @dev A node must be within proximity order of less than or equal to the storage depth they intend to report.
     */
    function currentRoundAnchor() public view returns (bytes32 returnVal) {
        // Once the chunk sample hash reveal phase is over, this round's anchor has been consumed
        // and the only useful answer is the next round's. Under the SWIP-050 schedule that
        // covers the stamp commit, stamp reveal, proof and claim phases, which together are most
        // of the round; before SWIP-050 it was the claim phase alone.
        if (block.number % ROUND_LENGTH >= STAMP_COMMIT_START) {
            return nextSeed();
        }

        // Commit phase eligibility, and the reveal phase of a round whose anchor is not yet fixed.
        if (currentPhaseCommit() || currentRound() > currentRevealRound) {
            return currentSeed();
        }

        // In the reveal phase of the active round the anchor is already fixed and consumed. We
        // prefer a revert here to returning 0x0, which is a value callers would act on.
        revert FirstRevealDone();
    }

    /**
     * @notice The block at which sampling for `targetRound` began.
     * @dev Sampling for round `r` starts at the first reveal block of round `r - 1`, which is the
     * first scheduled block in which a successful reveal can fix the anchor that round `r`
     * consumes. SWIP-049 freezes the usable batch and stamp-index set at this block: Bee builds
     * its sample against the state at the end of the preceding block, and the claim must be
     * verified against exactly the same state.
     */
    function samplingStartBlock(uint64 targetRound) public pure returns (uint256) {
        if (targetRound == 0) {
            revert InvalidTargetRound();
        }
        return uint256(targetRound - 1) * ROUND_LENGTH + ROUND_LENGTH / 4;
    }

    /**
     * @notice Returns true if an overlay address _A_ is within proximity order _minimum_ of _B_.
     * @param A An overlay address to compare.
     * @param B An overlay address to compare.
     * @param minimum Minimum proximity order.
     */
    function inProximity(bytes32 A, bytes32 B, uint8 minimum) public pure returns (bool) {
        if (minimum == 0) {
            return true;
        }

        return uint256(A ^ B) < uint256(2 ** (256 - minimum));
    }

    // ----------------------------- Commit ------------------------------

    /**
     * @notice The number of the current round.
     */
    function currentRound() public view returns (uint64) {
        return uint64(block.number / ROUND_LENGTH);
    }

    /**
     * @notice Returns true if current block is during the chunk sample hash commit phase.
     */
    function currentPhaseCommit() public view returns (bool) {
        return block.number % ROUND_LENGTH < CHUNK_REVEAL_START;
    }

    /**
     * @notice Returns true if current block is during the stamp sample hash commit phase.
     */
    function currentPhaseStampCommit() public view returns (bool) {
        uint256 p = block.number % ROUND_LENGTH;
        return p >= STAMP_COMMIT_START && p < STAMP_REVEAL_START;
    }

    /**
     * @notice Returns true if current block is during the stamp sample hash reveal phase.
     */
    function currentPhaseStampReveal() public view returns (bool) {
        uint256 p = block.number % ROUND_LENGTH;
        return p >= STAMP_REVEAL_START && p < PROOF_START;
    }

    /**
     * @notice Returns true if current block is during the proof submission phase.
     */
    function currentPhaseProof() public view returns (bool) {
        uint256 p = block.number % ROUND_LENGTH;
        return p >= PROOF_START && p < CLAIM_START;
    }

    /**
     * @notice Determine if a the owner of a given overlay can participate in the upcoming round.
     * @param _owner The address of the applicant from.
     * @param _depth The storage depth the applicant intends to report.
     */
    function isParticipatingInUpcomingRound(address _owner, uint8 _depth) public view returns (bool) {
        uint256 _lastUpdate = Stakes.lastUpdatedBlockNumberOfAddress(_owner);
        uint8 _height = Stakes.heightOfAddress(_owner);

        if (currentPhaseReveal()) {
            revert WrongPhase();
        }

        if (_lastUpdate == 0) {
            revert NotStaked();
        }

        if (_lastUpdate >= block.number - 2 * ROUND_LENGTH) {
            revert MustStake2Rounds();
        }

        // Depth must be strictly greater than height to have a valid proximity responsibility.
        if (_depth <= _height) {
            return false;
        }

        return inProximity(Stakes.overlayOfAddress(_owner), currentRoundAnchor(), _depth - _height);
    }

    /**
     * @notice Stake-weighted admission priority (lower is better).
     * @dev weight = max(stake, 1); ties in priority are broken elsewhere by higher overlay uint.
     */
    function admissionPriority(
        uint64 round,
        bytes32 anchor,
        bytes32 overlay,
        uint256 stake
    ) public pure returns (uint256) {
        uint256 weight = stake > 0 ? stake : 1;
        return uint256(keccak256(abi.encodePacked(round, anchor, overlay))) / weight;
    }

    // ----------------------------- Reveal ------------------------------

    /**
     * @notice Helper function to get this node reveal in commits
     * @dev
     */
    function findCommit(bytes32 _overlay, bytes32 _obfuscatedHash) internal view returns (uint256) {
        for (uint256 i = 0; i < currentCommits.length; ) {
            if (currentCommits[i].overlay == _overlay && _obfuscatedHash == currentCommits[i].obfuscatedHash) {
                return i;
            }
            unchecked {
                ++i;
            }
        }
        revert NoMatchingCommit();
    }

    /**
     * @notice Locate a commit by overlay alone (used by reveal before depth/hash checks).
     */
    function findCommitByOverlay(bytes32 _overlay) internal view returns (uint256) {
        for (uint256 i = 0; i < currentCommits.length; ) {
            if (currentCommits[i].overlay == _overlay) {
                return i;
            }
            unchecked {
                ++i;
            }
        }
        revert NoMatchingCommit();
    }

    /**
     * @notice Hash the pre-image values to the obsfucated hash.
     * @dev _revealNonce_ must be randomly generated, used once and kept secret until the reveal phase.
     * @param _overlay The overlay address of the applicant.
     * @param _depth The reported depth.
     * @param _hash The reserve commitment hash.
     * @param revealNonce A random, single use, secret nonce.
     */
    function wrapCommit(
        uint64 _commitRound,
        bytes32 _overlay,
        uint8 _depth,
        bytes32 _hash,
        bytes32 _chunkTransformRoot,
        bytes32 revealNonce
    ) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(_commitRound, _overlay, _depth, _hash, _chunkTransformRoot, revealNonce));
    }

    /**
     * @notice Hash the pre-image values of the stage two stamp sample hash commitment.
     * @dev Bound to the same round and overlay as the stage one commitment. It does not recommit
     * the chunk sample hash, the chunk transform root or the depth; those were already fixed by
     * stage one and are read from the stored reveal.
     */
    function wrapStampCommit(
        uint64 _commitRound,
        bytes32 _overlay,
        bytes32 _stampSampleHash,
        bytes32 revealNonce
    ) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(_commitRound, _overlay, _stampSampleHash, revealNonce));
    }

    /**
     * @notice Returns true if current block is during reveal phase.
     */
    function currentPhaseReveal() public view returns (bool) {
        uint256 number = block.number % ROUND_LENGTH;
        return number >= CHUNK_REVEAL_START && number < STAMP_COMMIT_START;
    }

    /**
     * @notice Returns true if current block is during reveal phase.
     */
    function currentRoundReveals() public view returns (Reveal[] memory) {
        if (!currentPhaseClaim()) {
            revert NotClaimPhase();
        }
        uint64 cr = currentRound();
        if (cr != currentRevealRound) {
            revert NoReveals();
        }

        return currentReveals;
    }

    // ----------------------------- Claim  ------------------------------

    /**
     * @notice Returns true if current block is during claim phase.
     */
    function currentPhaseClaim() public view returns (bool) {
        return block.number % ROUND_LENGTH >= CLAIM_START;
    }

    /**
     * @notice Whether an overlay is proof validated and on the Schelling point selected as truth.
     * @dev STS-1 pays every such entry in proportion to its effective stake density, so this
     * replaces the single-beneficiary isWinner of the chunk-only game.
     */
    function matchesSelectedTruth(bytes32 _overlay) public view returns (bool) {
        if (!currentPhaseClaim()) {
            revert NotClaimPhase();
        }

        uint64 cr = currentRound();
        if (cr != currentRevealRound) {
            revert NoReveals();
        }

        SelectedSchellingPoint memory truth = selectedTruth;
        if (!truth.selected) {
            return false;
        }

        uint256 revealsLength = currentReveals.length;
        for (uint256 i = 0; i < revealsLength; ) {
            if (currentReveals[i].overlay == _overlay) {
                return _matchesTruth(currentReveals[i], truth);
            }
            unchecked {
                ++i;
            }
        }

        return false;
    }

    function addressToBucket(bytes32 swarmAddress, uint8 bucketDepth) internal pure returns (uint32) {
        uint32 prefix = uint32(uint256(swarmAddress) >> (256 - 32));
        return prefix >> (32 - bucketDepth);
    }

    function postageStampIndexCount(uint8 postageDepth, uint8 bucketDepth) internal pure returns (uint256) {
        return 1 << (postageDepth - bucketDepth);
    }

    function getPostageIndex(uint64 signedIndex) internal pure returns (uint32) {
        return uint32(signedIndex);
    }

    function getPostageBucket(uint64 signedIndex) internal pure returns (uint64) {
        return uint32(signedIndex >> 32);
    }

    function calculateSocAddress(bytes32 identifier, address signer) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(identifier, signer));
    }
}
