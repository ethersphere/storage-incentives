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
    function withdraw(address beneficiary) external;

    function bzzToken() external view returns (address);

    function batches(
        bytes32 _batchId
    )
        external
        view
        returns (
            address owner,
            uint8 depth,
            uint8 bucketDepth,
            bool immutableFlag,
            uint256 normalisedBalance,
            uint256 lastUpdatedBlockNumber
        );
}

interface ISettlementOracle {
    function adjustPrice(uint16 redundancy) external returns (bool);

    function currentPrice() external view returns (uint32);
}

/**
 * @title Settlement
 * @author The Swarm Authors
 * @notice Replaces Redistribution. The Schelling game (commit, reveal, truth and winner selection, freezes,
 * redundancy count for the price oracle) and the claim's storage evidence (chunk inclusion proofs, postage
 * stamps, SOC signatures, reserve size estimate) run off chain in the Redistribution VM (prover/crates/vm).
 * A prover proves the VM run with SP1 and this contract checks the proof and applies the result: pays the
 * winner from the PostageStamp pot, freezes stakes and adjusts the price. See docs/ZK-SETTLEMENT.md.
 *
 * Round layout, in blocks relative to the round start (ROUND_LENGTH = 152, the same as Redistribution):
 *
 *   [  0,  38)  commit       nodes send signed commits to a prover; or call forceCommit
 *   [ 38,  57)  anchor       a prover calls anchorRound(commitsHash) once; forceCommit still open
 *   [ 57, 114)  reveal       nodes send reveals to a prover; or call forceReveal
 *   114         seed block   its block hash becomes the selection seed. Nobody chooses it
 *   [115, 152)  claim        a truth-teller sends the claim witness to a prover; or calls forceClaim
 *   [115, ...)  settle       anyone calls settleRound(publicValues, proof), rounds in increasing order.
 *                            A round whose truth has no valid witness ("unclaimed") settles only from 152
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
        bytes32 roundAnchor;
        bytes32 selectionSeed;
        bytes32 commitsHash;
        uint32 commitCount;
        bytes32 forcedCommitsHash;
        bytes32 forcedRevealsHash;
        uint64 lastClaimRound;
        uint8 lastWinnerDepth;
        uint8 penaltyMultiplierDisagreement;
        uint8 penaltyMultiplierNonRevealed;
        uint8 penaltyRandomFactor;
        address[] participants;
        bytes32 stakeDigest;
        uint32 stakePrice;
        bytes32 forcedClaimsHash;
        bytes32[] batchIds;
        bytes32 batchDigest;
        uint256 sampleMaxValue;
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
    }

    struct PublicValues {
        PublicInputs inputs;
        Outcome outcome;
    }

    struct RoundInfo {
        bytes32 roundAnchor;
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
    }

    // ----------------------------- State variables ------------------------------

    uint256 public constant ROUND_LENGTH = 152;
    uint256 public constant COMMIT_END = 38;
    uint256 public constant ANCHOR_END = 57;
    uint256 public constant REVEAL_END = 114;
    uint256 public constant SEED_OFFSET = 114;
    uint256 public constant CLAIM_START = 115;

    // Upper bound on forced entries per round, so a spammer cannot make a round unprovable.
    uint32 public constant MAX_FORCED_PER_ROUND = 256;
    uint32 public constant MAX_FORCED_CLAIMS_PER_ROUND = 16;
    uint256 public constant MAX_CLAIM_WITNESS_SIZE = 16384;

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

    mapping(uint64 => RoundInfo) public rounds;

    // Game state carried between rounds. Same meaning as currentClaimRound / winner.depth in Redistribution.
    uint64 public lastSettledRound;
    uint64 public lastClaimRound;
    uint8 public lastWinnerDepth;

    // Same defaults as Redistribution.
    uint8 public penaltyMultiplierDisagreement = 1;
    uint8 public penaltyMultiplierNonRevealed = 2;
    uint8 public penaltyRandomFactor = 100;

    // Redistribution's reserve size estimate bound (alpha=0.097612 beta=0.0716570 k=16).
    uint256 public sampleMaxValue = 1284401000000000000000000000000000000000000000000000000000000000000000000;

    // Share of the pot paid to whoever submits a valid settlement, in basis points.
    uint16 public proverFeeBps = 100;

    // ----------------------------- Events ------------------------------

    event RoundAnchored(
        uint64 indexed round,
        bytes32 roundAnchor,
        bytes32 commitsHash,
        uint32 commitCount,
        bytes32 dataRef
    );
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
    event WithdrawFailed(address owner);
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
    error NotAnchored();
    error AlreadySettled();
    error RoundOutOfOrder();
    error SeedNotAvailable();
    error TooManyForced();
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
     * @param _commitsHash keccak256 over (owner, obfuscatedHash) of every signed commit, sorted by owner.
     * @param _commitCount Number of commits in that list.
     * @param _dataRef Where the full commit list is published (a Swarm reference). Only emitted.
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

        RoundInfo storage ri = rounds[_round];
        if (ri.anchored) revert AlreadyAnchored();

        ri.anchored = true;
        ri.roundAnchor = roundAnchor(_round);
        ri.commitsHash = _commitsHash;
        ri.commitCount = _commitCount;

        emit RoundAnchored(_round, ri.roundAnchor, _commitsHash, _commitCount, _dataRef);
    }

    /**
     * @notice Censorship escape hatch: commit on chain. The proof for this round must include it.
     * Open during the commit and anchor phases, so a node can still react once it sees the anchored list.
     */
    function forceCommit(uint64 _round, bytes32 _obfuscatedHash) external whenNotPaused {
        if (_round != currentRound()) revert WrongRound();
        if (block.number % ROUND_LENGTH >= ANCHOR_END) revert NotCommitPhase();

        RoundInfo storage ri = rounds[_round];
        if (ri.forcedCommitCount >= MAX_FORCED_PER_ROUND) revert TooManyForced();

        ri.forcedCommitsHash = keccak256(abi.encodePacked(ri.forcedCommitsHash, msg.sender, _obfuscatedHash));
        ri.forcedCommitCount++;

        emit CommitForced(_round, msg.sender, _obfuscatedHash);
    }

    /**
     * @notice Censorship escape hatch: reveal on chain. The proof for this round must consider it.
     * Anyone holding the preimage can submit it; the preimage itself is the authorisation.
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
        if (offset < ANCHOR_END || offset >= REVEAL_END) revert NotRevealPhase();

        RoundInfo storage ri = rounds[_round];
        if (ri.forcedRevealCount >= MAX_FORCED_PER_ROUND) revert TooManyForced();

        ri.forcedRevealsHash = keccak256(abi.encodePacked(ri.forcedRevealsHash, _overlay, _depth, _hash, _nonce));
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

        RoundInfo storage ri = rounds[_round];
        if (ri.forcedClaimCount >= MAX_FORCED_CLAIMS_PER_ROUND) revert TooManyForced();

        ri.forcedClaimsHash = keccak256(abi.encodePacked(ri.forcedClaimsHash, keccak256(_witness)));
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
        RoundInfo storage ri = rounds[pin.round];

        if (!ri.anchored) revert NotAnchored();
        if (ri.settled) revert AlreadySettled();
        if (pin.round <= lastSettledRound) revert RoundOutOfOrder();

        _checkInputs(pin, ri);

        verifier.verifyProof(programVKey, _publicValues, _proofBytes);

        ri.settled = true;
        lastSettledRound = pin.round;

        if (out.unclaimed) {
            // The claim window must be closed, so nobody can settle "unclaimed" before the winner's
            // witness (off chain or forceClaim) had its chance.
            if (block.number < roundStart(pin.round) + ROUND_LENGTH) revert ClaimWindowOpen();
            emit RoundUnclaimed(pin.round, out.winner, out.truthHash);
        }

        if (!out.hasTruth) {
            // Same as Redistribution: a round without valid reveals, or whose claim fails, changes nothing.
            emit RoundSettled(pin.round, false, bytes32(0), 0, address(0), 0, 0, msg.sender, 0);
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

        (uint256 payout, uint256 fee) = _payout(out.winner);

        emit RoundSettled(
            pin.round,
            true,
            out.truthHash,
            out.truthDepth,
            out.winner,
            out.redundancy,
            payout,
            msg.sender,
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
     * @notice Neighbourhood anchor of a round: keccak256(blockhash(roundStart - 1), round). Known to every
     * node from the first block of the round; nobody in the game chooses it.
     */
    function roundAnchor(uint64 _round) public view returns (bytes32) {
        bytes32 bh = _blockHash(roundStart(_round) - 1);
        if (bh == bytes32(0)) revert SeedNotAvailable();
        return keccak256(abi.encode(bh, _round));
    }

    /// @notice Selection seed of a round, available from block seedBlock(round) + 1.
    function selectionSeed(uint64 _round) public view returns (bytes32) {
        uint256 sb = seedBlock(_round);
        if (block.number <= sb) revert SeedNotAvailable();
        bytes32 bh = _blockHash(sb);
        if (bh == bytes32(0)) revert SeedNotAvailable();
        return keccak256(abi.encode(rounds[_round].roundAnchor, bh));
    }

    /**
     * @notice Same rule the VM uses to bind the postage batches of the claim witnesses into the proof.
     * Mirrors the batch lookup of Redistribution.stampFunction, read at settlement time.
     */
    function batchDigest(bytes32[] memory _batchIds) public view returns (bytes32 digest) {
        for (uint256 i = 0; i < _batchIds.length; ) {
            (address owner, uint8 depth, uint8 bucketDepth, , , ) = PostageContract.batches(_batchIds[i]);
            digest = keccak256(abi.encodePacked(digest, _batchIds[i], owner, depth, bucketDepth));
            unchecked {
                ++i;
            }
        }
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

    ////////////////////////////////////////
    //              INTERNAL              //
    ////////////////////////////////////////

    function _checkInputs(PublicInputs memory pv, RoundInfo storage ri) internal view {
        if (pv.chainId != block.chainid || pv.settlement != address(this)) revert InputMismatch(0);
        if (pv.roundAnchor != ri.roundAnchor) revert InputMismatch(1);
        if (pv.selectionSeed != selectionSeed(pv.round)) revert InputMismatch(2);
        if (pv.commitsHash != ri.commitsHash || pv.commitCount != ri.commitCount) revert InputMismatch(3);
        if (pv.forcedCommitsHash != ri.forcedCommitsHash) revert InputMismatch(4);
        if (pv.forcedRevealsHash != ri.forcedRevealsHash) revert InputMismatch(5);
        if (pv.lastClaimRound != lastClaimRound || pv.lastWinnerDepth != lastWinnerDepth) revert InputMismatch(6);
        if (
            pv.penaltyMultiplierDisagreement != penaltyMultiplierDisagreement ||
            pv.penaltyMultiplierNonRevealed != penaltyMultiplierNonRevealed ||
            pv.penaltyRandomFactor != penaltyRandomFactor
        ) revert InputMismatch(7);
        // Read before any freeze or price adjustment of this settlement.
        if (pv.stakeDigest != stakeDigest(pv.participants)) revert InputMismatch(8);
        if (pv.stakePrice != OracleContract.currentPrice()) revert InputMismatch(9);
        if (pv.forcedClaimsHash != ri.forcedClaimsHash) revert InputMismatch(10);
        if (pv.batchDigest != batchDigest(pv.batchIds)) revert InputMismatch(11);
        if (pv.sampleMaxValue != sampleMaxValue) revert InputMismatch(12);
    }

    function _payout(address winner) internal returns (uint256 payout, uint256 fee) {
        IERC20 token = IERC20(PostageContract.bzzToken());
        uint256 before = token.balanceOf(address(this));

        (bool success, ) = address(PostageContract).call(abi.encodeWithSignature("withdraw(address)", address(this)));
        if (!success) {
            emit WithdrawFailed(winner);
            return (0, 0);
        }

        uint256 amount = token.balanceOf(address(this)) - before;
        fee = (amount * proverFeeBps) / 10000;
        payout = amount - fee;

        if (fee > 0 && !token.transfer(msg.sender, fee)) revert TransferFailed();
        if (payout > 0 && !token.transfer(winner, payout)) revert TransferFailed();
    }

    function _blockHash(uint256 n) internal view returns (bytes32 bh) {
        bh = blockhash(n);
        if (bh != bytes32(0) || n >= block.number || block.number - n > HISTORY_SERVE_WINDOW) return bh;

        (bool ok, bytes memory ret) = HISTORY_STORAGE.staticcall(abi.encode(n));
        if (ok && ret.length == 32) bh = abi.decode(ret, (bytes32));
    }
}
