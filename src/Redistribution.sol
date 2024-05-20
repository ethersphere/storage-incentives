// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.19;
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "./Util/TransformedChunkProof.sol";
import "./Util/ChunkProof.sol";
import "./Util/Signatures.sol";
import "./interface/IPostageStamp.sol";

interface IPriceOracle {
    function adjustPrice(uint16 redundancy) external;
}

interface IStakeRegistry {
    struct Stake {
        bytes32 overlay;
        uint256 stakeAmount;
        uint256 lastUpdatedBlockNumber;
        bool isValue;
    }

    function freezeDeposit(address _owner, uint256 _time) external;

    function lastUpdatedBlockNumberOfAddress(address _owner) external view returns (uint256);

    function overlayOfAddress(address _owner) external view returns (bytes32);

    function stakeOfAddress(address _owner) external view returns (uint256);

    function getStakeStruct(address _owner) external view returns (Stake memory);
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
        bytes32 overlay;
        address owner;
        uint8 depth;
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
        uint64 chunkSpan;
        bytes32[] proofSegments3;
        //  _proveSegment3 known, is equal _proveSegment2
        // proveSegmentIndex3 know, is equal _proveSegmentIndex2;
        // chunkSpan2 is equal to chunkSpan (as the data is the same)
        //
        PostageProof postageProof;
        SOCProof[] socProof;
    }

    struct SOCProof {
        address signer; // signer Ethereum address to check against
        bytes signature;
        bytes32 identifier; //
        bytes32 chunkAddr; // wrapped chunk address
    }

    struct PostageProof {
        bytes signature;
        bytes32 postageId;
        uint64 index;
        uint64 timeStamp;
        // address signer; it is provided by the postage stamp contract
        // bytes32 chunkAddr; it equals to the proveSegment argument
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

    // alpha=0.097612 beta=0.0716570 k=16
    uint256 private sampleMaxValue = 1284401000000000000000000000000000000000000000000000000000000000000000000;

    // The reveal of the winner of the last round.
    Reveal public winner;

    // The length of a round in blocks.
    uint256 private constant ROUND_LENGTH = 152;

    // The miniumum stake allowed to be staked using the Staking contract.
    uint64 private constant MIN_STAKE = 100000000000000000;

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

    /**
     * @dev Logs for inclusion proof
     */
    event transformedChunkAddressFromInclusionProof(uint256 indexInRC, bytes32 chunkAddress);

    // ----------------------------- Errors ------------------------------

    error NotCommitPhase(); // Game is not in commit phase
    error NoCommitsReceived(); // Round didn't receive any commits
    error PhaseLastBlock(); // We don't permit commits in last block of the phase
    error BelowMinimumStake(); // Node participating in game has stake below minimum treshold
    error CommitRoundOver(); // Commit phase in this round is over
    error CommitRoundNotStarted(); // Commit phase in this round has not started yet
    error NotMatchingOwner(); // Sender of commit is not matching the overlay address
    error MustStake2Rounds(); // Before entering the game node must stake 2 rounds prior
    error WrongPhase(); // Checking in wrong phase, need to check duing claim phase of current round for next round or commit in current round
    error AlreadyCommited(); // Node already commited in this round
    error NotRevealPhase(); // Game is not in reveal phase
    error OutOfDepthReveal(bytes32); // Anchor is out of reported depth in Reveal phase, anchor data available as argument
    error OutOfDepthClaim(uint8); // Anchor is out of reported depth in Claim phase, entryProof index is argument
    error OutOfDepth(); // Anchor is out of reported depth
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
    error BatchDoesNotExist(bytes32); // Stamp alive: batch remaining balance validation failed for attached stamp
    error BucketDiffers(bytes32); // Stamp aligned: postage bucket differs from address bucket
    error InclusionProofFailed(uint8, bytes32);
    // 1 = RC inclusion proof failed for element
    // 2 = First sister segment in data must match,
    // 3 = Inclusion proof failed for original address of element
    // 4 = Inclusion proof failed for transformed address of element
    error RandomElementCheckFailed(); // Random element order check failed
    error LastElementCheckFailed(); // Last element order check failed
    error ReserveCheckFailed(bytes32 trALast); // Reserve size estimation check failed

    // ----------------------------- CONSTRUCTOR ------------------------------

    /**
     * @param staking the address of the linked Staking contract.
     * @param postageContract the address of the linked PostageStamp contract.
     * @param oracleContract the address of the linked PriceOracle contract.
     */
    constructor(address staking, address postageContract, address oracleContract) {
        Stakes = IStakeRegistry(staking);
        PostageContract = IPostageStamp(postageContract);
        OracleContract = IPriceOracle(oracleContract);
        PAUSER_ROLE = keccak256("PAUSER_ROLE");
        _setupRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _setupRole(PAUSER_ROLE, msg.sender);
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
     */
    function commit(bytes32 _obfuscatedHash, uint64 _roundNumber) external whenNotPaused {
        uint64 cr = currentRound();
        IStakeRegistry.Stake memory nodeStake = Stakes.getStakeStruct(msg.sender);

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

        if (nodeStake.stakeAmount < MIN_STAKE) {
            revert BelowMinimumStake();
        }

        if (nodeStake.lastUpdatedBlockNumber >= block.number - 2 * ROUND_LENGTH) {
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
            if (currentCommits[i].overlay == nodeStake.overlay) {
                revert AlreadyCommited();
            }

            unchecked {
                ++i;
            }
        }

        currentCommits.push(
            Commit({
                overlay: nodeStake.overlay,
                owner: msg.sender,
                revealed: false,
                stake: nodeStake.stakeAmount,
                obfuscatedHash: _obfuscatedHash,
                revealIndex: 0
            })
        );

        emit Committed(_roundNumber, nodeStake.overlay);
    }

    /**
     * @notice Reveal the pre-image values used to generate commit provided during this round's commit phase.
     * @param _depth The reported depth.
     * @param _hash The reserve commitment hash.
     * @param _revealNonce The nonce used to generate the commit that is being revealed.
     */
    function reveal(uint8 _depth, bytes32 _hash, bytes32 _revealNonce) external whenNotPaused {
        uint64 cr = currentRound();
        bytes32 _overlay = Stakes.overlayOfAddress(msg.sender);

        if (_depth < currentMinimumDepth()) {
            revert OutOfDepth();
        }

        if (!currentPhaseReveal()) {
            revert NotRevealPhase();
        }

        if (cr != currentCommitRound) {
            revert NoCommitsReceived();
        }

        if (cr != currentRevealRound) {
            currentRevealRoundAnchor = currentRoundAnchor();
            delete currentReveals;
            // We set currentRevealRound ONLY after we set current anchor
            currentRevealRound = cr;
            emit CurrentRevealAnchor(cr, currentRevealRoundAnchor);
            updateRandomness();
        }

        bytes32 obfuscatedHash = wrapCommit(_overlay, _depth, _hash, _revealNonce);
        uint256 id = findCommit(_overlay, obfuscatedHash);
        Commit memory revealedCommit = currentCommits[id];

        // Check that commit is in proximity of the current anchor
        if (!inProximity(revealedCommit.overlay, currentRevealRoundAnchor, _depth)) {
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
                stakeDensity: revealedCommit.stake * uint256(2 ** _depth),
                hash: _hash
            })
        );

        emit Revealed(
            cr,
            revealedCommit.overlay,
            revealedCommit.stake,
            revealedCommit.stake * uint256(2 ** _depth),
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

        if (!inProximity(entryProofLast.proveSegment, _currentRevealRoundAnchor, winnerSelected.depth)) {
            revert OutOfDepthClaim(3);
        }

        inclusionFunction(entryProofLast, 30);
        stampFunction(entryProofLast);
        socFunction(entryProofLast);

        if (!inProximity(entryProof1.proveSegment, _currentRevealRoundAnchor, winnerSelected.depth)) {
            revert OutOfDepthClaim(2);
        }

        inclusionFunction(entryProof1, indexInRC1 * 2);
        stampFunction(entryProof1);
        socFunction(entryProof1);

        if (!inProximity(entryProof2.proveSegment, _currentRevealRoundAnchor, winnerSelected.depth)) {
            revert OutOfDepthClaim(1);
        }

        inclusionFunction(entryProof2, indexInRC2 * 2);
        stampFunction(entryProof2);
        socFunction(entryProof2);

        checkOrder(
            indexInRC1,
            indexInRC2,
            entryProof1.proofSegments[0],
            entryProof2.proofSegments[0],
            entryProofLast.proofSegments[0]
        );

        estimateSize(entryProofLast.proofSegments[0]);

        PostageContract.withdraw(winnerSelected.owner);
        emit WinnerSelected(winnerSelected);
        emit ChunkCount(PostageContract.validChunkCount());
    }

    function winnerSelection() internal {
        uint64 cr = currentRound();

        if (!currentPhaseClaim()) {
            revert NotClaimPhase();
        }

        if (cr != currentRevealRound) {
            revert NoReveals();
        }

        if (cr <= currentClaimRound) {
            revert AlreadyClaimed();
        }

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
                    currentReveal.owner,
                    penaltyMultiplierDisagreement * ROUND_LENGTH * uint256(2 ** truthRevealedDepth)
                );
            }

            // Slash deposits if revealed is false
            if (!currentCommit.revealed) {
                // slash in later phase (ph5)
                // Stakes.slashDeposit(currentCommits[i].overlay, currentCommits[i].stake);
                Stakes.freezeDeposit(
                    currentCommit.owner,
                    penaltyMultiplierNonRevealed * ROUND_LENGTH * uint256(2 ** truthRevealedDepth)
                );
            }
            unchecked {
                ++i;
            }
        }

        OracleContract.adjustPrice(uint16(redundancyCount));
        currentClaimRound = cr;
    }

    function inclusionFunction(ChunkInclusionProof calldata entryProof, uint256 indexInRC) internal {
        uint256 randomChunkSegmentIndex = uint256(seed) % 128;
        bytes32 calculatedTransformedAddr = TransformedBMTChunk.transformedChunkAddressFromInclusionProof(
            entryProof.proofSegments3,
            entryProof.proveSegment2,
            randomChunkSegmentIndex,
            entryProof.chunkSpan,
            currentRevealRoundAnchor
        );

        emit transformedChunkAddressFromInclusionProof(indexInRC, calculatedTransformedAddr);

        if (
            winner.hash !=
            BMTChunk.chunkAddressFromInclusionProof(
                entryProof.proofSegments,
                entryProof.proveSegment,
                indexInRC,
                32 * 32
            )
        ) {
            revert InclusionProofFailed(1, calculatedTransformedAddr);
        }

        if (entryProof.proofSegments2[0] != entryProof.proofSegments3[0]) {
            revert InclusionProofFailed(2, calculatedTransformedAddr);
        }

        bytes32 originalAddress = entryProof.socProof.length > 0
            ? entryProof.socProof[0].chunkAddr // soc attestation in socFunction
            : entryProof.proveSegment;

        if (
            originalAddress !=
            BMTChunk.chunkAddressFromInclusionProof(
                entryProof.proofSegments2,
                entryProof.proveSegment2,
                randomChunkSegmentIndex,
                entryProof.chunkSpan
            )
        ) {
            revert InclusionProofFailed(3, calculatedTransformedAddr);
        }

        // In case of SOC, the transformed address is hashed together with its address in the sample
        if (entryProof.socProof.length > 0) {
            calculatedTransformedAddr = keccak256(
                abi.encode(
                    entryProof.proveSegment, // SOC address
                    calculatedTransformedAddr
                )
            );
        }

        if (entryProof.proofSegments[0] != calculatedTransformedAddr) {
            revert InclusionProofFailed(4, calculatedTransformedAddr);
        }
    }

    /**
     * @notice Set freezing parameters
     */
    function setFreezingParams(uint8 _penaltyMultiplierDisagreement, uint8 _penaltyMultiplierNonRevealed) external {
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
            revert NotAdmin();
        }

        penaltyMultiplierDisagreement = _penaltyMultiplierDisagreement;
        penaltyMultiplierNonRevealed = _penaltyMultiplierNonRevealed;
    }

    /**
     * @notice changes the max sample value used for reserve estimation
     */
    function setSampleMaxValue(uint256 _sampleMaxValue) external {
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
            revert NotAdmin();
        }

        sampleMaxValue = _sampleMaxValue;
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
        if (!hasRole(PAUSER_ROLE, msg.sender)) {
            revert OnlyPauser();
        }

        _pause();
    }

    /**
     * @dev Unpause the contract, can only be called by the pauser when paused
     */
    function unPause() public {
        if (!hasRole(PAUSER_ROLE, msg.sender)) {
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
     * @notice The random value used to choose the selected truth teller.
     */
    function currentTruthSelectionAnchor() private view returns (string memory) {
        if (!currentPhaseClaim()) {
            revert NotClaimPhase();
        }

        uint64 cr = currentRound();
        if (cr != currentRevealRound) {
            revert NoReveals();
        }

        return string(abi.encodePacked(seed, "0"));
    }

    /**
     * @notice The random value used to choose the selected beneficiary.
     */
    function currentWinnerSelectionAnchor() private view returns (string memory) {
        if (!currentPhaseClaim()) {
            revert NotClaimPhase();
        }
        uint64 cr = currentRound();
        if (cr != currentRevealRound) {
            revert NoReveals();
        }

        return string(abi.encodePacked(seed, "1"));
    }

    /**
     * @notice The anchor used to determine eligibility for the current round.
     * @dev A node must be within proximity order of less than or equal to the storage depth they intend to report.
     */
    function currentRoundAnchor() public view returns (bytes32 returnVal) {
        // This will be called in reveal phase and set as currentRevealRoundAnchor or in
        // commit phase when checking eligibility for next round by isParticipatingInUpcomingRound
        if (currentPhaseCommit() || (currentRound() > currentRevealRound && !currentPhaseClaim())) {
            return currentSeed();
        }

        // This will be called by isParticipatingInUpcomingRound check in claim phase
        if (currentPhaseClaim()) {
            return nextSeed();
        }

        // Without this, this function will output 0x0 after first reveal which is value and we prefere it reverts
        if (currentPhaseReveal() && currentRound() == currentRevealRound) {
            revert FirstRevealDone();
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
    function currentRound() public view returns (uint64) {
        return uint64(block.number / ROUND_LENGTH);
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
     * use msg.sender as default parametar to check value
     * @param _depth The storage depth the applicant intends to report.
     */
    function isParticipatingInUpcomingRound(uint8 _depth) public view returns (bool) {
        IStakeRegistry.Stake memory nodeStake = Stakes.getStakeStruct(msg.sender);
        if (currentPhaseReveal()) {
            revert WrongPhase();
        }

        if (nodeStake.lastUpdatedBlockNumber >= block.number - 2 * ROUND_LENGTH) {
            revert MustStake2Rounds();
        }

        if (nodeStake.stakeAmount < MIN_STAKE) {
            revert BelowMinimumStake();
        }

        return inProximity(nodeStake.overlay, currentRoundAnchor(), _depth);
    }

    /**
     * @notice Determine if a the owner of a given overlay can participate in the upcoming round.
     * overloading function for default one with msg.sender
     * @param _owner The address of the applicant from.
     * @param _depth The storage depth the applicant intends to report.
     */
    function isParticipatingInUpcomingRound(address _owner, uint8 _depth) public view returns (bool) {
        IStakeRegistry.Stake memory nodeStake = Stakes.getStakeStruct(_owner);
        if (currentPhaseReveal()) {
            revert WrongPhase();
        }

        if (nodeStake.lastUpdatedBlockNumber >= block.number - 2 * ROUND_LENGTH) {
            revert MustStake2Rounds();
        }

        if (nodeStake.stakeAmount < MIN_STAKE) {
            revert BelowMinimumStake();
        }

        return inProximity(nodeStake.overlay, currentRoundAnchor(), _depth);
    }

    // ----------------------------- Reveal ------------------------------

    /**
     * @notice Returns minimum depth reveal has to have to participate in this round
     */
    function currentMinimumDepth() public view returns (uint8) {
        // We are checking value in reveal phase, as the currentCommitRound is set to the current round
        // but the currentClaimRound is still set to the last time claim was made
        // We add 1 to ensure that for the next round the minimum depth is the same as last winner depth

        uint256 difference = currentCommitRound - currentClaimRound;
        uint8 skippedRounds = uint8(difference > 254 ? 254 : difference) + 1;

        uint8 lastWinnerDepth = winner.depth;

        // We ensure that skippedRounds is not bigger than lastWinnerDepth, because of overflow
        return skippedRounds >= lastWinnerDepth ? 0 : lastWinnerDepth - skippedRounds;
    }

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
        if (!currentPhaseClaim()) {
            revert NotClaimPhase();
        }

        uint64 cr = currentRound();
        if (cr != currentRevealRound) {
            revert NoReveals();
        }

        if (cr <= currentClaimRound) {
            revert AlreadyClaimed();
        }

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
        if (entryProof.socProof.length == 0) return;

        if (
            !Signatures.socVerify(
                entryProof.socProof[0].signer, // signer Ethereum address to check against
                entryProof.socProof[0].signature,
                entryProof.socProof[0].identifier,
                entryProof.socProof[0].chunkAddr
            )
        ) {
            revert SocVerificationFailed(entryProof.socProof[0].chunkAddr);
        }

        if (
            calculateSocAddress(entryProof.socProof[0].identifier, entryProof.socProof[0].signer) !=
            entryProof.proveSegment
        ) {
            revert SocCalcNotMatching(entryProof.socProof[0].chunkAddr);
        }
    }

    function stampFunction(ChunkInclusionProof calldata entryProof) internal view {
        // authentic
        (address batchOwner, uint8 batchDepth, uint8 bucketDepth, , , ) = PostageContract.batches(
            entryProof.postageProof.postageId
        );

        // alive
        if (batchOwner == address(0)) {
            revert BatchDoesNotExist(entryProof.postageProof.postageId); // Batch does not exist or expired
        }

        uint32 postageIndex = getPostageIndex(entryProof.postageProof.index);
        uint256 maxPostageIndex = postageStampIndexCount(batchDepth, bucketDepth);
        // available
        if (postageIndex >= maxPostageIndex) {
            revert IndexOutsideSet(entryProof.postageProof.postageId);
        }

        // aligned
        uint64 postageBucket = getPostageBucket(entryProof.postageProof.index);
        uint64 addressBucket = addressToBucket(entryProof.proveSegment, bucketDepth);
        if (postageBucket != addressBucket) {
            revert BucketDiffers(entryProof.postageProof.postageId);
        }

        // authorized
        if (
            !Signatures.postageVerify(
                batchOwner,
                entryProof.postageProof.signature,
                entryProof.proveSegment,
                entryProof.postageProof.postageId,
                entryProof.postageProof.index,
                entryProof.postageProof.timeStamp
            )
        ) {
            revert SigRecoveryFailed(entryProof.postageProof.postageId);
        }
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
            if (uint256(trA1) >= uint256(trA2)) {
                revert RandomElementCheckFailed();
            }
            if (uint256(trA2) >= uint256(trALast)) {
                revert LastElementCheckFailed();
            }
        } else {
            if (uint256(trA2) >= uint256(trA1)) {
                revert RandomElementCheckFailed();
            }
            if (uint256(trA1) >= uint256(trALast)) {
                revert LastElementCheckFailed();
            }
        }
    }

    function estimateSize(bytes32 trALast) internal view {
        if (uint256(trALast) >= sampleMaxValue) {
            revert ReserveCheckFailed(trALast);
        }
    }
}
