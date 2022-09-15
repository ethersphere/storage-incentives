// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.1;
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
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
        bytes32 hash;
        //
        uint8 depth;
    }

    //
    Commit[] public currentCommits;
    //
    Reveal[] public currentReveals;

    // can keccack256 actually produce all of the f's?
    bytes32 MaxH = bytes32(0x00000000000000000000000000000000ffffffffffffffffffffffffffffffff);
    //
    bytes32 currentRoundAnchor;
    //
    uint256 public currentCommitRound;
    //
    uint256 public currentRevealRound;
    //
    string public truthSelectionAnchor;
    //
    string public winnerSelectionAnchor;
    //
    bytes32 public truthRevealedHash;
    //
    uint8 public truthRevealedDepth;

    address truthRevealedOwner;
    //
    address public Winner;

    /**
     * @dev Emitted when the winner of a round is selected in the claim phase.
     */
    event WinnerSelected(address winner);

    /**
     * @dev Emitted when the truth oracle of a round is selected in the claim phase.
     */
    event TruthSelected(address winner, bytes32 hash, uint8 depth);

    event SlashedNotRevealed(bytes32 slashed);

    event CountCommits(uint256 _count);
    event CountReveals(uint256 _count);
    event Log(string l);
    event LogBytes32(string l, bytes32 b);

    function currentRound() public view returns (uint256) {
        return ( block.number / 152 );
    }

    function currentPhaseCommit() public view returns (bool){
        if ( block.number % 152 < 38 ) {
            return true;
        }
        return false;
    }

    function currentPhaseReveal() public view returns (bool){
        uint256 number = block.number % 152;
        if ( number >= 38 && number <= 76 ) {
            return true;
        }
        return false;
    }

    function currentPhaseClaim() public view returns (bool){
        if ( block.number % 152 > 76 ) {
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

    	uint256 cr = currentRound();

    	if ( cr != currentCommitRound ) {
    		delete currentCommits;
    		currentCommitRound = cr;
            currentRoundAnchor = blockhash( ( block.number / 152 ) * 152 );
    	}

        // check the overlay is staked and
        // that the msg sender is staked for that overlay? why? does leaving it open leave utility for hot/cold wallets? i.e. withdraw the pot to a cold wallet but run the node using a hot wallet
        // // // require( staking.Stakes[_overlay].value != 0 && staking.Stakes[_overlay].ethAddress == msg.sender, "can not commit with overlay");

        // get overlay from msg
        // require get overlay from staking contract
    	// write into a current committed nodes struct-array

        // map instead
        currentCommits.push(Commit({
            owner: msg.sender,
            overlay: _overlay,
            stake: 1, // staking.Stakes[overlay].value,
            obfuscatedHash: _obfuscatedHash
        }));
    }

    //
    //

    function inProximity(bytes32 A, bytes32 B, uint8 minimum) public pure returns (bool) {
        return uint256(A ^ B) < uint256(2 ** (256 - minimum));
    }

    function reveal(bytes32 _hash, uint8 _depth, bytes32 revealNonce, bytes32 _overlay) external whenNotPaused {
        uint256 cr = currentRound();

        if ( cr != currentRevealRound ) {
            delete currentReveals;
            currentRevealRound = cr;
            // currentRevealNonce = "0000..."
        }

        require(cr == currentCommitRound, "round received no commits");

        bytes32 commitHash = keccak256(abi.encode(_hash, _depth, revealNonce, _overlay));

        uint commitsArrayLength = currentCommits.length;

        for(uint i=0; i<commitsArrayLength; i++) {

            // Log("ZZZZZ");
            // LogBytes32("ZZZZZ1", _overlay );
            // LogBytes32("ZZZZZ2", currentCommits[i].overlay );
            // LogBytes32("ZZZZZ3", commitHash );
            // LogBytes32("ZZZZZ4", currentCommits[i].obfuscatedHash );

            //fails silently if there are no commits that fit the bill, change it so it scans for a match, stores in variable and requires that there is one?
            if ( currentCommits[i].overlay == _overlay && commitHash == currentCommits[i].obfuscatedHash ) {

                // update currentRevealNonce with xor of currentRevealNonce with revealed nonce

                // require currentCommits[i].owner == msg.sender

                require( inProximity(currentCommits[i].overlay, currentRoundAnchor, _depth), "anchor out of self reported depth");

                currentReveals.push(Reveal({
                    owner: currentCommits[i].owner,
                    overlay: currentCommits[i].overlay,
                    stake: currentCommits[i].stake,
                    hash: _hash,
                    depth: _depth
                }));

            }

        }
    }

    function SelectionAnchor() public view returns (bytes32) {
        return blockhash( ( block.number / 152 ) * 152 + 76 );
    }

    function claim() external whenNotPaused {

        uint256 cr = currentRound();

        require(cr == currentRevealRound, "round received no reveals");
        require(currentPhaseClaim(), "not in claim phase");

        bytes32 baseSelectionAnchor = SelectionAnchor();

        truthSelectionAnchor = string(abi.encodePacked(baseSelectionAnchor, "0"));
        winnerSelectionAnchor = string(abi.encodePacked(baseSelectionAnchor, "1"));

        bool revealed;
        uint revealIndex;

        uint256 currentSum;
        uint256 stakeDensity;
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
                continue;
            }

            if ( revealed ) {
                stakeDensity = currentReveals[revealIndex].stake * uint256(2 ** currentReveals[revealIndex].depth);
                currentSum += stakeDensity;
                // int128 probability = ABDKMath64x64.divu(stakeDensity, currentSum);
                randomNumber = keccak256(abi.encodePacked(truthSelectionAnchor, revealIndex));
                // int128 chance = ABDKMath64x64.divu(uint256(randomNumber), uint256(maxH));

                randomNumberTrunc = uint256(randomNumber & MaxH);

                //leaving this alone for now but i would like to see a mathematical proof this is "fair" **
                //i am concerned that later entries into the array have more chances of winning
                //perhaps this could be alleviated by using the random seed to "shuffle" the array

                // question is whether randomNumber / MaxH < probability
                // where probability is stakeDensity / currentSum
                // to avoid resorting to floating points all divisions should be simplified with multiplying both sides (as long as divisor > 0)
                // randomNumber / MaxH < stakeDensity / currentSum
                // randomNumber / MaxH * currentSum < stakeDensity
                // randomNumber * currentSum < stakeDensity * MaxH
                if ( randomNumberTrunc * currentSum < stakeDensity * uint256(MaxH) ) {
                    // truthRevealIndex = revealIndex
                    truthRevealedOwner = currentReveals[revealIndex].owner;
                    truthRevealedHash = currentReveals[revealIndex].hash;
                    truthRevealedDepth = currentReveals[revealIndex].depth;

                    emit TruthSelected(truthRevealedOwner, truthRevealedHash, truthRevealedDepth);
                }
            }

        }

        //see above **
        uint k = 0;
        for(uint i=0; i<revealsArrayLength; i++) {
            if ( truthRevealedHash == currentReveals[i].hash && truthRevealedDepth == currentReveals[i].depth ) {

                stakeDensity = currentReveals[i].stake * uint256(2 ** currentReveals[revealIndex].depth);
                currentWinnerSelectionSum += stakeDensity;
                // int128 probability = ABDKMath64x64.divu(stakeDensity, currentWinnerSelectionSum);
                // probability = stakeDensity / currentWinnerSelectionSum
                randomNumber = keccak256(abi.encodePacked(winnerSelectionAnchor, k));
                // int128 chance = ABDKMath64x64.divu(uint256(randomNumber), uint256(maxH));

                randomNumberTrunc = uint256( randomNumber & MaxH );

                if ( randomNumberTrunc * currentWinnerSelectionSum < stakeDensity * uint256(MaxH) ) {

                    // truthRevealIndex = revealIndex
                    winner = currentReveals[i].owner;

                    emit WinnerSelected(winner);
                }

                k++;
            } else {
                emit SlashedDoesNotMatchTruth(currentCommits[i].overlay);
                // slash ph4
            }
        }

        // why?
        // require(msg.sender == winner);

        // access the postage stamp contract to transfer pot to the winner
        // // // pot.withdraw(winner);

        // given the current "actual storage depth" vs "theoretical reserve depth"
        // change the price in the pricing oracle contract from the current price Pc to Pn using the formula Pn = kSPc
        // where Pn is determined by  multiplying the pricing signal S Ǝ -1 > S > 1 by some constant k Ǝ ℝ+ (eg. 1.1)


    // for n round of lottery there is at least 4 + E nodes but the storage depth does not exist then there should be a signal because there
    // is consistently more redundancy that is needed

    // when the depth changes we record the number of truth revealers and as long as the storage depth stays the same
    // maybe check that it will be balanced on split

    // ? can it stand the attack where stake is split thus increasing cardinality and lowering price with a node running shared storage
    // does it affect the redundancy vs. value

    // average of last 10 rounds
    //

        // 4+E

        //E excess nodes


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
