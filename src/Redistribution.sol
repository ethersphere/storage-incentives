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
    bytes32 currentRoundAnchor;
    //
    bytes32 nonce;
    //
    bytes32 nonce2;
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
    string public truthSelectionAnchor;
    //
    string public winnerSelectionAnchor;
    //
    bytes32 public truthRevealedHash;
    //
    uint8 public truthRevealedDepth;
    //
    address truthRevealedOwner;
    //
    address public Winner;
    //
    uint256 roundLength = 152;

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
    event TruthSelected(address winner, bytes32 hash, uint8 depth);

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

        uint256 nstake = Stakes.stakeOfOverlay(_overlay);
        require( Stakes.lastUpdatedBlockNumberOfOverlay(_overlay) < block.number - roundLength && nstake > minimumStake && Stakes.ownerOfOverlay(_overlay) == msg.sender, "can not commit with overlay");

    	uint256 cr = currentRound();

    	if ( cr != currentCommitRound ) {
    		delete currentCommits;
    		currentCommitRound = cr;
            currentRoundAnchor = currentRandomValue();
    	}

        // <sig
        // wrt to the below, it checks the overlay is non-zero staked, this makes sense
        // however it also checks that the msg sender is staked for that overlay:
        // why is this? i am not sure what extra guarantees we are given
        // perhaps leaving it open would increase utility for user hot/cold wallets?
        // eg. withdraw the winnings to a cold wallet but run the node using a hot wallet
        // sig>


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

        updateRandomness2();
    }

    //
    function currentRandomValue() public returns (bytes32) {

        uint256 cr = currentRound();

        if ( cr > currentRandomnessRound + 1 ) {
            uint256 difference = cr - currentRandomnessRound - 1;
            for (uint i = 0; i < difference; i++) {
                nonce = keccak256(abi.encode(nonce));
            }
            currentRandomnessRound = cr - 1;
        }

        return nonce;
    }

    //
    //

    function updateRandomness2() public {
        nonce2 = keccak256(abi.encode(nonce2, block.difficulty));
    }

    //
    //

    function currentRandomValue2() public view returns (bytes32) {
        return nonce2;
    }

    //
    //

    function inProximity(bytes32 A, bytes32 B, uint8 minimum) public pure returns (bool) {
        return uint256(A ^ B) < uint256(2 ** (256 - minimum));
    }

    //
    //

    function reveal(bytes32 _hash, uint8 _depth, bytes32 revealNonce, bytes32 _overlay) external whenNotPaused {
        uint256 cr = currentRound();

        require(cr == currentCommitRound, "round received no commits");

        if ( cr != currentRevealRound ) {
            delete currentReveals;
            currentRevealRound = cr;
        }

        bytes32 commitHash = keccak256(abi.encode(_hash, _depth, revealNonce, _overlay));

        uint commitsArrayLength = currentCommits.length;

        for(uint i=0; i<commitsArrayLength; i++) {

            //<sig
            //fails silently if there are no commits that fit the bill
            //could we change it to fail with an appropriate error message
            //sig>

            if ( currentCommits[i].overlay == _overlay && commitHash == currentCommits[i].obfuscatedHash ) {

                // <sig
                // if using nonce source of randomness
                // update currentRevealNonce with xor of currentRevealNonce with revealed nonce
                // sig>

                // nonce = nonce^revealNonce;
                // currentRandomnessRound = cr;

                updateRandomness2();

                require( inProximity(currentCommits[i].overlay, currentRoundAnchor, _depth), "anchor out of self reported depth");

                currentReveals.push(Reveal({
                    owner: currentCommits[i].owner,
                    overlay: currentCommits[i].overlay,
                    stake: currentCommits[i].stake,
                    stakeDensity: currentCommits[i].stake * uint256(2 ** _depth),
                    hash: _hash,
                    depth: _depth
                }));

                return;

            }

        }

        require(false, "no matching commit");
    }

    function claim() external whenNotPaused {

        uint256 cr = currentRound();

        require(cr == currentRevealRound, "round received no reveals");
        require(cr > currentClaimRound, "round already received successful claim");

        require(currentPhaseClaim(), "not in claim phase");

        bytes32 baseSelectionAnchor = currentRandomValue2();

        truthSelectionAnchor = string(abi.encodePacked(baseSelectionAnchor, "0"));
        winnerSelectionAnchor = string(abi.encodePacked(baseSelectionAnchor, "1"));

        bool revealed;
        uint revealIndex;

        uint256 currentSum;
        uint256 currentWinnerSelectionSum;
        address winner;
        bytes32 randomNumber;
        uint256 randomNumberTrunc;

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
                // randomNumber / MaxH < stakeDensity / currentSum
                // randomNumber / MaxH * currentSum < stakeDensity
                // randomNumber * currentSum < stakeDensity * MaxH
                if ( randomNumberTrunc * currentSum < currentReveals[revealIndex].stakeDensity * uint256(MaxH) ) {
                    // truthRevealIndex = revealIndex
                    truthRevealedOwner = currentReveals[revealIndex].owner;
                    truthRevealedHash = currentReveals[revealIndex].hash;
                    truthRevealedDepth = currentReveals[revealIndex].depth;

                }
            }

        }

        emit TruthSelected(truthRevealedOwner, truthRevealedHash, truthRevealedDepth);

        uint k = 0;
        for(uint i=0; i<revealsArrayLength; i++) {
            if ( truthRevealedHash == currentReveals[i].hash && truthRevealedDepth == currentReveals[i].depth ) {

                currentWinnerSelectionSum += currentReveals[i].stakeDensity;
                // int128 probability = ABDKMath64x64.divu(stakeDensity, currentWinnerSelectionSum);
                // probability = stakeDensity / currentWinnerSelectionSum
                randomNumber = keccak256(abi.encodePacked(winnerSelectionAnchor, k));
                // int128 chance = ABDKMath64x64.divu(uint256(randomNumber), uint256(maxH));

                randomNumberTrunc = uint256( randomNumber & MaxH );

                if ( randomNumberTrunc * currentWinnerSelectionSum < currentReveals[i].stakeDensity * uint256(MaxH) ) {

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

        PostageContract.withdraw(winner);

        currentRandomnessRound = cr;
        currentClaimRound = cr;
        nonce = bytes32(block.difficulty);

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
