// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.1;
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "./PostageStamp.sol";
import "./Staking.sol";

// import "hardhat/console.sol";

/**
 * @title Redistribution contract
 * @author The Swarm Authors
 * @dev The redistribution contracts allows users to create and manage postage stamp batches.
 */
contract Redistribution is AccessControl, Pausable {

	struct Commit {
        //
        bytes32 overlay;
        // Owner of this commit
        address owner;
        // Normalised balance per chunk.
        uint256 stake;
        //
        bytes32 obfuscatedHash;
    }


    struct Reveal {
        // Owner of this commit
        address owner;
        //
        bytes32 overlay;
        // Normalised balance per chunk.
        uint256 stake;
        //
        uint256 stakeDensity;
        //
        bytes32 hash;
        //
        uint8 depth;
    }

    //
    PostageStamp public PostageContract;
    //
    StakeRegistry public Stakes;
    //
    Commit[] public currentCommits;
    //
    Reveal[] public currentReveals;

    //
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    // can keccack256 actually produce all of the f's?
    bytes32 MaxH = bytes32(0x00000000000000000000000000000000ffffffffffffffffffffffffffffffff);
    //
    bytes32 currentRevealRoundAnchor;
    //
    bytes32 seed;
    //
    uint256 public minimumStake = 10000000000000000;
    //
    uint256 public currentCommitRound;
    //
    uint256 public currentRevealRound;
    //
    uint256 public currentClaimRound;
    //
    uint256 public currentRandomnessRound;
    //
    address public Winner;
    //
    uint256 public roundLength = 152;

    /**
     * @param staking the registry used by this contract
     */
    constructor(address staking, address postageContract) {
        Stakes = StakeRegistry(staking);
        PostageContract = PostageStamp(postageContract);
        _setupRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _setupRole(PAUSER_ROLE, msg.sender);
    }

    /**
     * @dev Emitted when the winner of a round is selected in the claim phase.
     */
    event WinnerSelected(address winner);

    /**
     * @dev Emitted when the truth oracle of a round is selected in the claim phase.
     */
    event TruthSelected(bytes32 hash, uint8 depth);

    event SlashedNotRevealed(bytes32 slashed);
    event FrozenDoesNotMatchTruth(bytes32 slashed);
    event CountCommits(uint256 _count);
    event CountReveals(uint256 _count);
    event Log(string l);
    event LogBytes32(string l, bytes32 b);

    function currentRound() public view returns (uint256) {
        return ( block.number / roundLength );
    }

    function currentPhaseCommit() public view returns (bool){
        if ( block.number % roundLength < roundLength / 4 ) {
            return true;
        }
        return false;
    }

    function currentPhaseReveal() public view returns (bool){
        uint256 number = block.number % roundLength;
        if ( number >= roundLength / 4 && number <= roundLength / 2 ) {
            return true;
        }
        return false;
    }

    function currentPhaseClaim() public view returns (bool){
        if ( block.number % roundLength > roundLength / 2 ) {
            return true;
        }
        return false;
    }

    /**
     * @notice Commit in a round
     * @dev
     * @param _obfuscatedHash The owner of the new batch.
     * @param _overlay The initial balance per chunk of the batch.
     */
    function commit(bytes32 _obfuscatedHash, bytes32 _overlay) external whenNotPaused {

        // should only allow one commit per staked overlay

        require(currentPhaseCommit(), "not in commit phase");

        require(Stakes.lastUpdatedBlockNumberOfOverlay(_overlay) < block.number - roundLength, "node must have staked before last round");

    	uint256 cr = currentRound();
        //check can only commit once?

    	if ( cr != currentCommitRound ) {
    		delete currentCommits;
    		currentCommitRound = cr;
    	}

        uint256 nstake = Stakes.stakeOfOverlay(_overlay);
        require(nstake >= minimumStake, "node must have staked at least minimum stake");

        // get overlay from msg
        // require get overlay from staking contract
    	// write into a current committed nodes struct-array

        // map instead
        currentCommits.push(Commit({
            owner: msg.sender,
            overlay: _overlay,
            stake: nstake,
            obfuscatedHash: _obfuscatedHash
        }));

    }

    function currentSeed() public view returns (bytes32) {
        // <sig
        //should not be a write function
        //iterates at end of reveal period
        //should have been set by the last reveal during the reveal period
        //if there are any skipped rounds since the last claim round, increment
        //the rounds-skipped nonce that is hashed together with the seed to create the current random value
        // sig>

        uint256 cr = currentRound();
        bytes32 currentSeedValue = seed;

        if ( cr > currentRandomnessRound + 1 ) {
            uint256 difference = cr - currentRandomnessRound - 1;
            currentSeedValue = keccak256(abi.encodePacked(currentSeedValue, difference));
        }

        return currentSeedValue;
    }


    function nextSeed() public view returns (bytes32) {
        // <sig
        //should not be a write function
        //iterates at end of reveal period
        //should have been set by the last reveal during the reveal period
        //if there are any skipped rounds since the last claim round, increment
        //the rounds-skipped nonce that is hashed together with the seed to create the current random value
        // sig>

        uint256 cr = currentRound() + 1;
        bytes32 currentSeedValue = seed;

        if ( cr > currentRandomnessRound + 1 ) {
            uint256 difference = cr - currentRandomnessRound - 1;
            currentSeedValue = keccak256(abi.encodePacked(currentSeedValue, difference));
        }

        return currentSeedValue;
    }

    // <sig
    //set nonce function: random seed, reserve commitment hash, number of skipped rounds since claim, nonce for seed for different purpose?
    // sig>
    //

    function updateRandomness() public {
        seed = keccak256(abi.encode(seed, block.difficulty));
    }

    //
    //

    function inProximity(bytes32 A, bytes32 B, uint8 minimum) public pure returns (bool) {
        return uint256(A ^ B) < uint256(2 ** (256 - minimum));
    }

    //
    //

    function wrapCommit(bytes32 _overlay, uint8 _depth, bytes32 _hash, bytes32 revealNonce) public pure returns(bytes32){
        return keccak256(abi.encode(_overlay, _depth, _hash, revealNonce));
    }

    //
    //

    function reveal(bytes32 _overlay, uint8 _depth, bytes32 _hash, bytes32 revealNonce) external whenNotPaused {
        // <sig
        //on every reveal, update nextSelectionAnchorSeed
        //once the reveal period is over, we now know that the currentSelectionAnchorSeed must be the nextSelectionAnchorSeed
        //then, in the commit phase, for all commits, then if the currentSelectionAnchorSeed != nextSelectionAnchorSeed
        //then let currentSelectionAnchorSeed = nextSelectionAnchorSeed
        //and, there can be a view only accessor, which determines what phase we are in and selects either the currentSelectionAnchorSeed
        //or the nextSelectionAnchorSeed based on whether there have been any commits
        // sig>

        require(currentPhaseReveal(), "not in reveal phase");

        uint256 cr = currentRound();

        require(cr == currentCommitRound, "round received no commits");
        if ( cr != currentRevealRound ) {
            currentRevealRoundAnchor = currentRoundAnchor();
            //check can only revealed once
            delete currentReveals;
            currentRevealRound = cr;
            currentRandomnessRound = cr;
        }

        bytes32 commitHash = wrapCommit(_overlay, _depth, _hash, revealNonce);

        uint commitsArrayLength = currentCommits.length;

        for(uint i=0; i<commitsArrayLength; i++) {

            if ( currentCommits[i].overlay == _overlay && commitHash == currentCommits[i].obfuscatedHash ) {

                // <sig
                // if using nonce source of randomness
                // update currentRevealNonce with xor of currentRevealNonce with revealed nonce
                // sig>

                // nonce = nonce^revealNonce;
                // currentRandomnessRound = cr;

                //should this be after we check if we are within depth

                require( inProximity(currentCommits[i].overlay, currentRevealRoundAnchor, _depth), "anchor out of self reported depth");

                currentReveals.push(Reveal({
                    owner: currentCommits[i].owner,
                    overlay: currentCommits[i].overlay,
                    stake: currentCommits[i].stake,
                    stakeDensity: currentCommits[i].stake * uint256(2 ** _depth),
                    hash: _hash,
                    depth: _depth
                }));

                updateRandomness();

                return;

            }

        }

        require(false, "no matching commit or hash");
    }

    //<sig
    function isWinner(bytes32 _overlay) public view returns (bool) {
        //check if overlay has stake
        //check if overlay is slashed
        require(currentPhaseClaim(), "winner not determined yet");
        uint256 cr = currentRound();
        require(cr == currentRevealRound, "round received no reveals");

        require(cr > currentClaimRound, "round already received successful claim");

        string memory truthSelectionAnchor = currentTruthSelectionAnchor();

        bool revealed;
        uint revealIndex;

        uint256 currentSum;
        uint256 currentWinnerSelectionSum;
        bytes32 winner;
        bytes32 randomNumber;
        uint256 randomNumberTrunc;

        bytes32 truthRevealedHash;
        uint8 truthRevealedDepth;

        for(uint i=0; i<currentCommits.length; i++) {
            revealed = false;

            for(uint j=0; j<currentReveals.length; j++) {
                if (currentReveals[j].overlay != currentCommits[i].overlay) {
                    continue;
                }
                revealed = true;
                revealIndex = j;
                break;
            }

            if ( revealed ) {
                currentSum += currentReveals[revealIndex].stakeDensity;
                randomNumber = keccak256(abi.encodePacked(truthSelectionAnchor, revealIndex));

                randomNumberTrunc = uint256(randomNumber & MaxH);

                if ( randomNumberTrunc * currentSum < currentReveals[revealIndex].stakeDensity * ( uint256(MaxH) + 1 ) ) {
                    truthRevealedHash = currentReveals[revealIndex].hash;
                    truthRevealedDepth = currentReveals[revealIndex].depth;
                }
            }

        }

        string memory winnerSelectionAnchor = currentWinnerSelectionAnchor();

        uint k = 0;
        for(uint i=0; i<currentReveals.length; i++) {
            if ( truthRevealedHash == currentReveals[i].hash && truthRevealedDepth == currentReveals[i].depth ) {

                currentWinnerSelectionSum += currentReveals[i].stakeDensity;
                randomNumber = keccak256(abi.encodePacked(winnerSelectionAnchor, k));

                randomNumberTrunc = uint256( randomNumber & MaxH );

                if ( randomNumberTrunc * currentWinnerSelectionSum < currentReveals[i].stakeDensity * ( uint256(MaxH) + 1 ) ) {
                    winner = currentReveals[i].overlay;
                }

                k++;
            }
        }

        return (winner == _overlay);
    }

    function isParticipatingInUpcomingRound(bytes32 overlay, uint8 depth) public view returns (bool){
        require(currentPhaseClaim() || currentPhaseCommit(), "not determined for upcoming round yet");
        require(Stakes.lastUpdatedBlockNumberOfOverlay(overlay) < block.number - roundLength, "stake updated recently");
        return inProximity(overlay, currentRoundAnchor(), depth) && Stakes.stakeOfOverlay(overlay) >= minimumStake;
    }


    function currentTruthSelectionAnchor() public view returns (string memory){
        require(currentPhaseClaim(), "not determined for current round yet");
        uint256 cr = currentRound();
        require(cr == currentRevealRound, "round received no reveals");

        return string(abi.encodePacked(seed, "0"));
    }

    function currentWinnerSelectionAnchor() public view returns (string memory){
        require(currentPhaseClaim(), "not determined for current round yet");
        uint256 cr = currentRound();
        require(cr == currentRevealRound, "round received no reveals");

        return string(abi.encodePacked(seed, "1"));
    }

    function currentRoundAnchor() public view returns (bytes32 returnVal){
        uint256 cr = currentRound();

        if (currentPhaseCommit() || cr > currentRevealRound && !currentPhaseClaim()){
            return currentSeed();
        }

        if (currentPhaseReveal() && cr == currentRevealRound){
            require(false, "can't return value after first reveal");
        }

        if (currentPhaseClaim()){
            return nextSeed();
        }
    }

    // function inSelectedNeighbourhood(bytes32 _overlay, uint8 _depth) public view returns (bool) {
    //     //check if overlay has stake
    //     //check if overlay is slashed
    //     //check if is in claim phase and that, if rounds have been skipped since currentClaimRound, increment the nonce that is hashed together w

    //     //uses inProximity
    //     inProximity(_overlay, currentRoundAnchor, _depth);
    //     return true;
    // }

    //use the same reveal seed for the neighbourhood selection
    //sig>

    function claim() external whenNotPaused {
        require(currentPhaseClaim(), "not in claim phase");

        uint256 cr = currentRound();

        require(cr == currentRevealRound, "round received no reveals");
        require(cr > currentClaimRound, "round already received successful claim");

        string memory truthSelectionAnchor = currentTruthSelectionAnchor();

        bool revealed;
        uint revealIndex;

        uint256 currentSum;
        uint256 currentWinnerSelectionSum;
        address winner;
        bytes32 randomNumber;
        uint256 randomNumberTrunc;

        bytes32 truthRevealedHash;
        uint8 truthRevealedDepth;

        uint commitsArrayLength = currentCommits.length;
        uint revealsArrayLength = currentReveals.length;

        emit CountCommits(commitsArrayLength);
        emit CountReveals(revealsArrayLength);

        for(uint i=0; i<commitsArrayLength; i++) {
            revealed = false;

            for(uint j=0; j<revealsArrayLength; j++) {
                if (currentReveals[j].overlay != currentCommits[i].overlay) {
                    continue;
                }
                revealed = true;
                revealIndex = j;
                break;
            }

            if ( !revealed ) {
                //slash
                emit SlashedNotRevealed(currentCommits[i].overlay);
                Stakes.slashDeposit(currentCommits[i].overlay);
                continue;
            }

            if ( revealed ) {
                currentSum += currentReveals[revealIndex].stakeDensity;
                // int128 probability = ABDKMath64x64.divu(stakeDensity, currentSum);
                randomNumber = keccak256(abi.encodePacked(truthSelectionAnchor, revealIndex));
                // int128 chance = ABDKMath64x64.divu(uint256(randomNumber), uint256(maxH));

                randomNumberTrunc = uint256(randomNumber & MaxH);

                // question is whether randomNumber / MaxH < probability
                // where probability is stakeDensity / currentSum
                // to avoid resorting to floating points all divisions should be
                // simplified with multiplying both sides (as long as divisor > 0)
                // randomNumber / (MaxH + 1) < stakeDensity / currentSum
                // ( randomNumber / (MaxH + 1) ) * currentSum < stakeDensity
                // randomNumber * currentSum < stakeDensity * (MaxH + 1)
                if ( randomNumberTrunc * currentSum < currentReveals[revealIndex].stakeDensity * ( uint256(MaxH) + 1 ) ) {
                    // truthRevealIndex = revealIndex
                    truthRevealedHash = currentReveals[revealIndex].hash;
                    truthRevealedDepth = currentReveals[revealIndex].depth;

                }
            }

        }

        emit TruthSelected(truthRevealedHash, truthRevealedDepth);

        string memory winnerSelectionAnchor = currentWinnerSelectionAnchor();

        uint k = 0;
        for(uint i=0; i<revealsArrayLength; i++) {
            if ( truthRevealedHash == currentReveals[i].hash && truthRevealedDepth == currentReveals[i].depth ) {

                currentWinnerSelectionSum += currentReveals[i].stakeDensity;
                // int128 probability = ABDKMath64x64.divu(stakeDensity, currentWinnerSelectionSum);
                // probability = stakeDensity / currentWinnerSelectionSum
                randomNumber = keccak256(abi.encodePacked(winnerSelectionAnchor, k));
                // int128 chance = ABDKMath64x64.divu(uint256(randomNumber), uint256(maxH));

                randomNumberTrunc = uint256( randomNumber & MaxH );

                if ( randomNumberTrunc * currentWinnerSelectionSum < currentReveals[i].stakeDensity * (uint256(MaxH) + 1) ) {

                    // truthRevealIndex = revealIndex
                    winner = currentReveals[i].owner;

                }

                k++;
            } else {
                emit FrozenDoesNotMatchTruth(currentReveals[i].overlay);
                Stakes.freezeDeposit(currentReveals[i].overlay, 7 * roundLength * uint256(2 ** truthRevealedDepth));
                // slash ph5
            }
        }

        // <sig why? sig>
        // require(msg.sender == winner);

        // access the postage stamp contract to transfer pot to the winner

        emit WinnerSelected(winner);

        //add expire batches to update pot

        PostageContract.withdraw(winner);

        currentClaimRound = cr;

        //<sig
        // given the current "actual storage depth" vs "theoretical reserve depth"
        // change the price in the pricing oracle contract from the current price Pc to Pn using the formula Pn = kSPc
        // where Pn is determined by  multiplying the pricing signal S Ǝ -1 > S > 1 by some constant k Ǝ ℝ+ (eg. 1.1)

        // go through the truth revealers, check they can split without violating the minimum nodes per neighbourhood constraint
        // if there is a zero continuation, then there there is a strong need for price increase to attract more nodes to the neighourhood
        // if there is 1 bit continuation such that the min nodes/ nhood constraint will not be violated there then there is a mild need to reduce the price
        // if there is 2 bit continuation ... then there is a mild need

        // nb: k should be perhaps "tuned" by the foundation until it is corrects
        // nnb: perhaps a linear progression is too strong, and we should implement functionality to prevent the price going exponential
        // nnnb: this could bear some modelling/testing
        // nnnnb: in fact, the hardhat testing env would be great to write these long running models in, separate to the unit tests for CI efficiency
        //sig>

    }

//    function bytes32ToString(bytes32 _bytes32) public pure returns (string memory) {
//        uint8 i = 0;
//        while(i < 32 && _bytes32[i] != 0) {
//            i++;
//        }
//        bytes memory bytesArray = new bytes(i);
//        for (i = 0; i < 32 && _bytes32[i] != 0; i++) {
//            bytesArray[i] = _bytes32[i];
//        }
//        return string(bytesArray);
//    }

}
