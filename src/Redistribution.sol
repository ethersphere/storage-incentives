// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.1;
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/Pausable.sol";

/**
 * Implement interfaces to PostageStamp contract, PriceOracle contract and Staking contract.
 * For PostageStmap we currently use "withdraw" to withdraw funds from Pot
 * For PriceOracle we use "adjustPrice" to change price of PostageStamps
 * For Staking contract we use "lastUpdatedBlockNumberOfOverlay, freezeDeposit, ownerOfOverlay, stakeOfOverlay"
 */

interface IPostageStamp {
    function withdraw(address beneficiary) external;
}

interface IPriceOracle {
    function adjustPrice(uint256 redundancy) external;
}

interface IStakeRegistry {
    function lastUpdatedBlockNumberOfOverlay(bytes32 overlay) external view returns (uint256);

    function freezeDeposit(bytes32 overlay, uint256 time) external;

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
    IPostageStamp public PostageContract;
    // The address of the linked PriceOracle contract.
    IPriceOracle public OracleContract;
    // The address of the linked Staking contract.
    IStakeRegistry public Stakes;

    // Commits for the current round.
    Commit[] public currentCommits;
    // Reveals for the current round.
    Reveal[] public currentReveals;

    // Role allowed to pause.
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    uint256 public constant penaltyMultiplierDisagreement = 3;
    uint256 public constant penaltyMultiplierNonRevealed = 7;

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

    /**
     * @param staking the address of the linked Staking contract.
     * @param postageContract the address of the linked PostageStamp contract.
     * @param oracleContract the address of the linked PriceOracle contract.
     */
    constructor(address staking, address postageContract, address oracleContract) {
        Stakes = IStakeRegistry(staking);
        PostageContract = IPostageStamp(postageContract);
        OracleContract = IPriceOracle(oracleContract);
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
     * @dev Emits the number of commits and reveals being processed by the claim phase.
     */
    event CountCommitsReveals(uint256 _count, uint256 _count2);

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
        if (number >= roundLength / 4 && number < roundLength / 2) {
            return true;
        }
        return false;
    }

    /**
     * @notice Returns true if current block is during claim phase.
     */
    function currentPhaseClaim() public view returns (bool) {
        if (block.number % roundLength >= roundLength / 2) {
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
    function commit(bytes32 _obfuscatedHash, bytes32 _overlay, uint256 _roundNumber) external whenNotPaused {
        require(currentPhaseCommit(), "not in commit phase");
        require(block.number % roundLength != (roundLength / 4) - 1, "can not commit in last block of phase");
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
    function reveal(bytes32 _overlay, uint8 _depth, bytes32 _hash, bytes32 _revealNonce) external whenNotPaused {
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
                        stakeDensity: currentCommits[i].stake * uint256(2 ** _depth),
                        hash: _hash,
                        depth: _depth
                    })
                );

                emit Revealed(
                    cr,
                    currentCommits[i].overlay,
                    currentCommits[i].stake,
                    currentCommits[i].stake * uint256(2 ** _depth),
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
        require(currentPhaseClaim(), "winner not determined yet");
        uint256 cr = currentRound();
        require(cr == currentRevealRound, "round received no reveals");
        require(cr > currentClaimRound, "round already received successful claim");

        uint256 currentWinnerSelectionSum;
        bytes32 winnerIs;
        bytes32 randomNumber;
        bytes32 truthRevealedHash;
        uint8 truthRevealedDepth;
        uint256 revIndex;
        string memory winnerSelectionAnchor = currentWinnerSelectionAnchor();
        uint256 k = 0;

        // Get current truth
        (truthRevealedHash, truthRevealedDepth) = getCurrentTruth();

        for (uint256 i = 0; i < currentCommits.length; i++) {
            revIndex = currentCommits[i].revealIndex;
            if (
                currentCommits[i].revealed &&
                truthRevealedHash == currentReveals[revIndex].hash &&
                truthRevealedDepth == currentReveals[revIndex].depth
            ) {
                currentWinnerSelectionSum += currentReveals[revIndex].stakeDensity;
                randomNumber = keccak256(abi.encodePacked(winnerSelectionAnchor, k));

                if (
                    uint256(randomNumber & MaxH) * currentWinnerSelectionSum <
                    currentReveals[revIndex].stakeDensity * (uint256(MaxH) + 1)
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
     * @notice Helper function to get this round truth
     * @dev
     */
    function getCurrentTruth() internal view returns (bytes32 Hash, uint8 Depth) {
        uint256 currentSum;
        bytes32 randomNumber;
        uint256 randomNumberTrunc;

        bytes32 truthRevealedHash;
        uint8 truthRevealedDepth;
        uint256 revIndex;
        string memory truthSelectionAnchor = currentTruthSelectionAnchor();

        for (uint256 i = 0; i < currentCommits.length; i++) {
            if (currentCommits[i].revealed) {
                revIndex = currentCommits[i].revealIndex;
                currentSum += currentReveals[revIndex].stakeDensity;
                randomNumber = keccak256(abi.encodePacked(truthSelectionAnchor, i));
                randomNumberTrunc = uint256(randomNumber & MaxH);

                // question is whether randomNumber / MaxH < probability
                // where probability is stakeDensity / currentSum
                // to avoid resorting to floating points all divisions should be
                // simplified with multiplying both sides (as long as divisor > 0)
                // randomNumber / (MaxH + 1) < stakeDensity / currentSum
                // ( randomNumber / (MaxH + 1) ) * currentSum < stakeDensity
                // randomNumber * currentSum < stakeDensity * (MaxH + 1)
                if (randomNumberTrunc * currentSum < currentReveals[revIndex].stakeDensity * (uint256(MaxH) + 1)) {
                    truthRevealedHash = currentReveals[revIndex].hash;
                    truthRevealedDepth = currentReveals[revIndex].depth;
                }
            }
        }

        return (truthRevealedHash, truthRevealedDepth);
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

        uint256 currentWinnerSelectionSum;
        bytes32 randomNumber;
        uint256 randomNumberTrunc;
        bytes32 truthRevealedHash;
        uint8 truthRevealedDepth;
        uint256 revIndex;
        string memory winnerSelectionAnchor = currentWinnerSelectionAnchor();
        uint256 k = 0;

        // Get current truth
        (truthRevealedHash, truthRevealedDepth) = getCurrentTruth();

        for (uint256 i = 0; i < currentCommits.length; i++) {
            revIndex = currentCommits[i].revealIndex;

            // Select winner with valid truth
            if (
                currentCommits[i].revealed &&
                truthRevealedHash == currentReveals[revIndex].hash &&
                truthRevealedDepth == currentReveals[revIndex].depth
            ) {
                currentWinnerSelectionSum += currentReveals[revIndex].stakeDensity;
                randomNumber = keccak256(abi.encodePacked(winnerSelectionAnchor, k));
                randomNumberTrunc = uint256(randomNumber & MaxH);

                if (
                    randomNumberTrunc * currentWinnerSelectionSum <
                    currentReveals[revIndex].stakeDensity * (uint256(MaxH) + 1)
                ) {
                    winner = currentReveals[revIndex];
                }

                k++;
            }

            // Freeze deposit if any truth is false
            if (
                currentCommits[i].revealed &&
                (truthRevealedHash != currentReveals[revIndex].hash ||
                    truthRevealedDepth != currentReveals[revIndex].depth)
            ) {
                Stakes.freezeDeposit(
                    currentReveals[revIndex].overlay,
                    penaltyMultiplierDisagreement * roundLength * uint256(2 ** truthRevealedDepth)
                );
            }

            // Slash deposits if revealed is false
            if (!currentCommits[i].revealed) {
                // slash in later phase (ph5)
                // Stakes.slashDeposit(currentCommits[i].overlay, currentCommits[i].stake);
                Stakes.freezeDeposit(
                    currentCommits[i].overlay,
                    penaltyMultiplierNonRevealed * roundLength * uint256(2 ** truthRevealedDepth)
                );
            }
        }

        // Emit function Events
        emit CountCommitsReveals(currentCommits.length, currentReveals.length);
        emit TruthSelected(truthRevealedHash, truthRevealedDepth);
        emit WinnerSelected(winner);

        // Apply Important state changes
        PostageContract.withdraw(winner.owner);
        OracleContract.adjustPrice(uint256(k));
        currentClaimRound = cr;
    }
}
