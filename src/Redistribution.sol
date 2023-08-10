// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.19;
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "./Util/TransformedChunkProof.sol";
import "./Util/ChunkProof.sol";
import "./Util/Signatures.sol";

/**
 * Implement interfaces to PostageStamp contract, PriceOracle contract and Staking contract.
 * For PostageStmap we currently use "withdraw" to withdraw funds from Pot and some read functions
 * For PriceOracle we use "adjustPrice" to change price of PostageStamps
 * For Staking contract we use freezeDeposit to change state and others are read functions
 */

interface IPostageStamp {
    function withdraw(address beneficiary) external;

    function validChunkCount() external view returns (uint256);

    function batchOwner(bytes32 _batchId) external view returns (address);

    function batchDepth(bytes32 _batchId) external view returns (uint8);

    function batchBucketDepth(bytes32 _batchId) external view returns (uint8);

    function remainingBalance(bytes32 _batchId) external view returns (uint256);

    function minimumInitialBalancePerChunk() external view returns (uint256);
}

interface IPriceOracle {
    function adjustPrice(uint256 redundancy) external;
}

interface IStakeRegistry {
    function freezeDeposit(bytes32 overlay, uint256 time) external;

    function lastUpdatedBlockNumberOfOverlay(bytes32 overlay) external view returns (uint256);

    function ownerOfOverlay(bytes32 overlay) external view returns (address);

    function stakeOfOverlay(bytes32 overlay) external view returns (uint256);
}

/**
 * @title Redistribution contract
 * @author The Swarm Authors
 * @dev Implements a Schelling Co-ordination game to form consensus around the Reserve Commitment hash. This takes
 * place in three phases: _commit_, _reveal_ and _claim_.
 *
 * A node, upon establishing that it _isParticipatingInUpcomingRound_, i.e. it's overlay falls within proximity order
 * of its reported depth with the _currentRoundAnchor_, prepares a "reserve commitment hash" using the chunks
 * it currently stores in its reserve and calculates the "storage depth" (see Bee for details). These values, if calculated
 * honestly, and with the right chunks stored, should be the same for every node in a neighbourhood. This is the Schelling point.
 * Each eligible node can then use these values, together with a random, single use, secret  _revealNonce_ and their
 * _overlay_ as the pre-image values for the obsfucated _commit_, using the _wrapCommit_ method.
 *
 * Once the _commit_ round has elapsed, participating nodes must provide the values used to calculate their obsfucated
 * _commit_ hash, which, once verified for correctness and proximity to the anchor are retained in the _currentReveals_.
 * Nodes that have commited but do not reveal the correct values used to create the pre-image will have their stake
 * "frozen" for a period of rounds proportional to their reported depth.
 *
 * During the _reveal_ round, randomness is updated after every successful reveal. Once the reveal round is concluded,
 * the _currentRoundAnchor_ is updated and users can determine if they will be eligible their overlay will be eligible
 * for the next commit phase using _isParticipatingInUpcomingRound_.
 *
 * When the _reveal_ phase has been concluded, the claim phase can begin. At this point, the truth teller and winner
 * are already determined. By calling _isWinner_, an applicant node can run the relevant logic to determine if they have
 * been selected as the beneficiary of this round. When calling _claim_, the current pot from the PostageStamp contract
 * is withdrawn and transferred to that beneficiaries address. Nodes that have revealed values that differ from the truth,
 * have their stakes "frozen" for a period of rounds proportional to their reported depth.
 */

contract Redistribution is AccessControl, Pausable {
    // ----------------------------- Type declarations ------------------------------

    // An eligible user may commit to an _obfuscatedHash_ during the commit phase...
    struct Commit {
        bytes32 overlay;
        address owner;
        bool revealed;
        uint256 stake;
        bytes32 obfuscatedHash;
        uint256 revealIndex;
    }
    // ...then provide the actual values that are the constituents of the pre-image of the _obfuscatedHash_
    // during the reveal phase.
    struct Reveal {
        address owner;
        uint8 depth;
        bytes32 overlay;
        uint256 stake;
        uint256 stakeDensity;
        bytes32 hash;
    }

    struct ChunkInclusionProof {
        bytes32[] proofSegments;
        bytes32 proveSegment;
        // _RCspan is known for RC 32*32

        // Inclusion proof of transformed address
        bytes32[] proofSegments2;
        bytes32 proveSegment2;
        // proveSegmentIndex2 known from deterministic random selection;

        bytes32[] proofSegments3;
        //  _proveSegment3 known, is equal _proveSegment2
        // proveSegmentIndex3 know, is equal _proveSegmentIndex2;
        // chunkSpan2 is equal to chunkSpan (as the data is the same)

        // address signer; it is provided by the postage stamp contract
        bytes signature;
        bytes32 chunkAddr;
        bytes32 postageId;
        uint64 chunkSpan;
        uint64 index;
        uint64 timeStamp;
        SOCProof[] socProofAttached;
    }

    struct SOCProof {
        address signer; // signer Ethereum address to check against
        bytes signature;
        bytes32 identifier; //
        bytes32 chunkAddr; // wrapped chunk address
    }

    // ----------------------------- State variables ------------------------------

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
    uint32 public currentCommitRound;
    uint32 public currentRevealRound;
    uint32 public currentClaimRound;

    // Settings for slashing and freezing
    uint8 private penaltyMultiplierDisagreement = 1;
    uint8 private penaltyMultiplierNonRevealed = 2;

    // The reveal of the winner of the last round.
    Reveal public winner;

    // The length of a round in blocks.
    uint256 private constant ROUND_LENGTH = 152;

    // The miniumum stake allowed to be staked using the Staking contract.
    uint64 private constant MIN_STAKE = 100000000000000000;

    // alpha=0.097612 beta=0.0716570 k=16
    uint256 private constant SAMPLE_MAX_VALUE =
        1284401000000000000000000000000000000000000000000000000000000000000000000;

    // Maximum value of the keccack256 hash.
    bytes32 private constant MAX_H = 0x00000000000000000000000000000000ffffffffffffffffffffffffffffffff;

    // Role allowed to pause.
    bytes32 private immutable PAUSER_ROLE;

    // ----------------------------- Events ------------------------------

    /**
     * @dev Emitted when the winner of a round is selected in the claim phase
     */
    event WinnerSelected(Reveal winner);

    /**
     * @dev Emitted when the truth oracle of a round is selected in the claim phase.
     */
    event TruthSelected(bytes32 hash, uint8 depth);

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
    event Committed(uint256 roundNumber, bytes32 overlay);
    /**
     * @dev Emit from Postagestamp contract valid chunk count at the end of claim
     */
    event ChunkCount(uint256 validChunkCount);

    /**
     * @dev Bytes32 anhor of current reveal round
     */
    event CurrentRevealAnchor(uint256 roundNumber, bytes32 anchor);

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

    // ----------------------------- Errors ------------------------------

    error NotCommitPhase(); // Game is not in commit phase
    error NoCommitsReceived(); // Round did receive any commits
    error PhaseLastBlock(); // We don't permit commits in last block oh phase
    error BelowMinimumStake(); // Node participating in game has stake below minimum treshold
    error CommitRoundOver(); // Commit phase in this round is over
    error CommitRoundNotStarted(); // Commit phase in this round has not started yet
    error NotMatchingOwner(); // Sender of commit is not matching the overlay address
    error MustStake2Rounds(); // Before entering the game node must stake 2 rounds prior
    error WrongPhase(); // Checking in wrong phase, need to check duing claim phase of current round for next round or commit in current round
    error AlreadyCommited(); // Node already commited in this round

    // ----------------------------- CONSTRUCTOR ------------------------------

    /**
     * @param staking the address of the linked Staking contract.
     * @param postageContract the address of the linked PostageStamp contract.
     * @param oracleContract the address of the linked PriceOracle contract.
     */
    constructor(address staking, address postageContract, address oracleContract, address multisig) {
        Stakes = IStakeRegistry(staking);
        PostageContract = IPostageStamp(postageContract);
        OracleContract = IPriceOracle(oracleContract);
        PAUSER_ROLE = keccak256("PAUSER_ROLE");
        _setupRole(DEFAULT_ADMIN_ROLE, multisig);
        _setupRole(PAUSER_ROLE, msg.sender);
    }

    ////////////////////////////////////////
    //              SETTERS               //
    ////////////////////////////////////////

    /**
     * @notice Begin application for a round if eligible. Commit a hashed value for which the pre-image will be
     * subsequently revealed.
     * @dev If a node's overlay is _inProximity_(_depth_) of the _currentRoundAnchor_, that node may compute an
     * _obfuscatedHash_ by providing their _overlay_, reported storage _depth_, reserve commitment _hash_ and a
     * randomly generated, and secret _revealNonce_ to the _wrapCommit_ method.
     * @param _obfuscatedHash The calculated hash resultant of the required pre-image values.
     * @param _overlay The overlay referenced in the pre-image. Must be staked by at least the minimum value,
     * and be derived from the same key pair as the message sender.
     */
    function commit(bytes32 _obfuscatedHash, bytes32 _overlay, uint32 _roundNumber) external whenNotPaused {
        uint32 cr = uint32(currentRound());
        uint256 nstake = Stakes.stakeOfOverlay(_overlay);

        if (!currentPhaseCommit()) {
            revert NotCommitPhase();
        }
        if (block.number % ROUND_LENGTH == (ROUND_LENGTH / 4) - 1) {
            revert PhaseLastBlock();
        }

        if (cr > _roundNumber) {
            revert CommitRoundOver();
        }

        if (cr < _roundNumber) {
            revert CommitRoundNotStarted();
        }

        if (nstake < MIN_STAKE) {
            revert BelowMinimumStake();
        }

        if (Stakes.ownerOfOverlay(_overlay) != msg.sender) {
            revert NotMatchingOwner();
        }

        if (Stakes.lastUpdatedBlockNumberOfOverlay(_overlay) >= block.number - 2 * ROUND_LENGTH) {
            revert MustStake2Rounds();
        }

        // if we are in a new commit phase, reset the array of commits and
        // set the currentCommitRound to be the current one
        if (cr != currentCommitRound) {
            delete currentCommits;
            currentCommitRound = cr;
        }

        uint256 commitsArrayLength = currentCommits.length;

        for (uint256 i = 0; i < commitsArrayLength; ) {
            if (currentCommits[i].overlay == _overlay) {
                revert AlreadyCommited();
            }

            unchecked {
                ++i;
            }
        }

        currentCommits.push(
            Commit({
                owner: msg.sender,
                overlay: _overlay,
                revealed: false,
                stake: nstake,
                obfuscatedHash: _obfuscatedHash,
                revealIndex: 0
            })
        );

        emit Committed(_roundNumber, _overlay);
    }

    /**
     * @notice Reveal the pre-image values used to generate commit provided during this round's commit phase.
     * @param _overlay The overlay address of the applicant.
     * @param _depth The reported depth.
     * @param _hash The reserve commitment hash.
     * @param _revealNonce The nonce used to generate the commit that is being revealed.
     */
    function reveal(bytes32 _overlay, uint8 _depth, bytes32 _hash, bytes32 _revealNonce) external whenNotPaused {
        require(currentPhaseReveal(), "not in reveal phase");
        uint32 cr = uint32(currentRound());

        if (cr != currentCommitRound) {
            revert NoCommitsReceived();
        }
        if (cr != currentRevealRound) {
            currentRevealRoundAnchor = currentRoundAnchor();
            delete currentReveals;
            currentRevealRound = cr;
            emit CurrentRevealAnchor(cr, currentRevealRoundAnchor);
            updateRandomness();
        }

        bytes32 commitHash = wrapCommit(_overlay, _depth, _hash, _revealNonce);
        uint256 id = findCommit(_overlay, commitHash, currentCommits.length);
        Commit memory currentCommit = currentCommits[id];

        // Check that commit is in proximity of the current anchor
        require(
            inProximity(currentCommit.overlay, currentRevealRoundAnchor, _depth),
            "anchor out of self reported depth"
        );
        // Check that the commit has not already been revealed
        require(currentCommit.revealed == false, "participant already revealed");
        currentCommits[id].revealed = true;
        currentCommits[id].revealIndex = currentReveals.length;

        currentReveals.push(
            Reveal({
                owner: currentCommit.owner,
                depth: _depth,
                overlay: currentCommit.overlay,
                stake: currentCommit.stake,
                stakeDensity: currentCommit.stake * uint256(2 ** _depth),
                hash: _hash
            })
        );

        emit Revealed(
            cr,
            currentCommit.overlay,
            currentCommit.stake,
            currentCommit.stake * uint256(2 ** _depth),
            _hash,
            _depth
        );
    }

    /**
     * @notice Helper function to get this round truth
     * @dev
     */
    function claim(
        ChunkInclusionProof calldata entryProof1,
        ChunkInclusionProof calldata entryProof2,
        ChunkInclusionProof calldata entryProofLast
    ) external whenNotPaused {
        winnerSelection();
        require(winner.owner == msg.sender, "Only selected winner can do the claim");

        Reveal memory winnerSelected = winner;
        uint256 indexInRC1;
        uint256 indexInRC2;
        bytes32 _currentRevealRoundAnchor = currentRevealRoundAnchor;
        bytes32 _seed = seed;

        // rand(14)
        indexInRC1 = uint256(_seed) % 15;
        // rand(13)
        indexInRC2 = uint256(_seed) % 14;
        if (indexInRC2 >= indexInRC1) {
            indexInRC2++;
        }

        require(
            inProximity(entryProofLast.proveSegment, _currentRevealRoundAnchor, winnerSelected.depth),
            "witness is not in depth"
        );
        inclusionFunction(entryProofLast, 30);
        stampFunction(entryProofLast);
        socFunction(entryProofLast);

        require(
            inProximity(entryProof1.proveSegment, _currentRevealRoundAnchor, winnerSelected.depth),
            "witness is not in depth"
        );
        inclusionFunction(entryProof1, indexInRC1 * 2);
        stampFunction(entryProof1);
        socFunction(entryProofLast);

        require(
            inProximity(entryProof2.proveSegment, _currentRevealRoundAnchor, winnerSelected.depth),
            "witness is not in depth"
        );
        inclusionFunction(entryProof2, indexInRC2 * 2);
        stampFunction(entryProof2);
        socFunction(entryProofLast);

        checkOrder(
            indexInRC1,
            indexInRC2,
            entryProof1.proofSegments[0],
            entryProof2.proofSegments[0],
            entryProofLast.proofSegments[0]
        );

        emit WinnerSelected(winnerSelected);

        PostageContract.withdraw(winnerSelected.owner);
    }

    // 515038
    function winnerSelection() internal {
        uint32 cr = uint32(currentRound());

        require(currentPhaseClaim(), "not in claim phase");
        require(cr == currentRevealRound, "round received no reveals");
        require(cr > currentClaimRound, "round already received successful claim");

        uint256 currentWinnerSelectionSum = 0;
        uint256 redundancyCount = 0;
        bytes32 randomNumber;
        uint256 randomNumberTrunc;

        bytes32 truthRevealedHash;
        uint8 truthRevealedDepth;
        uint256 currentCommitsLength = currentCommits.length;

        emit CountCommits(currentCommitsLength);
        emit CountReveals(currentReveals.length);

        (truthRevealedHash, truthRevealedDepth) = getCurrentTruth();
        emit TruthSelected(truthRevealedHash, truthRevealedDepth);
        string memory winnerSelectionAnchor = currentWinnerSelectionAnchor();

        for (uint256 i = 0; i < currentCommitsLength; ) {
            Commit memory currentCommit = currentCommits[i];
            uint256 revIndex = currentCommit.revealIndex;
            Reveal memory currentReveal = currentReveals[revIndex];

            // Select winner with valid truth
            if (
                currentCommit.revealed &&
                truthRevealedHash == currentReveal.hash &&
                truthRevealedDepth == currentReveal.depth
            ) {
                currentWinnerSelectionSum += currentReveal.stakeDensity;
                randomNumber = keccak256(abi.encodePacked(winnerSelectionAnchor, redundancyCount));
                randomNumberTrunc = uint256(randomNumber & MAX_H);

                if (randomNumberTrunc * currentWinnerSelectionSum < currentReveal.stakeDensity * (uint256(MAX_H) + 1)) {
                    winner = currentReveal;
                }

                redundancyCount++;
            }

            // Freeze deposit if any truth is false
            if (
                currentCommit.revealed &&
                (truthRevealedHash != currentReveal.hash || truthRevealedDepth != currentReveal.depth)
            ) {
                Stakes.freezeDeposit(
                    currentReveal.overlay,
                    penaltyMultiplierDisagreement * ROUND_LENGTH * uint256(2 ** truthRevealedDepth)
                );
            }

            // Slash deposits if revealed is false
            if (!currentCommit.revealed) {
                // slash in later phase (ph5)
                // Stakes.slashDeposit(currentCommits[i].overlay, currentCommits[i].stake);
                Stakes.freezeDeposit(
                    currentCommit.overlay,
                    penaltyMultiplierNonRevealed * ROUND_LENGTH * uint256(2 ** truthRevealedDepth)
                );
            }
            unchecked {
                ++i;
            }
        }

        OracleContract.adjustPrice(uint256(redundancyCount));
        currentClaimRound = cr;
    }

    /**
     * @notice Set freezing parameters
     */
    function setFreezingParams(uint8 _penaltyMultiplierDisagreement, uint8 _penaltyMultiplierNonRevealed) external {
        require(hasRole(DEFAULT_ADMIN_ROLE, msg.sender), "caller is not the admin");
        penaltyMultiplierDisagreement = _penaltyMultiplierDisagreement;
        penaltyMultiplierNonRevealed = _penaltyMultiplierNonRevealed;
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
        require(hasRole(PAUSER_ROLE, msg.sender), "only pauser can pause");
        _pause();
    }

    /**
     * @dev Unpause the contract, can only be called by the pauser when paused
     */
    function unPause() public {
        require(hasRole(PAUSER_ROLE, msg.sender), "only pauser can unpause");
        _unpause();
    }

    ////////////////////////////////////////
    //              GETTERS               //
    ////////////////////////////////////////

    // ----------------------------- Anchor calculations ------------------------------

    /**
     * @notice Returns the current random seed which is used to determine later utilised random numbers.
     * If rounds have elapsed without reveals, hash the seed with an incremented nonce to produce a new
     * random seed and hence a new round anchor.
     */
    function currentSeed() public view returns (bytes32) {
        uint256 cr = currentRound();
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
        uint256 cr = currentRound() + 1;
        bytes32 currentSeedValue = seed;

        if (cr > currentRevealRound + 1) {
            uint256 difference = cr - currentRevealRound - 1;
            currentSeedValue = keccak256(abi.encodePacked(currentSeedValue, difference));
        }

        return currentSeedValue;
    }

    /**
     * @notice The random value used to choose the selected truth teller.
     */
    function currentTruthSelectionAnchor() private view returns (string memory) {
        require(currentPhaseClaim(), "not determined for current round yet");
        uint256 cr = currentRound();
        require(cr == currentRevealRound, "round received no reveals");

        return string(abi.encodePacked(seed, "0"));
    }

    /**
     * @notice The random value used to choose the selected beneficiary.
     */
    function currentWinnerSelectionAnchor() private view returns (string memory) {
        require(currentPhaseClaim(), "not determined for current round yet");
        uint256 cr = currentRound();
        require(cr == currentRevealRound, "round received no reveals");

        return string(abi.encodePacked(seed, "1"));
    }

    /**
     * @notice The anchor used to determine eligibility for the current round.
     * @dev A node must be within proximity order of less than or equal to the storage depth they intend to report.
     */
    function currentRoundAnchor() public view returns (bytes32 returnVal) {
        uint256 cr = currentRound();

        if (currentPhaseCommit() || (cr > currentRevealRound && !currentPhaseClaim())) {
            return currentSeed();
        }

        if (currentPhaseReveal() && cr == currentRevealRound) {
            require(false, "can't return value after first reveal");
        }

        if (currentPhaseClaim()) {
            return nextSeed();
        }
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
    function currentRound() public view returns (uint256) {
        return (block.number / ROUND_LENGTH);
    }

    /**
     * @notice Returns true if current block is during commit phase.
     */
    function currentPhaseCommit() public view returns (bool) {
        if (block.number % ROUND_LENGTH < ROUND_LENGTH / 4) {
            return true;
        }
        return false;
    }

    /**
     * @notice Determine if a the owner of a given overlay can participate in the upcoming round.
     * @param overlay The overlay address of the applicant.
     * @param depth The storage depth the applicant intends to report.
     */
    function isParticipatingInUpcomingRound(bytes32 overlay, uint8 depth) public view returns (bool) {
        if (!currentPhaseClaim() && !currentPhaseCommit()) {
            revert WrongPhase();
        }

        if (Stakes.lastUpdatedBlockNumberOfOverlay(overlay) >= block.number - 2 * ROUND_LENGTH) {
            revert MustStake2Rounds();
        }

        if (Stakes.stakeOfOverlay(overlay) < MIN_STAKE) {
            revert BelowMinimumStake();
        }

        return inProximity(overlay, currentRoundAnchor(), depth);
    }

    // ----------------------------- Reveal ------------------------------

    /**
     * @notice Helper function to get this node reveal in commits
     * @dev
     */
    function findCommit(bytes32 _overlay, bytes32 _commitHash, uint256 _length) internal view returns (uint256) {
        for (uint256 i = 0; i < _length; ) {
            if (currentCommits[i].overlay == _overlay && _commitHash == currentCommits[i].obfuscatedHash) {
                return i;
            }
            unchecked {
                ++i;
            }
        }
        revert("no matching commit or hash");
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
        bytes32 _overlay,
        uint8 _depth,
        bytes32 _hash,
        bytes32 revealNonce
    ) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(_overlay, _depth, _hash, revealNonce));
    }

    /**
     * @notice Returns true if current block is during reveal phase.
     */
    function currentPhaseReveal() public view returns (bool) {
        uint256 number = block.number % ROUND_LENGTH;
        if (number >= ROUND_LENGTH / 4 && number < ROUND_LENGTH / 2) {
            return true;
        }
        return false;
    }

    /**
     * @notice Returns true if current block is during reveal phase.
     */
    function currentRoundReveals() public view returns (Reveal[] memory) {
        require(currentPhaseClaim(), "not in claim phase");
        uint256 cr = currentRound();
        require(cr == currentRevealRound, "round received no reveals");
        return currentReveals;
    }

    // ----------------------------- Claim  ------------------------------

    /**
     * @notice Returns true if current block is during claim phase.
     */
    function currentPhaseClaim() public view returns (bool) {
        if (block.number % ROUND_LENGTH >= ROUND_LENGTH / 2) {
            return true;
        }
        return false;
    }

    function getCurrentTruth() internal view returns (bytes32 Hash, uint8 Depth) {
        uint256 currentSum;
        bytes32 randomNumber;
        uint256 randomNumberTrunc;

        bytes32 truthRevealedHash;
        uint8 truthRevealedDepth;
        uint256 revIndex;
        string memory truthSelectionAnchor = currentTruthSelectionAnchor();
        uint256 commitsArrayLength = currentCommits.length;

        for (uint256 i = 0; i < commitsArrayLength; ) {
            if (currentCommits[i].revealed) {
                revIndex = currentCommits[i].revealIndex;
                currentSum += currentReveals[revIndex].stakeDensity;
                randomNumber = keccak256(abi.encodePacked(truthSelectionAnchor, i));
                randomNumberTrunc = uint256(randomNumber & MAX_H);

                // question is whether randomNumber / MAX_H < probability
                // where probability is stakeDensity / currentSum
                // to avoid resorting to floating points all divisions should be
                // simplified with multiplying both sides (as long as divisor > 0)
                // randomNumber / (MAX_H + 1) < stakeDensity / currentSum
                // ( randomNumber / (MAX_H + 1) ) * currentSum < stakeDensity
                // randomNumber * currentSum < stakeDensity * (MAX_H + 1)
                if (randomNumberTrunc * currentSum < currentReveals[revIndex].stakeDensity * (uint256(MAX_H) + 1)) {
                    truthRevealedHash = currentReveals[revIndex].hash;
                    truthRevealedDepth = currentReveals[revIndex].depth;
                }
            }
            unchecked {
                ++i;
            }
        }

        return (truthRevealedHash, truthRevealedDepth);
    }

    /**
     * @notice Determine if a the owner of a given overlay will be the beneficiary of the claim phase.
     * @param _overlay The overlay address of the applicant.
     */
    function isWinner(bytes32 _overlay) public view returns (bool) {
        require(currentPhaseClaim(), "winner not determined yet");
        uint256 cr = currentRound();
        require(cr == currentRevealRound, "round received no reveals");
        require(cr > currentClaimRound, "round already received successful claim");

        uint256 currentWinnerSelectionSum;
        bytes32 winnerIs;
        bytes32 randomNumber;
        uint256 randomNumberTrunc;
        bytes32 truthRevealedHash;
        uint8 truthRevealedDepth;
        uint256 revIndex;
        string memory winnerSelectionAnchor = currentWinnerSelectionAnchor();
        uint256 redundancyCount = 0;

        // Get current truth
        (truthRevealedHash, truthRevealedDepth) = getCurrentTruth();
        uint256 commitsArrayLength = currentCommits.length;

        for (uint256 i = 0; i < commitsArrayLength; ) {
            revIndex = currentCommits[i].revealIndex;

            // Deterministically read winner
            if (
                currentCommits[i].revealed &&
                truthRevealedHash == currentReveals[revIndex].hash &&
                truthRevealedDepth == currentReveals[revIndex].depth
            ) {
                currentWinnerSelectionSum += currentReveals[revIndex].stakeDensity;
                randomNumber = keccak256(abi.encodePacked(winnerSelectionAnchor, redundancyCount));
                randomNumberTrunc = uint256(randomNumber & MAX_H);

                if (
                    randomNumberTrunc * currentWinnerSelectionSum <
                    currentReveals[revIndex].stakeDensity * (uint256(MAX_H) + 1)
                ) {
                    winnerIs = currentReveals[revIndex].overlay;
                }

                redundancyCount++;
            }
            unchecked {
                ++i;
            }
        }

        return (winnerIs == _overlay);
    }

    // ----------------------------- Claim verifications  ------------------------------

    function socFunction(ChunkInclusionProof calldata entryProof) internal pure {
        if (entryProof.socProofAttached.length == 0) return;

        require(
            Signatures.socVerify(
                entryProof.socProofAttached[0].signer, // signer Ethereum address to check against
                entryProof.socProofAttached[0].signature,
                entryProof.socProofAttached[0].identifier,
                entryProof.socProofAttached[0].chunkAddr
            ),
            "Soc verification failed for element"
        );

        require(
            calculateSocAddress(entryProof.socProofAttached[0].identifier, entryProof.socProofAttached[0].signer) ==
                entryProof.proveSegment,
            "Soc address calculation does not match with the witness"
        );
    }

    function stampFunction(ChunkInclusionProof calldata entryProof) internal view {
        // authentic
        uint8 batchDepth = PostageContract.batchDepth(entryProof.postageId);
        uint8 bucketDepth = PostageContract.batchBucketDepth(entryProof.postageId);
        uint32 postageIndex = getPostageIndex(entryProof.index);
        uint256 maxPostageIndex = postageStampIndexCount(batchDepth, bucketDepth);
        // available
        require(postageIndex < maxPostageIndex, "Stamp available: index resides outside of the valid index set");

        address batchOwner = PostageContract.batchOwner(entryProof.postageId);
        // authorized
        require(
            Signatures.postageVerify(
                batchOwner,
                entryProof.signature,
                entryProof.proveSegment,
                entryProof.postageId,
                entryProof.index,
                entryProof.timeStamp
            ),
            "Stamp authorized: signature recovery failed for element"
        );

        // alive
        require(
            PostageContract.remainingBalance(entryProof.postageId) >= PostageContract.minimumInitialBalancePerChunk(),
            "Stamp alive: batch remaining balance validation failed for attached stamp"
        );

        // aligned
        uint64 postageBucket = getPostageBucket(entryProof.index);
        uint64 addressBucket = addressToBucket(entryProof.proveSegment, bucketDepth);
        require(postageBucket == addressBucket, "Stamp aligned: postage bucket differs from address bucket");

        // FOR LATER USE
        // require(PostageContract.lastUpdateBlockOfBatch(entryProofLast.postageId) < block.number - 2 * ROUND_LENGTH, "batch past balance validation failed for attached stamp");
    }

    function inclusionFunction(ChunkInclusionProof calldata entryProof, uint256 indexInRC) internal view {
        require(
            winner.hash ==
                BMTChunk.chunkAddressFromInclusionProof(
                    entryProof.proofSegments,
                    entryProof.proveSegment,
                    indexInRC,
                    32 * 32
                ),
            "RC inclusion proof failed for element"
        );

        uint256 randomChunkSegmentIndex = uint256(seed) % 128;

        require(
            entryProof.proofSegments2[0] == entryProof.proofSegments3[0],
            "first sister segment in data must match"
        );

        bytes32 originalCacAddress = entryProof.socProofAttached.length > 0
            ? entryProof.socProofAttached[0].chunkAddr // soc attestation in socFunction
            : entryProof.proveSegment;

        require(
            originalCacAddress ==
                BMTChunk.chunkAddressFromInclusionProof(
                    entryProof.proofSegments2,
                    entryProof.proveSegment2,
                    randomChunkSegmentIndex,
                    entryProof.chunkSpan
                ),
            "inclusion proof failed for original address of element"
        );

        require(
            entryProof.proofSegments[0] ==
                TransformedBMTChunk.transformedChunkAddressFromInclusionProof(
                    entryProof.proofSegments3,
                    entryProof.proveSegment2,
                    randomChunkSegmentIndex,
                    entryProof.chunkSpan,
                    currentRevealRoundAnchor
                ),
            "inclusion proof failed for transformed address of element"
        );
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

    function checkOrder(uint256 a, uint256 b, bytes32 trA1, bytes32 trA2, bytes32 trALast) internal pure {
        if (a < b) {
            require(uint256(trA1) < uint256(trA2), "random element order check failed");
            require(uint256(trA2) < uint256(trALast), "last element order check failed");
        } else {
            require(uint256(trA2) < uint256(trA1), "random element order check failed");
            require(uint256(trA1) < uint256(trALast), "last element order check failed");
        }

        estimateSize(trALast);
    }

    function estimateSize(bytes32 trALast) internal pure {
        require(uint256(trALast) < SAMPLE_MAX_VALUE, "reserve size estimation check failed");
    }
}
