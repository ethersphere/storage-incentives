// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ISP1Verifier} from "./ISP1Verifier.sol";

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

    function bzzToken() external view returns (address);

    function eventCount() external view returns (uint64);

    function eventHashAt(uint64 index) external view returns (bytes32);

    function eventBlockAt(uint64 index) external view returns (uint64);
}

interface ISettlementOracle {
    function adjustPrice(uint16 redundancy) external returns (bool);

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
    /// Public inputs: re-derived or read on chain and compared in _checkInputs.
    struct PublicInputs {
        uint256 chainId;
        address settlement;
        uint64 round;
        // Hashes of the blocks whose prevrandao gives the round anchor and the selection seed. The proof
        // reads prevrandao from the headers with these hashes (prover/crates/vm/src/randomness.rs).
        bytes32 anchorBlockHash;
        bytes32 seedBlockHash;
        bytes32 commitsHash;
        uint32 commitCount;
        bytes32 revealsHash;
        uint32 revealCount;
        bytes32 forcedCommitsHash;
        bytes32 forcedRevealsHash;
        uint64 lastClaimRound;
        uint8 lastWinnerDepth;
        uint8 penaltyMultiplierDisagreement;
        uint8 penaltyMultiplierNonRevealed;
        uint8 penaltyRandomFactor;
        uint8 stakeAgeRounds;
        address[] participants;
        bytes32 stakeDigest;
        uint32 stakePrice;
        bytes32 forcedClaimsHash;
        uint256 sampleMaxValue;
        PostageInputs postage;
    }

    /// Postage part of the public inputs: the replayed part of PostageStampZK's event log.
    struct PostageInputs {
        bytes32 prevStateHash;
        uint64 prevEventIndex;
        bytes32 prevEventHash;
        uint64 eventIndex;
        bytes32 eventHash;
        uint64 cutBlock;
    }

    /// Postage part of the outcome.
    struct PostageOutcome {
        bytes32 newStateHash;
        uint256 potAmount;
        uint256 validChunkCount;
    }

    /// Outputs: executed in settleRound.
    struct Outcome {
        bool hasTruth;
        bytes32 truthHash;
        uint8 truthDepth;
        address winner;
        bytes32 winnerOverlay;
        uint256 winnerStakeDensity;
        uint16 redundancy;
        address[] freezeOwners;
        uint256[] freezeDurations;
        // A truth was selected but no valid claim witness was given: like a reverted claim, no effects.
        bool unclaimed;
        // Receives the prover fee. Part of the proof, so copying a settleRound transaction (front-running)
        // does not move the fee to the copier. Zero: no fee, the winner gets all.
        address feeRecipient;
        PostageOutcome postage;
    }

    struct PublicValues {
        PublicInputs inputs;
        Outcome outcome;
    }

    /// What `rounds(round)` returns: the round's state, with zero for everything not set yet.
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
        uint32 commitCount;
        uint32 revealCount;
        uint32 forcedCommitCount;
        uint32 forcedRevealCount;
        uint32 forcedClaimCount;
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

    bytes32 public constant ANCHOR_ROLE = keccak256("ANCHOR_ROLE");
    bytes32 public constant COMMIT_TYPEHASH =
        keccak256("SwarmSettlementCommit(uint256 chainId,address settlement,uint64 round,bytes32 obfuscatedHash)");

    ISettlementStakes public immutable Stakes;
    ISettlementPostage public immutable PostageContract;
    ISettlementOracle public immutable OracleContract;

    ISP1Verifier public verifier;
    bytes32 public programVKey;

    RoundSlot[256] internal ring;

    // Game state carried between rounds. Same meaning as currentClaimRound / winner.depth in Redistribution.
    uint64 public lastSettledRound;
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

    // Postage accounting carried between settlements: hash of the proof's postage state, the position in
    // PostageStampZK's event log, and the pot earned but not yet paid out (rounds without a payout keep
    // adding to it, as the pot did on master until the next successful claim).
    bytes32 public postageStateHash;
    uint64 public postageEventIndex;
    bytes32 public postageEventHash;
    uint256 public accruedPot;
    // Chunks of live batches after the last settlement (PostageStamp.validChunkCount). For readers only.
    uint256 public validChunkCount;

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
    event PostageSettled(
        uint64 indexed round,
        uint64 eventIndex,
        uint64 cutBlock,
        uint256 potAmount,
        uint256 accruedPot
    );
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
    event VerifierChanged(address verifier, bytes32 programVKey);

    // ----------------------------- Errors ------------------------------

    error WrongRound();
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
    error SeedNotAvailable();
    error TooManyForced();
    error NotStaked();
    error AlreadyForced();
    error NotOwnOverlay();
    error InputMismatch(uint8 which);
    error OutputMismatch();
    error NotAdmin();
    error FeeTooHigh();
    error TransferFailed();

    // ----------------------------- Constructor ------------------------------

    constructor(
        address staking,
        address postageContract,
        address oracleContract,
        address _verifier,
        bytes32 _programVKey
    ) {
        Stakes = ISettlementStakes(staking);
        PostageContract = ISettlementPostage(postageContract);
        OracleContract = ISettlementOracle(oracleContract);
        verifier = ISP1Verifier(_verifier);
        programVKey = _programVKey;
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

        ri.anchored = true;
        ri.commitCount = _commitCount;
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

        ri.revealsAnchored = true;
        ri.revealCount = _revealCount;
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
        ri.forcedCommitsHash = keccak256(abi.encodePacked(prev, msg.sender, _obfuscatedHash));
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
        ri.forcedRevealsHash = keccak256(abi.encodePacked(prev, _overlay, _depth, _hash, _nonce));
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
     * @notice Settle a round with a proof of the Redistribution VM. Permissionless: the proof is the
     * authorisation. Pays the submitter `proverFeeBps` of the pot.
     * @param _publicValues ABI-encoded PublicValues committed by the SP1 program.
     * @param _proofBytes SP1 Groth16 proof (empty with the mock verifier).
     */
    function settleRound(bytes calldata _publicValues, bytes calldata _proofBytes) external whenNotPaused {
        PublicValues memory pv = abi.decode(_publicValues, (PublicValues));
        PublicInputs memory pin = pv.inputs;
        Outcome memory out = pv.outcome;
        RoundSlot storage ri = ring[pin.round % RING_SIZE];

        // A round whose entry another round took is too old to settle anyway (its seed is gone).
        if (ri.round != pin.round || !ri.anchored) revert NotAnchored();
        if (ri.settled) revert AlreadySettled();
        if (pin.round <= lastSettledRound) revert RoundOutOfOrder();
        _checkNoPendingRound(pin.round);

        _checkInputs(pin, ri);

        verifier.verifyProof(programVKey, _publicValues, _proofBytes);

        ri.settled = true;
        lastSettledRound = pin.round;

        // Postage accounting applies to every round, with or without a payout.
        postageStateHash = out.postage.newStateHash;
        postageEventIndex = pin.postage.eventIndex;
        postageEventHash = pin.postage.eventHash;
        accruedPot += out.postage.potAmount;
        validChunkCount = out.postage.validChunkCount;
        emit PostageSettled(pin.round, pin.postage.eventIndex, pin.postage.cutBlock, out.postage.potAmount, accruedPot);

        if (out.unclaimed) {
            // The claim window must be closed, so nobody can settle "unclaimed" before the winner's
            // witness (off chain or forceClaim) had its chance.
            if (block.number < roundStart(pin.round) + ROUND_LENGTH) revert ClaimWindowOpen();
            emit RoundUnclaimed(pin.round, out.winner, out.truthHash);
        }

        if (!out.hasTruth) {
            // Same as Redistribution: a round without valid reveals, or whose claim fails, changes nothing.
            emit RoundSettled(pin.round, false, bytes32(0), 0, address(0), 0, 0, out.feeRecipient, 0);
            return;
        }

        if (out.freezeOwners.length != out.freezeDurations.length) revert OutputMismatch();

        lastClaimRound = pin.round;
        lastWinnerDepth = out.truthDepth;

        for (uint256 i = 0; i < out.freezeOwners.length; ) {
            Stakes.freezeDeposit(out.freezeOwners[i], out.freezeDurations[i]);
            unchecked {
                ++i;
            }
        }

        // try/catch: adjustPrice reverts when the oracle round was already adjusted, which happens when
        // two game rounds settle inside the same oracle round. That must not block settlement.
        try OracleContract.adjustPrice(out.redundancy) returns (bool ok) {
            if (!ok) emit PriceAdjustmentSkipped(out.redundancy);
        } catch {
            emit PriceAdjustmentSkipped(out.redundancy);
        }

        (uint256 payout, uint256 fee) = _payout(out.winner, out.feeRecipient);

        emit RoundSettled(
            pin.round,
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

    /// @notice Replace the verifier or program. This is the upgrade key of the whole game; on mainnet it
    /// must sit behind a timelock (see docs/ZK-SETTLEMENT.md, open items).
    function setVerifier(address _verifier, bytes32 _programVKey) external {
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert NotAdmin();
        verifier = ISP1Verifier(_verifier);
        programVKey = _programVKey;
        emit VerifierChanged(_verifier, _programVKey);
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
     * @notice The digest a node signs (EIP-191 personal_sign) for an off-chain commit. Binds the commit to
     * this chain, this contract and this round, so it cannot be replayed elsewhere.
     */
    function commitDigest(uint64 _round, bytes32 _obfuscatedHash) public view returns (bytes32) {
        return keccak256(abi.encode(COMMIT_TYPEHASH, block.chainid, address(this), _round, _obfuscatedHash));
    }

    /// @notice Same as Redistribution.wrapCommit: the obfuscated commit hash.
    function wrapCommit(
        bytes32 _overlay,
        uint8 _depth,
        bytes32 _hash,
        bytes32 _revealNonce
    ) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(_overlay, _depth, _hash, _revealNonce));
    }

    /**
     * @notice Same rule the VM uses to bind stake records into the proof. Uses the raw StakeRegistry
     * record, not nodeEffectiveStake: that one depends on block.number (it is 0 while frozen), so a value
     * read by the prover one block earlier could differ. The VM derives effective stake from these fields
     * and the oracle price (stakePrice), exactly as StakeRegistry.calculateEffectiveStake does.
     */
    function stakeDigest(address[] memory _participants) public view returns (bytes32 digest) {
        for (uint256 i = 0; i < _participants.length; ) {
            address owner = _participants[i];
            (bytes32 overlay, uint256 committed, uint256 potential, uint256 lastUpdated, uint8 height) = Stakes.stakes(
                owner
            );
            digest = keccak256(abi.encodePacked(digest, owner, overlay, committed, potential, height, lastUpdated));
            unchecked {
                ++i;
            }
        }
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

    function _checkInputs(PublicInputs memory pv, RoundSlot storage s) internal view {
        RoundInfo memory ri = _info(pv.round, s);
        if (pv.chainId != block.chainid || pv.settlement != address(this)) revert InputMismatch(0);
        if (pv.anchorBlockHash != anchorBlockHash(pv.round)) revert InputMismatch(1);
        if (pv.seedBlockHash != seedBlockHash(pv.round)) revert InputMismatch(2);
        if (pv.commitsHash != ri.commitsHash || pv.commitCount != ri.commitCount) revert InputMismatch(3);
        if (pv.forcedCommitsHash != ri.forcedCommitsHash) revert InputMismatch(4);
        if (pv.forcedRevealsHash != ri.forcedRevealsHash) revert InputMismatch(5);
        if (pv.lastClaimRound != lastClaimRound || pv.lastWinnerDepth != lastWinnerDepth) revert InputMismatch(6);
        if (
            pv.penaltyMultiplierDisagreement != penaltyMultiplierDisagreement ||
            pv.penaltyMultiplierNonRevealed != penaltyMultiplierNonRevealed ||
            pv.penaltyRandomFactor != penaltyRandomFactor ||
            pv.stakeAgeRounds != stakeAgeRounds
        ) revert InputMismatch(7);
        // Read before any freeze or price adjustment of this settlement.
        if (pv.stakeDigest != stakeDigest(pv.participants)) revert InputMismatch(8);
        if (pv.stakePrice != OracleContract.currentPrice()) revert InputMismatch(9);
        if (pv.forcedClaimsHash != ri.forcedClaimsHash) revert InputMismatch(10);
        if (pv.sampleMaxValue != sampleMaxValue) revert InputMismatch(12);
        if (pv.revealsHash != ri.revealsHash || pv.revealCount != ri.revealCount) revert InputMismatch(13);
        _checkPostage(pv.postage, pv.round);
    }

    /**
     * @dev The proof replayed PostageStampZK's event log from where the last settlement stopped
     * (prevEventIndex) to eventIndex, and every log entry up to cutBlock is in it.
     */
    /**
     * @dev A round cannot be skipped while it can still settle: settling a later round would make it
     * unsettleable, and a prover could so choose which winners are paid (the pot carries over). An anchored,
     * unsettled earlier round blocks until its seed block hash can no longer be read (EIP-2935: 8191
     * blocks). Rounds without an anchor are skipped.
     */
    function _checkNoPendingRound(uint64 _round) internal view {
        for (uint64 r = _round - 1; r > lastSettledRound && r + RING_SIZE > _round; r--) {
            // The seed of r (and of every older round) can no longer be read: r can never settle.
            if (_blockHash(seedBlock(r)) == bytes32(0)) break;
            RoundSlot storage e = ring[r % RING_SIZE];
            if (e.round == r && e.anchored) revert RoundPending(r);
        }
    }

    function _checkPostage(PostageInputs memory pg, uint64 _round) internal view {
        if (
            pg.prevStateHash != postageStateHash ||
            pg.prevEventIndex != postageEventIndex ||
            pg.prevEventHash != postageEventHash
        ) revert InputMismatch(11);
        // The cut is the round's seed block, so the pot of a round does not depend on when it settles: a late
        // settlement cannot move the pot of later rounds to this round's winner.
        if (pg.cutBlock != seedBlock(_round) || pg.eventIndex < pg.prevEventIndex) revert InputMismatch(11);

        uint64 count = PostageContract.eventCount();
        if (pg.eventIndex > count) revert InputMismatch(11);
        if (pg.eventIndex > pg.prevEventIndex && PostageContract.eventHashAt(pg.eventIndex) != pg.eventHash) {
            revert InputMismatch(11);
        }
        // The next entry, if any, must be after the cut: nothing up to the cut is left out.
        if (pg.eventIndex < count && PostageContract.eventBlockAt(pg.eventIndex + 1) <= pg.cutBlock) {
            revert InputMismatch(11);
        }
    }

    /// Pays out everything accrued since the last payout: the proven pot of this and earlier settlements.
    function _payout(address winner, address feeRecipient) internal returns (uint256 payout, uint256 fee) {
        uint256 amount = accruedPot;
        if (amount == 0) return (0, 0);
        accruedPot = 0;

        PostageContract.withdraw(address(this), amount);

        IERC20 token = IERC20(PostageContract.bzzToken());
        fee = feeRecipient == address(0) ? 0 : (amount * proverFeeBps) / 10000;
        payout = amount - fee;

        if (fee > 0 && !token.transfer(feeRecipient, fee)) revert TransferFailed();
        if (payout > 0 && !token.transfer(winner, payout)) revert TransferFailed();
    }

    function _blockHash(uint256 n) internal view returns (bytes32 bh) {
        bh = blockhash(n);
        if (bh != bytes32(0) || n >= block.number || block.number - n > HISTORY_SERVE_WINDOW) return bh;

        (bool ok, bytes memory ret) = HISTORY_STORAGE.staticcall(abi.encode(n));
        if (ok && ret.length == 32) bh = abi.decode(ret, (bytes32));
    }
}
