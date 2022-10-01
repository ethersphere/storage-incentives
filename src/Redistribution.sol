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
        //
        bool revealed;
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
    //
    bytes32 MaxH = bytes32(0x00000000000000000000000000000000ffffffffffffffffffffffffffffffff);
    //
    bytes32 currentRevealRoundAnchor;
    //
    bytes32 seed;
    //
    uint256 public minimumStake = 100000000000000000;
    //
    uint256 public currentCommitRound;
    //
    uint256 public currentRevealRound;
    //
    uint256 public currentClaimRound;
    //
    uint256 public roundLength = 152;
    //
    Reveal public winner;


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
    event WinnerSelected(Reveal winner);

    /**
     * @dev Emitted when the truth oracle of a round is selected in the claim phase.
     */
    event TruthSelected(bytes32 hash, uint8 depth);

    //these events to be removed after testing phase pending some other usefulness being found
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

    function currentRoundReveals() public view returns (Reveal[] memory ){
        require(currentPhaseClaim() || currentPhaseCommit(), "not in commit or claim phase");
        uint256 cr = currentRound();
        require(cr == currentRevealRound, "round received no reveals");
        return currentReveals;
    }

    /**
     * @notice Commit in a round
     * @dev
     * @param _obfuscatedHash The owner of the new batch.
     * @param _overlay The initial balance per chunk of the batch.
     */
    function commit(bytes32 _obfuscatedHash, bytes32 _overlay) external whenNotPaused {

        require(currentPhaseCommit(), "not in commit phase");
        uint256 nstake = Stakes.stakeOfOverlay(_overlay);
        require(nstake >= minimumStake, "node must have staked at least minimum stake");

        require(Stakes.lastUpdatedBlockNumberOfOverlay(_overlay) < block.number - 2*roundLength, "node must have staked before last round");

    	uint256 cr = currentRound();

    	if ( cr != currentCommitRound ) {
    		delete currentCommits;
    		currentCommitRound = cr;
    	}

        uint commitsArrayLength = currentCommits.length;

        // check can only commit once
        for(uint i=0; i<commitsArrayLength; i++) {
            require(currentCommits[i].overlay != _overlay, "participant already committed in this round");
        }

        currentCommits.push(Commit({
            owner: msg.sender,
            overlay: _overlay,
            stake: nstake,
            obfuscatedHash: _obfuscatedHash,
            revealed: false
        }));

    }

    function currentSeed() public view returns (bytes32) {
        uint256 cr = currentRound();
        bytes32 currentSeedValue = seed;

        if ( cr > currentRevealRound + 1 ) {
            uint256 difference = cr - currentRevealRound - 1;
            currentSeedValue = keccak256(abi.encodePacked(currentSeedValue, difference));
        }

        return currentSeedValue;
    }

    function nextSeed() public view returns (bytes32) {
        uint256 cr = currentRound() + 1;
        bytes32 currentSeedValue = seed;

        if ( cr > currentRevealRound + 1 ) {
            uint256 difference = cr - currentRevealRound - 1;
            currentSeedValue = keccak256(abi.encodePacked(currentSeedValue, difference));
        }

        return currentSeedValue;
    }

    //
    //

    function updateRandomness() private {
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
        return keccak256(abi.encodePacked(_overlay, _depth, _hash, revealNonce));
    }

    //
    //

    function reveal(bytes32 _overlay, uint8 _depth, bytes32 _hash, bytes32 _revealNonce) external whenNotPaused {
        require(currentPhaseReveal(), "not in reveal phase");

        uint256 cr = currentRound();

        require(cr == currentCommitRound, "round received no commits");
        if ( cr != currentRevealRound ) {
            currentRevealRoundAnchor = currentRoundAnchor();
            delete currentReveals;
            currentRevealRound = cr;
            currentRevealRound = cr;
        }

        bytes32 commitHash = wrapCommit(_overlay, _depth, _hash, _revealNonce);

        uint commitsArrayLength = currentCommits.length;

        for(uint i=0; i<commitsArrayLength; i++) {

            if ( currentCommits[i].overlay == _overlay && commitHash == currentCommits[i].obfuscatedHash ) {

                require( inProximity(currentCommits[i].overlay, currentRevealRoundAnchor, _depth), "anchor out of self reported depth");
                //check can only revealed once
                require( currentCommits[i].revealed == false, "participant already revealed");
                currentCommits[i].revealed = true;

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

    //
    //

    function isWinner(bytes32 _overlay) public view returns (bool) {
        require(currentPhaseClaim(), "winner not determined yet");
        uint256 cr = currentRound();
        require(cr == currentRevealRound, "round received no reveals");

        require(cr > currentClaimRound, "round already received successful claim");

        string memory truthSelectionAnchor = currentTruthSelectionAnchor();

        uint256 currentSum;
        uint256 currentWinnerSelectionSum;
        bytes32 winnerIs;
        bytes32 randomNumber;
        uint256 randomNumberTrunc;

        bytes32 truthRevealedHash;
        uint8 truthRevealedDepth;

        for(uint i=0; i<currentReveals.length; i++) {
            currentSum += currentReveals[i].stakeDensity;
            randomNumber = keccak256(abi.encodePacked(truthSelectionAnchor, i));
            randomNumberTrunc = uint256(randomNumber & MaxH);

            if ( randomNumberTrunc * currentSum < currentReveals[i].stakeDensity * ( uint256(MaxH) + 1 ) ) {
                truthRevealedHash = currentReveals[i].hash;
                truthRevealedDepth = currentReveals[i].depth;
            }
        }

        string memory winnerSelectionAnchor = currentWinnerSelectionAnchor();

        uint k = 0;
        for(uint i=0; i<currentReveals.length; i++) {
            if ( truthRevealedHash == currentReveals[i].hash && truthRevealedDepth == currentReveals[i].depth ) {

                currentWinnerSelectionSum += currentReveals[i].stakeDensity;
                randomNumber = keccak256(abi.encodePacked(winnerSelectionAnchor, k));

                randomNumberTrunc = uint256(randomNumber & MaxH);

                if ( randomNumberTrunc * currentWinnerSelectionSum < currentReveals[i].stakeDensity * ( uint256(MaxH) + 1 ) ) {
                    winnerIs = currentReveals[i].overlay;
                }

                k++;
            }
        }

        return (winnerIs == _overlay);
    }

    function isParticipatingInUpcomingRound(bytes32 overlay, uint8 depth) public view returns (bool){
        require(currentPhaseClaim() || currentPhaseCommit(), "not determined for upcoming round yet");
        require(Stakes.lastUpdatedBlockNumberOfOverlay(overlay) < block.number - 2 * roundLength, "stake updated recently");
        require(Stakes.stakeOfOverlay(overlay) >= minimumStake, "stake amount does not meet minimum");
        return inProximity(overlay, currentRoundAnchor(), depth);
    }


    function currentTruthSelectionAnchor() private view returns (string memory){
        require(currentPhaseClaim(), "not determined for current round yet");
        uint256 cr = currentRound();
        require(cr == currentRevealRound, "round received no reveals");

        return string(abi.encodePacked(seed, "0"));
    }

    function currentWinnerSelectionAnchor() private view returns (string memory){
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

        uint commitsArrayLength = currentCommits.length;
        uint revealsArrayLength = currentReveals.length;

        emit CountCommits(commitsArrayLength);
        emit CountReveals(revealsArrayLength);

        for(uint i=0; i<commitsArrayLength; i++) {
            if ( !currentCommits[i].revealed ) {
                //slash
                Stakes.slashDeposit(currentCommits[i].overlay, currentCommits[i].stake);
                continue;
            }
        }

        for(uint i=0; i<revealsArrayLength; i++){
            currentSum += currentReveals[i].stakeDensity;
            randomNumber = keccak256(abi.encodePacked(truthSelectionAnchor, i));

            randomNumberTrunc = uint256(randomNumber & MaxH);

            // question is whether randomNumber / MaxH < probability
            // where probability is stakeDensity / currentSum
            // to avoid resorting to floating points all divisions should be
            // simplified with multiplying both sides (as long as divisor > 0)
            // randomNumber / (MaxH + 1) < stakeDensity / currentSum
            // ( randomNumber / (MaxH + 1) ) * currentSum < stakeDensity
            // randomNumber * currentSum < stakeDensity * (MaxH + 1)
            if ( randomNumberTrunc * currentSum < currentReveals[i].stakeDensity * ( uint256(MaxH) + 1 ) ) {
                truthRevealedHash = currentReveals[i].hash;
                truthRevealedDepth = currentReveals[i].depth;
            }
        }

        emit TruthSelected(truthRevealedHash, truthRevealedDepth);

        string memory winnerSelectionAnchor = currentWinnerSelectionAnchor();

        uint k = 0;
        for(uint i=0; i<revealsArrayLength; i++) {
            if ( truthRevealedHash == currentReveals[i].hash && truthRevealedDepth == currentReveals[i].depth ) {

                currentWinnerSelectionSum += currentReveals[i].stakeDensity;
                randomNumber = keccak256(abi.encodePacked(winnerSelectionAnchor, k));

                randomNumberTrunc = uint256( randomNumber & MaxH );

                if ( randomNumberTrunc * currentWinnerSelectionSum < currentReveals[i].stakeDensity * (uint256(MaxH) + 1) ) {

                    winner = currentReveals[i];

                }

                k++;
            } else {
                Stakes.freezeDeposit(currentReveals[i].overlay, 7 * roundLength * uint256(2 ** truthRevealedDepth));
                // slash ph5
            }
        }

        emit WinnerSelected(winner);

        PostageContract.withdraw(winner.owner);

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

    //
    //

}
