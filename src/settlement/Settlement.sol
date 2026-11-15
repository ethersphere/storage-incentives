// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import {ClaimVerifier, IClaimPostage} from "./ClaimVerifier.sol";

interface IGameKeys {
    /// The stake commitment of `owner`, and the lastUpdatedBlockNumber of its stake record.
    function commitmentOf(address owner) external returns (uint256 commitment, uint256 lastUpdated);

    /// MiMC (gnark-crypto, BN254): the compression function and the hash of a list of field elements.
    function compress(uint256 left, uint256 right) external pure returns (uint256);

    function mimc(uint256[] calldata xs) external pure returns (uint256);

    function wrapCommit(bytes32 overlay, uint8 depth, bytes32 hash, bytes32 nonce) external pure returns (bytes32);
}

interface ISettlementStakes {
    function freezeDeposit(address _owner, uint256 _time) external;

    function stakes(
        address _owner
    )
        external
        view
        returns (
            bytes32 overlay,
            uint256 committedStake,
            uint256 potentialStake,
            uint256 lastUpdatedBlockNumber,
            uint8 height
        );
}

interface ISettlementPostage {
    function withdraw(address beneficiary, uint256 amount) external;


    /// The pot at the seed block of a game round: everything the batches paid up to that block.
    function potAt(uint64 round) external returns (uint256);

    /// Bring the pot accounting up to this block (stores the cut of the last round).
    function checkpoint() external;
}

interface ISettlementOracle {
    function adjustPrice(uint16 redundancy) external returns (bool);

    function adjustPriceForRound(uint64 round, uint16 redundancy) external returns (bool);

    function currentPrice() external view returns (uint32);
}

/**
 * @title Settlement
 * @author The Swarm Authors
 * @notice Replaces Redistribution. The Schelling game (commit, reveal, truth and winner selection, freezes,
 * redundancy count for the price oracle), the claim's storage evidence (chunk inclusion proofs, postage
 * stamps, SOC signatures, reserve size estimate) and the postage accounting (batch expiry and the pot,
 * which PostageStamp.expireLimited did on chain) run off chain in the Redistribution VM (prover/crates/vm).
 * A prover proves the VM run with SP1 and this contract checks the proof and applies the result: pays the
 * winner the proven pot from PostageStampZK, freezes stakes and adjusts the price. See
 * docs/ZK-SETTLEMENT.md.
 *
 * Round layout, in blocks relative to the round start. ROUND_LENGTH = 64: with 12 s blocks a round is about
 * 12.8 minutes, the same time as the Gnosis round of Redistribution (152 blocks x 5 s).
 *
 *   [ 0, 16)  commit         nodes send signed commits to a prover; or call forceCommit
 *   [16, 20)  anchor         a prover calls anchorRound(commitsHash) once
 *   [20, 24)  commit check   nodes check the anchored list; a node left out calls forceCommit
 *   [24, 40)  reveal         nodes send reveals to a prover; or call forceReveal
 *   [40, 44)  reveal anchor  the prover calls anchorReveals(revealsHash) once
 *   [44, 48)  reveal check   nodes check the anchored reveals; a node left out calls forceReveal
 *   48        seed block     its prevrandao becomes the selection seed. Nobody chooses it
 *   [49, 64)  claim          a truth-teller sends the claim witness to a prover; or calls forceClaim
 *   [49, ...) settle         anyone calls settleRound(publicValues, proof), rounds in increasing order.
 *                            A round whose truth has no valid witness ("unclaimed") settles only from 64
 *
 * forceCommit stays open until 24 and forceReveal until 48, so the last 4 blocks of each window come after
 * the anchor: a prover that leaves a node out of an anchored list cannot stop it from going on chain.
 * Without anchorReveals the prover could keep a commit and drop its reveal, and so freeze an honest node.
 *
 * Nothing in this contract decides who won. It only checks that the proof's public inputs match what
 * the chain knows (anchor, seed, commit set, forced queues, stake records, game state, parameters) and
 * then executes the proof's outputs.
 */
contract Settlement is AccessControl, Pausable {
    // ----------------------------- Type declarations ------------------------------

    /// @dev The three structs below must match prover/crates/vm/src/types.rs field for field.
    /// The proof of a round, and the data that this contract checks itself.
    struct Evidence {
        // Which game circuit the proof is for (index in `gameCircuits`).
        uint8 gameCircuit;
        // The Groth16 proof of the game circuit (gnark, `MarshalSolidity`).
        bytes proof;
        // RLP headers of block roundStart - 1 and of the seed block.
        bytes anchorHeader;
        bytes seedHeader;
        // ABI-encoded `ClaimVerifier.ClaimWitness` for the truth's sample, or empty.
        bytes claimWitness;
        // For an "unclaimed" settlement: every witness of `forceClaim`, in chain order.
        bytes[] forcedClaims;
    }

    /// What the proof commits to, with the inputs that this contract builds itself (`_packInputs`).
    struct Outcome {
        uint64 round;
        // False when no node revealed: the round changes nothing.
        bool hasReveals;
        bytes32 truthHash;
        uint8 truthDepth;
        address winner;
        uint16 redundancy;
        address feeRecipient;
        // Owners of the anchored commits (in the anchored order), then of the forced commits.
        address[] owners;
        // One byte for each owner: 0 no freeze, 1 disagreement, 2 no reveal or the stake changed.
        bytes freeze;
    }


    struct RoundInfo {
        bytes32 anchorBlockHash;
        bytes32 commitsHash;
        uint32 commitCount;
        bool anchored;
        bool settled;
        bytes32 forcedCommitsHash;
        uint32 forcedCommitCount;
        bytes32 forcedRevealsHash;
        uint32 forcedRevealCount;
        bytes32 forcedClaimsHash;
        uint32 forcedClaimCount;
        // Off-chain reveals fixed by anchorReveals. Zero hash and count when the prover did not anchor them.
        bytes32 revealsHash;
        uint32 revealCount;
        bool revealsAnchored;
    }

    /**
     * @dev One entry of the round ring (`ring[round % RING_SIZE]`). The first storage slot holds the round
     * number, the counts and the flags; it is rewritten when a new round takes the entry. The five hash
     * slots are never set back to zero: a write to a zero slot costs a new-slot write (about 20k gas,
     * about 110k on Sepolia), a write to a used slot about 5k. A hash slot counts only when its count or
     * flag says it was written for this round (see `rounds`).
     */
    struct RoundSlot {
        uint64 round;
        // The anchored round before this one (set at the anchor). settleRound checks only that round for
        // "an earlier anchored round can still settle" (the rounds in between are not anchored).
        uint64 prevAnchored;
        uint16 commitCount;
        uint16 revealCount;
        uint16 forcedCommitCount;
        uint16 forcedRevealCount;
        uint16 forcedClaimCount;
        bool anchored;
        bool revealsAnchored;
        bool settled;
        bytes32 commitsHash;
        bytes32 revealsHash;
        bytes32 forcedCommitsHash;
        bytes32 forcedRevealsHash;
        bytes32 forcedClaimsHash;
    }

    // ----------------------------- State variables ------------------------------

    uint256 public constant ROUND_LENGTH = 64;
    uint256 public constant COMMIT_END = 16;
    uint256 public constant ANCHOR_END = 20;
    uint256 public constant REVEAL_START = 24;
    uint256 public constant REVEAL_ANCHOR_START = 40;
    uint256 public constant REVEAL_ANCHOR_END = 44;
    uint256 public constant REVEAL_END = 48;
    uint256 public constant SEED_OFFSET = 48;
    uint256 public constant CLAIM_START = 49;

    // Upper bound on forced entries per round, so a spammer cannot make a round unprovable.
    uint32 public constant MAX_FORCED_PER_ROUND = 256;
    uint32 public constant MAX_FORCED_CLAIMS_PER_ROUND = 16;
    uint256 public constant MAX_CLAIM_WITNESS_SIZE = 16384;

    // Round state is kept for the last RING_SIZE rounds. A round can only settle while EIP-2935 still
    // serves its seed block hash, 8191 blocks = 128 rounds, so older entries can be reused. Must be more
    // than 128: round N stays settleable until block 47 of round N + 128.
    uint64 public constant RING_SIZE = 256;
    // Round number of a ring entry that warmRing filled but no round has used yet.
    uint64 private constant WARM = type(uint64).max;

    // EIP-2935 block hash history contract (Pectra). Serves the last 8191 block hashes.
    address public constant HISTORY_STORAGE = 0x0000F90827F1C53a10cb7A02335B175320002935;
    uint256 public constant HISTORY_SERVE_WINDOW = 8191;

    // An anchored round that does not settle blocks later rounds for this many rounds after it ends, then
    // later rounds can pass it. Without a limit, a round whose anchored lists were lost blocked all
    // settlement until its seed was gone (8191 blocks, about 27 hours; long Sepolia run, 2026-11-06).
    uint256 public constant PENDING_ROUNDS = 3;

    bytes32 public constant ANCHOR_ROLE = keccak256("ANCHOR_ROLE");
    // The BN254 scalar field: the field of the circuit and of MiMC.
    uint256 public constant FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    bytes32 public constant COMMIT_TYPEHASH =
        keccak256("SwarmSettlementCommit(uint256 chainId,address settlement,uint64 round,bytes32 obfuscatedHash)");

    ISettlementStakes public immutable Stakes;
    ISettlementPostage public immutable PostageContract;
    ISettlementOracle public immutable OracleContract;

    IGameKeys public immutable GameKeys;
    ClaimVerifier public immutable Claims;
    // Root of an anchored list with no entries (MiMC tree of depth 8 over zero leaves).
    bytes32 public immutable EMPTY_LIST_ROOT;

    // The verifiers of the game circuit, and the size of the game circuit:
    // anchored commits and reveals, and forced commits and reveals, that one proof can hold.
    struct GameCircuit {
        address verifier;
        uint16 capacity; // anchored commits and reveals
        uint16 forcedCapacity; // forced commits and reveals
        bytes4 selector; // of verifyProof(bytes,uint256[12 + capacity + forcedCapacity])
    }
    // Two sizes of the game circuit: a prover uses the smallest one that holds the round, because each
    // public input of a verifier costs gas. An entry with a zero verifier is not in use.
    GameCircuit[2] public gameCircuits;

    // Seconds between proposeVerifier and the earliest applyVerifier. Fixed at deployment: 0 on test
    // networks; on mainnet long enough for nodes to react (for example 7 days).
    uint64 public immutable verifierDelay;
    struct PendingVerifier {
        uint8 slot;
        address gameVerifier;
        uint16 capacity;
        uint16 forcedCapacity;
        uint64 eta;
    }
    PendingVerifier public pendingVerifier;

    RoundSlot[256] internal ring;

    // Game state carried between rounds. Same meaning as currentClaimRound / winner.depth in Redistribution.
    uint64 public lastSettledRound;
    // The last round that was anchored (anchorRound or anchorEmpty).
    uint64 public lastAnchoredRound;
    uint64 public lastClaimRound;
    uint8 public lastWinnerDepth;

    // Same defaults as Redistribution.
    uint8 public penaltyMultiplierDisagreement = 1;
    uint8 public penaltyMultiplierNonRevealed = 2;
    uint8 public penaltyRandomFactor = 100;

    // A stake must be this many rounds old at the round start to play (Redistribution: 2). 0 lets a node
    // play in the round after it staked; for test networks only.
    uint8 public stakeAgeRounds = 2;

    // Redistribution's reserve size estimate bound (alpha=0.097612 beta=0.0716570 k=16).
    uint256 public sampleMaxValue = 1284401000000000000000000000000000000000000000000000000000000000000000000;

    // What was paid out of the pot so far. PostageStampZK computes the pot (`potAt`): a claimed round
    // pays the pot at its seed block minus this amount. The pot of a round without a payout stays for
    // the next winner.
    uint256 public potPaid;

    // The lastUpdatedBlockNumber that the last freeze of this contract gave each node. A stake record with
    // this value was changed by a freeze, not by its owner. On master a frozen node cannot commit; here
    // its commit is dropped without a new freeze (see `_stakeInputs`).
    mapping(address => uint256) public frozenUntil;

    // Share of the pot paid to whoever submits a valid settlement, in basis points.
    uint16 public proverFeeBps = 100;

    // The last round (+1) in which an address used each escape hatch: one forced commit, reveal and claim
    // for each staked address and round. Without it, junk entries from anyone filled the per-round caps
    // cheaply, and censorship worked again. One reused slot for each address.
    struct ForcedRounds {
        uint64 commit;
        uint64 reveal;
        uint64 claim;
    }
    mapping(address => ForcedRounds) internal forcedBy;

    // ----------------------------- Events ------------------------------

    event RoundAnchored(
        uint64 indexed round,
        bytes32 anchorBlockHash,
        bytes32 commitsHash,
        uint32 commitCount,
        bytes32 dataRef
    );
    event RevealsAnchored(uint64 indexed round, bytes32 revealsHash, uint32 revealCount, bytes32 dataRef);
    event CommitForced(uint64 indexed round, address indexed owner, bytes32 obfuscatedHash);
    event RevealForced(uint64 indexed round, bytes32 indexed overlay, uint8 depth, bytes32 hash, bytes32 nonce);
    event ClaimForced(uint64 indexed round, address indexed sender, bytes witness);
    event RoundUnclaimed(uint64 indexed round, address winner, bytes32 truthHash);
    event RoundSettled(
        uint64 indexed round,
        bool hasTruth,
        bytes32 truthHash,
        uint8 truthDepth,
        address winner,
        uint16 redundancy,
        uint256 payout,
        address prover,
        uint256 proverFee
    );
    event PriceAdjustmentSkipped(uint16 redundancyCount);
    event VerifierChanged(
        uint8 slot,
        address gameVerifier,
        uint16 capacity,
        uint16 forcedCapacity
    );
    event VerifierProposed(
        uint8 slot,
        address gameVerifier,
        uint16 capacity,
        uint16 forcedCapacity,
        uint64 eta
    );

    // ----------------------------- Errors ------------------------------

    error WrongRound();
    error OutOfGas();
    error NotCommitPhase();
    error NotAnchorPhase();
    error NotRevealPhase();
    error NotClaimPhase();
    error ClaimWindowOpen();
    error WitnessTooLarge();
    error AlreadyAnchored();
    error NotRevealAnchorPhase();
    // An anchored list's hash must be zero exactly when its count is zero (commit or reveal list).
    error RevealsHashMismatch();
    error NotAnchored();
    error AlreadySettled();
    error RoundOutOfOrder();
    error RoundPending(uint64 round);
    error NoPendingVerifier();
    error VerifierDelayNotOver();
    error SeedNotAvailable();
    error TooManyForced();
    error NotStaked();
    error AlreadyForced();
    error NotOwnOverlay();
    error InputMismatch(uint8 which);
    error OutputMismatch();
    error ValidForcedClaim();
    error ProofInvalid();
    error NotAdmin();
    error FeeTooHigh();

    // ----------------------------- Constructor ------------------------------

    constructor(
        address staking,
        address postageContract,
        address oracleContract,
        address gameKeys,
        address claimVerifier,
        address _gameVerifier,
        uint16 _capacity,
        uint16 _forcedCapacity,
        uint64 _verifierDelay
    ) {
        IGameKeys gk = IGameKeys(gameKeys);
        GameKeys = gk;
        Claims = ClaimVerifier(claimVerifier);
        _setGameCircuit(0, _gameVerifier, _capacity, _forcedCapacity);

        uint256 z;
        for (uint256 i = 0; i < 8; ++i) z = gk.compress(z, z);
        EMPTY_LIST_ROOT = bytes32(z);


        verifierDelay = _verifierDelay;
        Stakes = ISettlementStakes(staking);
        PostageContract = ISettlementPostage(postageContract);
        OracleContract = ISettlementOracle(oracleContract);
        _setupRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _setupRole(ANCHOR_ROLE, msg.sender);
    }

    ////////////////////////////////////////
    //           STATE CHANGING           //
    ////////////////////////////////////////

    /**
     * @notice Fix the set of off-chain commits for the current round, before any reveal and before the seed
     * exists. Called once per round by a prover during the anchor phase.
     * @param _round The current round.
     * @param _commitsHash Merkle root of the signed commits, sorted by owner: leaves keccak256(owner,
     * obfuscatedHash), padded with zero to a power of two, nodes keccak256(left, right). A node checks its own
     * commit with a Merkle proof against this root and `_commitCount` (prover/crates/vm, `list_verify`).
     * @param _commitCount Number of commits in that list.
     * @param _dataRef Swarm reference of the round document with the full commit list (or its keccak256 if
     * the prover does not upload). Only emitted.
     */
    function anchorRound(
        uint64 _round,
        bytes32 _commitsHash,
        uint32 _commitCount,
        bytes32 _dataRef
    ) external whenNotPaused {
        if (!hasRole(ANCHOR_ROLE, msg.sender)) revert NotAdmin();
        if (_round != currentRound()) revert WrongRound();
        uint256 offset = block.number % ROUND_LENGTH;
        if (offset < COMMIT_END || offset >= ANCHOR_END) revert NotAnchorPhase();

        if ((_commitCount == 0) != (_commitsHash == bytes32(0))) revert RevealsHashMismatch();
        RoundSlot storage ri = _entry(_round);
        if (ri.anchored) revert AlreadyAnchored();

        if (_commitCount > type(uint16).max) revert TooManyForced();
        ri.anchored = true;
        ri.commitCount = uint16(_commitCount);
        ri.prevAnchored = lastAnchoredRound;
        lastAnchoredRound = _round;
        // The pot at the seed block of the round before: each round gets its own cut.
        PostageContract.checkpoint();
        // An empty list leaves the hash slot as it is (it does not count with a zero count).
        if (_commitCount != 0) ri.commitsHash = _commitsHash;

        emit RoundAnchored(_round, anchorBlockHash(_round), _commitsHash, _commitCount, _dataRef);
    }

    /**
     * @notice Liveness fallback: if no prover anchored the round in blocks 16-19, anybody can anchor it with
     * an empty commit list in blocks 20-23. The nodes then use forceCommit and forceReveal (still open), and
     * any prover can settle the round from data that is all on chain. Without this, a prover that stops
     * makes every round unsettleable, and the forced entries count for nothing.
     */
    function anchorEmpty(uint64 _round) external whenNotPaused {
        if (_round != currentRound()) revert WrongRound();
        uint256 offset = block.number % ROUND_LENGTH;
        if (offset < ANCHOR_END || offset >= REVEAL_START) revert NotAnchorPhase();

        RoundSlot storage ri = _entry(_round);
        if (ri.anchored) revert AlreadyAnchored();
        ri.anchored = true;
        ri.prevAnchored = lastAnchoredRound;
        lastAnchoredRound = _round;
        // The pot at the seed block of the round before: each round gets its own cut.
        PostageContract.checkpoint();

        emit RoundAnchored(_round, anchorBlockHash(_round), bytes32(0), 0, bytes32(0));
    }

    /**
     * @notice Fix the set of off-chain reveals for the current round, so a node can check that its reveal is
     * in it and call forceReveal before the reveal phase ends if not. Called once per round, after
     * anchorRound, by a prover. A round settles without it; then only forced reveals count.
     * @param _revealsHash Merkle root of the reveals in the published order (leaves keccak256(overlay, depth,
     * hash, nonce), built as for `_commitsHash`). bytes32(0) for an empty list, and only for an empty list.
     * @param _revealCount Number of reveals in that list.
     * @param _dataRef Swarm reference of the round document with the full reveal list (or its keccak256).
     * Only emitted.
     */
    function anchorReveals(
        uint64 _round,
        bytes32 _revealsHash,
        uint32 _revealCount,
        bytes32 _dataRef
    ) external whenNotPaused {
        if (!hasRole(ANCHOR_ROLE, msg.sender)) revert NotAdmin();
        if (_round != currentRound()) revert WrongRound();
        uint256 offset = block.number % ROUND_LENGTH;
        if (offset < REVEAL_ANCHOR_START || offset >= REVEAL_ANCHOR_END) revert NotRevealAnchorPhase();

        RoundSlot storage ri = _entry(_round);
        if (!ri.anchored) revert NotAnchored();
        if (ri.revealsAnchored) revert AlreadyAnchored();
        if ((_revealCount == 0) != (_revealsHash == bytes32(0))) revert RevealsHashMismatch();

        if (_revealCount > type(uint16).max) revert TooManyForced();
        ri.revealsAnchored = true;
        ri.revealCount = uint16(_revealCount);
        // An empty list leaves the hash slot as it is (it does not count with a zero count).
        if (_revealCount != 0) ri.revealsHash = _revealsHash;

        emit RevealsAnchored(_round, _revealsHash, _revealCount, _dataRef);
    }

    /**
     * @notice Censorship escape hatch: commit on chain. The proof for this round must include it.
     * Open until the reveal phase, so a node has 4 blocks after the anchor phase to react to the list.
     */
    function forceCommit(uint64 _round, bytes32 _obfuscatedHash) external whenNotPaused {
        if (_round != currentRound()) revert WrongRound();
        if (block.number % ROUND_LENGTH >= REVEAL_START) revert NotCommitPhase();
        _stakedOverlay(msg.sender);
        ForcedRounds storage f = forcedBy[msg.sender];
        if (f.commit == _round + 1) revert AlreadyForced();
        f.commit = _round + 1;

        RoundSlot storage ri = _entry(_round);
        if (ri.forcedCommitCount >= MAX_FORCED_PER_ROUND) revert TooManyForced();

        bytes32 prev = ri.forcedCommitCount == 0 ? bytes32(0) : ri.forcedCommitsHash;
        // A MiMC chain, which the circuit computes with few constraints. About 16k gas more than keccak256.
        if (uint256(_obfuscatedHash) >= FIELD) revert InputMismatch(4);
        ri.forcedCommitsHash = bytes32(
            GameKeys.compress(uint256(prev), GameKeys.compress(uint256(uint160(msg.sender)), uint256(_obfuscatedHash)))
        );
        ri.forcedCommitCount++;

        emit CommitForced(_round, msg.sender, _obfuscatedHash);
    }

    /**
     * @notice Censorship escape hatch: reveal on chain. The proof for this round must consider it.
     * Only the staked owner of `_overlay` can submit it, once per round. Open until the
     * seed block, so a node has 4 blocks after the reveal anchor phase to react to the list.
     */
    function forceReveal(
        uint64 _round,
        bytes32 _overlay,
        uint8 _depth,
        bytes32 _hash,
        bytes32 _nonce
    ) external whenNotPaused {
        if (_round != currentRound()) revert WrongRound();
        uint256 offset = block.number % ROUND_LENGTH;
        if (offset < REVEAL_START || offset >= REVEAL_END) revert NotRevealPhase();
        if (_stakedOverlay(msg.sender) != _overlay) revert NotOwnOverlay();
        ForcedRounds storage f = forcedBy[msg.sender];
        if (f.reveal == _round + 1) revert AlreadyForced();
        f.reveal = _round + 1;

        RoundSlot storage ri = _entry(_round);
        if (ri.forcedRevealCount >= MAX_FORCED_PER_ROUND) revert TooManyForced();

        bytes32 prev = ri.forcedRevealCount == 0 ? bytes32(0) : ri.forcedRevealsHash;
        ri.forcedRevealsHash = bytes32(
            GameKeys.compress(uint256(prev), uint256(GameKeys.wrapCommit(_overlay, _depth, _hash, _nonce)))
        );
        ri.forcedRevealCount++;

        emit RevealForced(_round, _overlay, _depth, _hash, _nonce);
    }

    /**
     * @notice Censorship escape hatch for the storage evidence: post the claim witness on chain. The proof
     * for this round must consider it. Anyone holding the truth's sample can submit it; the payout always
     * goes to the selected winner.
     * @param _witness abi.encode(ClaimWitness{proof1, proof2, proofLast}): the three arguments of
     * Redistribution.claim as one value.
     */
    function forceClaim(uint64 _round, bytes calldata _witness) external whenNotPaused {
        if (_round != currentRound()) revert WrongRound();
        if (block.number % ROUND_LENGTH < CLAIM_START) revert NotClaimPhase();
        if (_witness.length > MAX_CLAIM_WITNESS_SIZE) revert WitnessTooLarge();
        _stakedOverlay(msg.sender);
        ForcedRounds storage f = forcedBy[msg.sender];
        if (f.claim == _round + 1) revert AlreadyForced();
        f.claim = _round + 1;

        RoundSlot storage ri = _entry(_round);
        if (ri.forcedClaimCount >= MAX_FORCED_CLAIMS_PER_ROUND) revert TooManyForced();

        bytes32 prev = ri.forcedClaimCount == 0 ? bytes32(0) : ri.forcedClaimsHash;
        ri.forcedClaimsHash = keccak256(abi.encodePacked(prev, keccak256(_witness)));
        ri.forcedClaimCount++;

        emit ClaimForced(_round, msg.sender, _witness);
    }

    /**
     * @notice Settle a round with a Groth16 proof of the settlement circuit. Permissionless: the proof is
     * the authorisation. Pays `out.feeRecipient` the prover fee.
     *
     * The proof covers the game (commits, reveals, truth, winner, freezes). PostageStampZK computes the pot.
     * This contract checks the rest on chain: the two block headers that give the randomness, and the
     * claim witness (chunk inclusion proofs, postage stamps, single-owner chunk signatures).
     * @param out The outcome that the proof commits to.
     * @param ev The proof and what this contract checks itself.
     */
    function settleRound(Outcome calldata out, Evidence calldata ev) external whenNotPaused {
        RoundSlot storage ri = ring[out.round % RING_SIZE];

        // A round whose entry another round took is too old to settle anyway (its seed is gone).
        if (ri.round != out.round || !ri.anchored) revert NotAnchored();
        if (ri.settled) revert AlreadySettled();
        if (out.round <= lastSettledRound) revert RoundOutOfOrder();
        _checkNoPendingRound(out.round);

        (bytes32 roundAnchor, bytes32 seed) = _verifyProof(out, ri, ev);

        if (!_claimed(out, ri, roundAnchor, seed, ev.claimWitness, ev.forcedClaims)) {
            emit RoundSettled(out.round, false, bytes32(0), 0, address(0), 0, 0, out.feeRecipient, 0);
            return;
        }
        _apply(out);
    }

    /**
     * @dev The claim: the storage evidence for the truth's sample. Like a reverted claim, a round without
     * a valid witness changes nothing. The payout goes to the proven winner, so any node that holds the
     * truth's sample can supply the witness. Same as Redistribution: a round without valid reveals
     * changes nothing.
     */
    function _claimed(
        Outcome calldata out,
        RoundSlot storage ri,
        bytes32 roundAnchor,
        bytes32 seed,
        bytes calldata _claimWitness,
        bytes[] calldata _forcedClaims
    ) internal returns (bool) {
        if (!out.hasReveals) return false;
        ClaimVerifier.Context memory ctx = ClaimVerifier.Context({
            anchor: roundAnchor,
            seed: seed,
            truthHash: out.truthHash,
            depth: out.truthDepth,
            sampleMaxValue: sampleMaxValue,
            postage: IClaimPostage(address(PostageContract))
        });
        if (_claimOk(_claimWitness, ctx)) return true;

        // "Unclaimed": the claim window must be closed, and every forced claim must fail too. So a prover
        // cannot settle "unclaimed" while a valid witness is on chain.
        if (block.number < roundStart(out.round) + ROUND_LENGTH) revert ClaimWindowOpen();
        if (_forcedClaims.length != ri.forcedClaimCount) revert InputMismatch(10);
        bytes32 h;
        for (uint256 i = 0; i < _forcedClaims.length; ++i) {
            if (_claimOk(_forcedClaims[i], ctx)) revert ValidForcedClaim();
            h = keccak256(abi.encodePacked(h, keccak256(_forcedClaims[i])));
        }
        if (_forcedClaims.length != 0 && h != ri.forcedClaimsHash) revert InputMismatch(10);
        emit RoundUnclaimed(out.round, out.winner, out.truthHash);
        return false;
    }

    /// @dev A claimed round: freeze, adjust the price, pay the winner and the prover.
    function _apply(Outcome calldata out) internal {
        lastClaimRound = out.round;
        lastWinnerDepth = out.truthDepth;

        uint256 unit = ROUND_LENGTH * (uint256(1) << out.truthDepth);
        for (uint256 i = 0; i < out.owners.length; ) {
            uint8 f = uint8(out.freeze[i]);
            if (f != 0) {
                uint256 time = (f == 1 ? penaltyMultiplierDisagreement : penaltyMultiplierNonRevealed) * unit;
                Stakes.freezeDeposit(out.owners[i], time);
                frozenUntil[out.owners[i]] = block.number + time;
            }
            unchecked {
                ++i;
            }
        }

        // try/catch: adjustPrice reverts when the oracle round was already adjusted, which happens when
        // two game rounds settle inside the same oracle round. That must not block settlement.
        uint256 gasBefore = gasleft();
        try OracleContract.adjustPriceForRound(out.round, out.redundancy) returns (bool ok) {
            if (!ok) emit PriceAdjustmentSkipped(out.redundancy);
        } catch {
            // Out of gas in the oracle leaves at most 1/64 of the gas. Revert then: else a gas estimate can
            // pick a limit at which the price change is lost without a sign.
            if (gasleft() <= gasBefore / 63) revert OutOfGas();
            emit PriceAdjustmentSkipped(out.redundancy);
        }

        (uint256 payout, uint256 fee) = _payout(out.round, out.winner, out.feeRecipient);

        emit RoundSettled(
            out.round,
            true,
            out.truthHash,
            out.truthDepth,
            out.winner,
            out.redundancy,
            payout,
            out.feeRecipient,
            fee
        );
    }

    // ----------------------------- Admin ------------------------------

    /**
     * @notice Propose a new verifier or program. This is the upgrade key of the whole game: a verifier that
     * accepts anything could pay the pot to anybody. So a change takes effect only `verifierDelay` seconds
     * after the proposal (`applyVerifier`), and everybody can see it coming. A new proposal replaces the
     * pending one and starts the delay again.
     */
    function proposeVerifier(
        uint8 _slot,
        address _gameVerifier,
        uint16 _capacity,
        uint16 _forcedCapacity
    ) external {
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert NotAdmin();
        uint64 eta = uint64(block.timestamp) + verifierDelay;
        pendingVerifier = PendingVerifier(_slot, _gameVerifier, _capacity, _forcedCapacity, eta);
        emit VerifierProposed(_slot, _gameVerifier, _capacity, _forcedCapacity, eta);
    }

    /// @notice Make the pending verifier change take effect, once its delay has passed. Anybody can call it.
    function applyVerifier() external {
        PendingVerifier memory p = pendingVerifier;
        if (p.eta == 0) revert NoPendingVerifier();
        if (block.timestamp < p.eta) revert VerifierDelayNotOver();
        delete pendingVerifier;
        _setGameCircuit(p.slot, p.gameVerifier, p.capacity, p.forcedCapacity);
        emit VerifierChanged(p.slot, p.gameVerifier, p.capacity, p.forcedCapacity);
    }

    function cancelVerifier() external {
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert NotAdmin();
        delete pendingVerifier;
        emit VerifierProposed(0, address(0), 0, 0, 0);
    }

    function setStakeAgeRounds(uint8 _rounds) external {
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert NotAdmin();
        stakeAgeRounds = _rounds;
    }

    function setFreezingParams(uint8 _disagreement, uint8 _nonRevealed, uint8 _randomFactor) external {
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert NotAdmin();
        penaltyMultiplierDisagreement = _disagreement;
        penaltyMultiplierNonRevealed = _nonRevealed;
        penaltyRandomFactor = _randomFactor;
    }

    function setSampleMaxValue(uint256 _sampleMaxValue) external {
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert NotAdmin();
        sampleMaxValue = _sampleMaxValue;
    }

    function setProverFee(uint16 _bps) external {
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert NotAdmin();
        if (_bps > 1000) revert FeeTooHigh();
        proverFeeBps = _bps;
    }

    function pause() external {
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert NotAdmin();
        _pause();
    }

    function unPause() external {
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert NotAdmin();
        _unpause();
    }

    ////////////////////////////////////////
    //            STATE READING           //
    ////////////////////////////////////////

    function currentRound() public view returns (uint64) {
        return uint64(block.number / ROUND_LENGTH);
    }

    function roundStart(uint64 _round) public pure returns (uint256) {
        return uint256(_round) * ROUND_LENGTH;
    }

    function seedBlock(uint64 _round) public pure returns (uint256) {
        return roundStart(_round) + SEED_OFFSET;
    }

    /**
     * @notice Hash of block roundStart - 1. The round anchor (neighbourhood selection) is
     * keccak256(abi.encode(prevrandao of that block, round)): prevrandao, not the block hash, because a block
     * builder can grind a block hash but not prevrandao. Nodes read prevrandao (mixHash) from the header.
     */
    function anchorBlockHash(uint64 _round) public view returns (bytes32) {
        bytes32 bh = _blockHash(roundStart(_round) - 1);
        if (bh == bytes32(0)) revert SeedNotAvailable();
        return bh;
    }

    /**
     * @notice Hash of the seed block, available from block seedBlock(round) + 1. The selection seed is
     * keccak256(abi.encode(round anchor, prevrandao of the seed block)).
     */
    function seedBlockHash(uint64 _round) public view returns (bytes32) {
        uint256 sb = seedBlock(_round);
        if (block.number <= sb) revert SeedNotAvailable();
        bytes32 bh = _blockHash(sb);
        if (bh == bytes32(0)) revert SeedNotAvailable();
        return bh;
    }

    /**
     * @notice The round anchor and the selection seed, from the headers of block roundStart - 1 and of
     * the seed block. The contract checks the header hashes and reads `prevrandao` from them.
     */
    function randomness(
        uint64 _round,
        bytes calldata _anchorHeader,
        bytes calldata _seedHeader
    ) public view returns (bytes32 roundAnchor, bytes32 seed) {
        if (keccak256(_anchorHeader) != anchorBlockHash(_round)) revert InputMismatch(1);
        if (keccak256(_seedHeader) != seedBlockHash(_round)) revert InputMismatch(2);
        roundAnchor = keccak256(abi.encode(Claims.mixHash(_anchorHeader), _round));
        seed = keccak256(abi.encode(roundAnchor, Claims.mixHash(_seedHeader)));
    }

    /// @notice The state of a round, or all zero if nothing happened in it (or its ring entry was reused).
    function rounds(uint64 _round) external view returns (RoundInfo memory) {
        return _info(_round, ring[_round % RING_SIZE]);
    }

    /**
     * @notice Fill ring entries once with non-zero values, so that the first round that uses an entry
     * also pays only for writes to used slots. Optional: without it, each entry pays the new-slot cost
     * once, on its first use. Leaves an entry that a round already uses as it is.
     */
    function warmRing(uint64 _from, uint64 _count) external {
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert NotAdmin();
        for (uint64 i = _from; i < _from + _count && i < RING_SIZE; i++) {
            RoundSlot storage e = ring[i];
            if (e.round != 0 || e.anchored || e.forcedCommitCount != 0 || e.forcedRevealCount != 0) continue;
            e.round = WARM;
            bytes32 one = bytes32(uint256(1));
            if (e.commitsHash == 0) e.commitsHash = one;
            if (e.revealsHash == 0) e.revealsHash = one;
            if (e.forcedCommitsHash == 0) e.forcedCommitsHash = one;
            if (e.forcedRevealsHash == 0) e.forcedRevealsHash = one;
            if (e.forcedClaimsHash == 0) e.forcedClaimsHash = one;
        }
    }

    ////////////////////////////////////////
    //              INTERNAL              //
    ////////////////////////////////////////

    /// @dev The overlay of a staked address; reverts for an address without stake.
    function _stakedOverlay(address _owner) internal view returns (bytes32 overlay) {
        uint256 lastUpdated;
        (overlay, , , lastUpdated, ) = Stakes.stakes(_owner);
        if (lastUpdated == 0) revert NotStaked();
    }

    /// @dev The ring entry of `_round`, taken over (counts and flags cleared) if it held another round.
    function _entry(uint64 _round) internal returns (RoundSlot storage e) {
        e = ring[_round % RING_SIZE];
        if (e.round != _round) {
            e.round = _round;
            e.commitCount = 0;
            e.revealCount = 0;
            e.forcedCommitCount = 0;
            e.forcedRevealCount = 0;
            e.forcedClaimCount = 0;
            e.anchored = false;
            e.revealsAnchored = false;
            e.settled = false;
        }
    }

    /// @dev The round's state from its ring entry: stale hashes count as zero.
    function _info(uint64 _round, RoundSlot storage e) internal view returns (RoundInfo memory ri) {
        if (e.round != _round) return ri;
        ri.anchored = e.anchored;
        ri.settled = e.settled;
        ri.commitCount = e.commitCount;
        ri.revealCount = e.revealCount;
        ri.revealsAnchored = e.revealsAnchored;
        ri.forcedCommitCount = e.forcedCommitCount;
        ri.forcedRevealCount = e.forcedRevealCount;
        ri.forcedClaimCount = e.forcedClaimCount;
        if (e.anchored) {
            if (e.commitCount != 0) ri.commitsHash = e.commitsHash;
            ri.anchorBlockHash = _blockHash(roundStart(_round) - 1);
        }
        if (e.revealCount != 0) ri.revealsHash = e.revealsHash;
        if (e.forcedCommitCount != 0) ri.forcedCommitsHash = e.forcedCommitsHash;
        if (e.forcedRevealCount != 0) ri.forcedRevealsHash = e.forcedRevealsHash;
        if (e.forcedClaimCount != 0) ri.forcedClaimsHash = e.forcedClaimsHash;
    }

    /// @dev Check the proofs against the chain, then record the settlement.
    function _verifyProof(
        Outcome calldata out,
        RoundSlot storage ri,
        Evidence calldata ev
    ) internal returns (bytes32 roundAnchor, bytes32 seed) {
        (roundAnchor, seed) = randomness(out.round, ev.anchorHeader, ev.seedHeader);
        _verifyGame(ev.proof, _gameInputs(out, ri, roundAnchor, seed, ev.gameCircuit), ev.gameCircuit);
        ri.settled = true;
        lastSettledRound = out.round;
    }

    /**
     * @dev The public inputs of the game circuit (`GameCircuit`, prover/snark/circuit/game.go): the round,
     * its randomness, its anchors and forced entries, the game state and parameters, the outcome, and for
     * each entry the stake commitment of its owner (GameKeyRegistry) and its freeze code. The entries are
     * the anchored commits, then the forced commits. A commitment includes the owner, the stake record
     * and the game key, as they are before any freeze of this settlement.
     */
    function _gameInputs(
        Outcome calldata out,
        RoundSlot storage s,
        bytes32 roundAnchor,
        bytes32 seed,
        uint8 circuit
    ) internal returns (uint256[] memory input) {
        RoundInfo memory ri = _info(out.round, s);
        GameCircuit memory gc = gameCircuits[circuit];
        if (ri.revealCount > gc.capacity || ri.forcedRevealCount > gc.forcedCapacity) revert InputMismatch(8);

        input = new uint256[](12 + uint256(gc.capacity) + gc.forcedCapacity);
        input[0] = (block.chainid << 160) | uint256(uint160(address(this)));
        input[1] = _packCounts(out.round, ri);
        input[2] = _packParams() | _packOutcome(out);
        input[3] = uint256(seed) & ((1 << 253) - 1);
        input[4] = ((uint256(roundAnchor) >> 192) << 160) | uint256(uint160(out.feeRecipient));
        input[5] = uint256(ri.commitCount == 0 ? EMPTY_LIST_ROOT : ri.commitsHash);
        input[6] = uint256(ri.revealCount == 0 ? EMPTY_LIST_ROOT : ri.revealsHash);
        input[7] = uint256(ri.forcedCommitsHash);
        input[8] = uint256(ri.forcedRevealsHash);
        input[9] = uint256(out.truthHash) >> 128;
        input[10] = uint256(uint128(uint256(out.truthHash)));
        input[11] = _stakeInputs(input, out, ri.commitCount, ri.forcedCommitCount, gc.capacity, gc.forcedCapacity);
    }

    function _packCounts(uint64 _round, RoundInfo memory ri) internal view returns (uint256) {
        return
            (uint256(_round) << 160) |
            (uint256(lastClaimRound) << 96) |
            (uint256(ri.commitCount) << 80) |
            (uint256(ri.revealCount) << 64) |
            (uint256(ri.forcedCommitCount) << 48) |
            (uint256(ri.forcedRevealCount) << 32) |
            OracleContract.currentPrice();
    }

    /// @dev Writes the stake commitment of each entry into `input` and returns the packed freeze codes
    /// (2 bits for each entry from bit 0) and the "frozen by Settlement" flags (1 bit for each entry from
    /// bit 128).
    function _stakeInputs(
        uint256[] memory input,
        Outcome calldata out,
        uint256 nc,
        uint256 nf,
        uint256 cap,
        uint256 fcap
    ) internal returns (uint256 freeze) {
        if (out.owners.length != nc + nf || out.freeze.length != nc + nf || nc > cap || nf > fcap) {
            revert InputMismatch(8);
        }
        for (uint256 k = 0; k < nc + nf; ) {
            uint256 slot = k < nc ? k : cap + (k - nc);
            (uint256 commitment, uint256 lastUpdated) = GameKeys.commitmentOf(out.owners[k]);
            input[12 + slot] = commitment;
            freeze |= uint256(uint8(out.freeze[k])) << (2 * slot);
            // Bit 128 + slot: the stake record was last changed by a freeze of this contract.
            if (lastUpdated != 0 && lastUpdated == frozenUntil[out.owners[k]]) freeze |= uint256(1) << (128 + slot);
            unchecked {
                ++k;
            }
        }
    }

    function _packParams() internal view returns (uint256) {
        return
            (uint256(lastWinnerDepth) << 217) |
            (uint256(penaltyMultiplierDisagreement) << 209) |
            (uint256(penaltyMultiplierNonRevealed) << 201) |
            (uint256(penaltyRandomFactor) << 193) |
            (uint256(stakeAgeRounds) << 185);
    }

    function _packOutcome(Outcome calldata out) internal pure returns (uint256) {
        return
            (uint256(out.hasReveals ? 1 : 0) << 184) |
            (uint256(out.truthDepth) << 176) |
            (uint256(out.redundancy) << 160) |
            uint256(uint160(out.winner));
    }

    /// @dev Call `verifyProof(bytes,uint256[N])` of the game verifier. N depends on the circuit size, so
    /// the call is encoded here: the offset of the proof, the N inputs, the proof.
    function _verifyGame(bytes calldata proof, uint256[] memory input, uint8 circuit) internal view {
        GameCircuit memory gc = gameCircuits[circuit];
        (bool ok, ) = gc.verifier.staticcall(
            abi.encodePacked(
                gc.selector,
                uint256(32 * (input.length + 1)),
                input,
                proof.length,
                proof,
                new bytes((32 - (proof.length % 32)) % 32)
            )
        );
        if (!ok || gc.verifier == address(0)) revert ProofInvalid();
    }

    function _setGameCircuit(uint8 slot, address _verifier, uint16 _capacity, uint16 _forcedCapacity) internal {
        gameCircuits[slot] = GameCircuit(
            _verifier,
            _capacity,
            _forcedCapacity,
            _selector(12 + uint256(_capacity) + _forcedCapacity)
        );
    }

    /// @dev The selector of `verifyProof(bytes,uint256[n])`.
    function _selector(uint256 n) internal pure returns (bytes4) {
        bytes memory digits;
        while (n != 0) {
            digits = abi.encodePacked(uint8(48 + (n % 10)), digits);
            n /= 10;
        }
        return bytes4(keccak256(abi.encodePacked("verifyProof(bytes,uint256[", digits, "])")));
    }

    function _claimOk(bytes calldata witness, ClaimVerifier.Context memory ctx) internal view returns (bool) {
        if (witness.length == 0) return false;
        try Claims.verify(witness, ctx) {
            return true;
        } catch {
            return false;
        }
    }

    /**
     * @dev A round cannot be skipped while it can still settle: settling a later round would make it
     * unsettleable, and a prover could so choose which winners are paid (the pot carries over). An anchored,
     * unsettled earlier round blocks for PENDING_ROUNDS rounds after its end, or until its seed block hash
     * can no longer be read, whichever comes first. In that time any prover with its lists can settle it.
     * Rounds without an anchor are skipped.
     */
    function _checkNoPendingRound(uint64 _round) internal view {
        // Only the anchored round before this one can be pending: the rounds in between are not anchored,
        // and if it can no longer settle, no older round can. One check, whatever the gap (a scan over
        // the gap cost about 8k gas for each round on Sepolia).
        uint64 p = ring[_round % RING_SIZE].prevAnchored;
        if (p <= lastSettledRound) return;
        RoundSlot storage e = ring[p % RING_SIZE];
        if (e.round != p || !e.anchored) return; // entry reused: more than 256 rounds ago
        if (block.number >= (uint256(p) + 1 + PENDING_ROUNDS) * ROUND_LENGTH) return; // waited long enough
        if (_blockHash(seedBlock(p)) == bytes32(0)) return; // its seed is gone: it can never settle
        revert RoundPending(p);
    }

    /// Pays the pot at the round's seed block, minus what earlier rounds were paid: this round's
    /// payments, and those of earlier rounds without a payout.
    function _payout(
        uint64 _round,
        address winner,
        address feeRecipient
    ) internal returns (uint256 payout, uint256 fee) {
        uint256 pot = PostageContract.potAt(_round);
        uint256 amount = pot - potPaid;
        if (amount == 0) return (0, 0);
        potPaid = pot;

        fee = feeRecipient == address(0) ? 0 : (amount * proverFeeBps) / 10000;
        payout = amount - fee;

        // PostageStampZK pays both directly.
        if (fee > 0) PostageContract.withdraw(feeRecipient, fee);
        if (payout > 0) PostageContract.withdraw(winner, payout);
    }

    function _blockHash(uint256 n) internal view returns (bytes32 bh) {
        bh = blockhash(n);
        if (bh != bytes32(0) || n >= block.number || block.number - n > HISTORY_SERVE_WINDOW) return bh;

        (bool ok, bytes memory ret) = HISTORY_STORAGE.staticcall(abi.encode(n));
        if (ok && ret.length == 32) bh = abi.decode(ret, (bytes32));
    }
}
