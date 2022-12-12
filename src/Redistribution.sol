// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.1;
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "./PostageStamp.sol";
import "./PriceOracle.sol";
import "./Staking.sol";

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
    // An eligible user may commit to an _obfuscatedHash_ during the commit phase...
    struct Commit {
        bytes32 overlay;
        address owner;
        uint256 stake;
        bytes32 obfuscatedHash;
        bool revealed;
        uint256 revealIndex;
    }
    // ...then provide the actual values that are the constituents of the pre-image of the _obfuscatedHash_
    // during the reveal phase.
    struct Reveal {
        address owner;
        bytes32 overlay;
        uint256 stake;
        uint256 stakeDensity;
        bytes32 hash;
        uint8 depth;
    }

    // The address of the linked PostageStamp contract.
    PostageStamp public PostageContract;
    // The address of the linked PriceOracle contract.
    PriceOracle public OracleContract;
    // The address of the linked Staking contract.
    StakeRegistry public Stakes;

    // Commits for the current round.
    Commit[] public currentCommits;
    // Reveals for the current round.
    Reveal[] public currentReveals;

    // Role allowed to pause.
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    // Maximum value of the keccack256 hash.
    bytes32 MaxH = bytes32(0x00000000000000000000000000000000ffffffffffffffffffffffffffffffff);

    // The current anchor that being processed for the reveal and claim phases of the round.
    bytes32 currentRevealRoundAnchor;

    // The current random value from which we will random.
    // inputs for selection of the truth teller and beneficiary.
    bytes32 seed;

    // The miniumum stake allowed to be staked using the Staking contract.
    uint256 public minimumStake = 100000000000000000;

    // The number of the currently active round phases.
    uint256 public currentCommitRound;
    uint256 public currentRevealRound;
    uint256 public currentClaimRound;

    // The length of a round in blocks.
    uint256 public roundLength = 152;

    // The reveal of the winner of the last round.
    Reveal public winner;

    /**
     * @param staking the address of the linked Staking contract.
     * @param postageContract the address of the linked PostageStamp contract.
     * @param oracleContract the address of the linked PriceOracle contract.
     */
    constructor(
        address staking,
        address postageContract,
        address oracleContract
    ) {
        Stakes = StakeRegistry(staking);
        PostageContract = PostageStamp(postageContract);
        OracleContract = PriceOracle(oracleContract);
        _setupRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _setupRole(PAUSER_ROLE, msg.sender);
    }

    /**
     * @dev Emitted when the winner of a round is selected in the claim phase.
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
     * @notice The number of the current round.
     */
    function currentRound() public view returns (uint256) {
        return (block.number / roundLength);
    }

    /**
     * @notice Returns true if current block is during commit phase.
     */
    function currentPhaseCommit() public view returns (bool) {
        if (block.number % roundLength < roundLength / 4) {
            return true;
        }
        return false;
    }

    /**
     * @notice Returns true if current block is during reveal phase.
     */
    function currentPhaseReveal() public view returns (bool) {
        uint256 number = block.number % roundLength;
        if ( number >= roundLength / 4 && number < roundLength / 2 ) {
            return true;
        }
        return false;
    }

    /**
     * @notice Returns true if current block is during claim phase.
     */
    function currentPhaseClaim() public view returns (bool){
        if ( block.number % roundLength >= roundLength / 2 ) {
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
    function commit(
        bytes32 _obfuscatedHash,
        bytes32 _overlay,
        uint256 _roundNumber
    ) external whenNotPaused {
        require(currentPhaseCommit(), "not in commit phase");
        uint256 cr = currentRound();
        require(cr <= _roundNumber, "commit round over");
        require(cr >= _roundNumber, "commit round not started yet");

        uint256 nstake = Stakes.stakeOfOverlay(_overlay);
        require(nstake >= minimumStake, "stake must exceed minimum");
        require(Stakes.ownerOfOverlay(_overlay) == msg.sender, "owner must match sender");

        require(
            Stakes.lastUpdatedBlockNumberOfOverlay(_overlay) < block.number - 2 * roundLength,
            "must have staked 2 rounds prior"
        );

        // if we are in a new commit phase, reset the array of commits and
        // set the currentCommitRound to be the current one
        if (cr != currentCommitRound) {
            delete currentCommits;
            currentCommitRound = cr;
        }

        uint256 commitsArrayLength = currentCommits.length;

        for (uint256 i = 0; i < commitsArrayLength; i++) {
            require(currentCommits[i].overlay != _overlay, "only one commit each per round");
        }

        currentCommits.push(
            Commit({
                owner: msg.sender,
                overlay: _overlay,
                stake: nstake,
                obfuscatedHash: _obfuscatedHash,
                revealed: false,
                revealIndex: 0
            })
        );

        emit Committed(_roundNumber, _overlay);
    }

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
     * @notice Updates the source of randomness. Uses block.difficulty in pre-merge chains, this is substituted
     * to block.prevrandao in post merge chains.
     */
    function updateRandomness() private {
        seed = keccak256(abi.encode(seed, block.difficulty));
    }

    function nonceBasedRandomness(bytes32 nonce) private {
        seed = seed ^ nonce;
    }

    /**
     * @notice Returns true if an overlay address _A_ is within proximity order _minimum_ of _B_.
     * @param A An overlay address to compare.
     * @param B An overlay address to compare.
     * @param minimum Minimum proximity order.
     */
    function inProximity(
        bytes32 A,
        bytes32 B,
        uint8 minimum
    ) public pure returns (bool) {
        if (minimum == 0) {
            return true;
        }
        return uint256(A ^ B) < uint256(2**(256 - minimum));
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
     * @notice Reveal the pre-image values used to generate commit provided during this round's commit phase.
     * @param _overlay The overlay address of the applicant.
     * @param _depth The reported depth.
     * @param _hash The reserve commitment hash.
     * @param _revealNonce The nonce used to generate the commit that is being revealed.
     */
    function reveal(
        bytes32 _overlay,
        uint8 _depth,
        bytes32 _hash,
        bytes32 _revealNonce
    ) external whenNotPaused {
        require(currentPhaseReveal(), "not in reveal phase");

        uint256 cr = currentRound();

        require(cr == currentCommitRound, "round received no commits");
        if (cr != currentRevealRound) {
            currentRevealRoundAnchor = currentRoundAnchor();
            delete currentReveals;
            currentRevealRound = cr;
            updateRandomness();
        }

        bytes32 commitHash = wrapCommit(_overlay, _depth, _hash, _revealNonce);

        uint256 commitsArrayLength = currentCommits.length;

        for (uint256 i = 0; i < commitsArrayLength; i++) {
            if (currentCommits[i].overlay == _overlay && commitHash == currentCommits[i].obfuscatedHash) {
                require(
                    inProximity(currentCommits[i].overlay, currentRevealRoundAnchor, _depth),
                    "anchor out of self reported depth"
                );
                //check can only revealed once
                require(currentCommits[i].revealed == false, "participant already revealed");
                currentCommits[i].revealed = true;
                currentCommits[i].revealIndex = currentReveals.length;

                currentReveals.push(
                    Reveal({
                        owner: currentCommits[i].owner,
                        overlay: currentCommits[i].overlay,
                        stake: currentCommits[i].stake,
                        stakeDensity: currentCommits[i].stake * uint256(2**_depth),
                        hash: _hash,
                        depth: _depth
                    })
                );

                nonceBasedRandomness(_revealNonce);

                emit Revealed(
                    cr,
                    currentCommits[i].overlay,
                    currentCommits[i].stake,
                    currentCommits[i].stake * uint256(2**_depth),
                    _hash,
                    _depth
                );

                return;
            }
        }

        require(false, "no matching commit or hash");
    }

    /**
     * @notice Determine if a the owner of a given overlay will be the beneficiary of the claim phase.
     * @param _overlay The overlay address of the applicant.
     */
    function isWinner(bytes32 _overlay) public view returns (bool) {
        require(currentPhaseClaim(), "not in claim phase");

        uint256 cr = currentRound();

        require(cr == currentRevealRound, "round received no reveals");
        require(cr > currentClaimRound, "round already received successful claim");

        string memory truthSelectionAnchor = currentTruthSelectionAnchor();

        uint256 currentSum;
        uint256 currentWinnerSelectionSum;
        bytes32 winnerIs;
        bytes32 randomNumber;

        bytes32 truthRevealedHash;
        uint8 truthRevealedDepth;

        uint256 commitsArrayLength = currentCommits.length;
        uint256 revealsArrayLength = currentReveals.length;
        
        uint256 revIndex;
        uint256 k = 0;
        uint256 index;

        for (uint256 i = 0; i < commitsArrayLength; i++) {
            if (currentCommits[i].revealed) {
                k++;
                revIndex = currentCommits[i].revealIndex;
                currentSum += currentReveals[revIndex].stakeDensity;
                randomNumber = keccak256(abi.encodePacked(truthSelectionAnchor, k));

                if (uint256(randomNumber & MaxH) * currentSum < currentReveals[revIndex].stakeDensity * (uint256(MaxH) + 1)) {
                    truthRevealedHash = currentReveals[revIndex].hash;
                    truthRevealedDepth = currentReveals[revIndex].depth;
                }
            }
        }

        k = 0;

        string memory winnerSelectionAnchor = currentWinnerSelectionAnchor();

        for (uint256 i = 0; i < commitsArrayLength; i++) {
            revIndex = currentCommits[i].revealIndex;
            if (currentCommits[i].revealed && truthRevealedHash == currentReveals[revIndex].hash && truthRevealedDepth == currentReveals[revIndex].depth) {
                currentWinnerSelectionSum += currentReveals[revIndex].stakeDensity;
                randomNumber = keccak256(abi.encodePacked(winnerSelectionAnchor, k));

                if (
                    uint256(randomNumber & MaxH) * currentWinnerSelectionSum < currentReveals[revIndex].stakeDensity * (uint256(MaxH) + 1)
                ) {
                    winnerIs = currentReveals[revIndex].overlay;
                }

                k++;
            } 
        }

        return (winnerIs == _overlay);
    }
    /**
     * @notice Determine if a the owner of a given overlay can participate in the upcoming round.
     * @param overlay The overlay address of the applicant.
     * @param depth The storage depth the applicant intends to report.
     */
    function isParticipatingInUpcomingRound(bytes32 overlay, uint8 depth) public view returns (bool) {
        require(currentPhaseClaim() || currentPhaseCommit(), "not determined for upcoming round yet");
        require(
            Stakes.lastUpdatedBlockNumberOfOverlay(overlay) < block.number - 2 * roundLength,
            "stake updated recently"
        );
        require(Stakes.stakeOfOverlay(overlay) >= minimumStake, "stake amount does not meet minimum");
        return inProximity(overlay, currentRoundAnchor(), depth);
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
     * @notice Conclude the current round by identifying the selected truth teller and beneficiary.
     * @dev
     */
    function claim() external whenNotPaused {
        require(currentPhaseClaim(), "not in claim phase");

        uint256 cr = currentRound();

        require(cr == currentRevealRound, "round received no reveals");
        require(cr > currentClaimRound, "round already received successful claim");

        string memory truthSelectionAnchor = currentTruthSelectionAnchor();

        uint256 currentSum;
        uint256 currentWinnerSelectionSum;
        bytes32 randomNumber;
        uint256 randomNumberTrunc;

        bytes32 truthRevealedHash;
        uint8 truthRevealedDepth;

        uint256 commitsArrayLength = currentCommits.length;
        uint256 revealsArrayLength = currentReveals.length;

        emit CountCommits(commitsArrayLength);
        emit CountReveals(revealsArrayLength);

        uint256 revIndex;
        uint256 k = 0;
        uint256 index;

        for (uint256 i = 0; i < commitsArrayLength; i++) {
            if (!currentCommits[i].revealed) {
                // slash in later phase
                // Stakes.slashDeposit(currentCommits[i].overlay, currentCommits[i].stake);
                Stakes.freezeDeposit(currentCommits[i].overlay, 7 * roundLength * uint256(2**truthRevealedDepth));
                continue;
            } else {
                k++;
                revIndex = currentCommits[i].revealIndex;
                currentSum += currentReveals[revIndex].stakeDensity;
                randomNumber = keccak256(abi.encodePacked(truthSelectionAnchor, k));

                randomNumberTrunc = uint256(randomNumber & MaxH);

                if (randomNumberTrunc * currentSum < currentReveals[revIndex].stakeDensity * (uint256(MaxH) + 1)) {
                    truthRevealedHash = currentReveals[revIndex].hash;
                    truthRevealedDepth = currentReveals[revIndex].depth;
                }
            }
        }

        emit TruthSelected(truthRevealedHash, truthRevealedDepth);

        k = 0;

        string memory winnerSelectionAnchor = currentWinnerSelectionAnchor();

        for (uint256 i = 0; i < commitsArrayLength; i++) {
            revIndex = currentCommits[i].revealIndex;
            if (currentCommits[i].revealed && truthRevealedHash == currentReveals[revIndex].hash && truthRevealedDepth == currentReveals[revIndex].depth) {
                currentWinnerSelectionSum += currentReveals[revIndex].stakeDensity;
                randomNumber = keccak256(abi.encodePacked(winnerSelectionAnchor, k));

                randomNumberTrunc = uint256(randomNumber & MaxH);

                if (
                    randomNumberTrunc * currentWinnerSelectionSum < currentReveals[revIndex].stakeDensity * (uint256(MaxH) + 1)
                ) {
                    winner = currentReveals[revIndex];
                }

                k++;
            } else {
                Stakes.freezeDeposit(currentReveals[revIndex].overlay, 3 * roundLength * uint256(2**truthRevealedDepth));
                // slash ph5
            }
        }

        emit WinnerSelected(winner);

        PostageContract.withdraw(winner.owner);

        OracleContract.adjustPrice(uint256(k));

        currentClaimRound = cr;
    }
}
