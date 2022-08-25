// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.1;
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
// import "hardhat/console.sol";
import "./Math64x64/abdkMath64x64.sol";

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

    //
    bytes32 maxH = bytes32(0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff);
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
    //
    address public Winner;


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

    function inProximity(bytes32 A, bytes32 B, uint8 minimum) public pure returns (bool) {
        return uint256(A ^ B) < uint256(2 ** (256 - minimum));
    }

    function reveal(bytes32 _hash, uint8 _depth, bytes32 revealNonce, bytes32 _overlay) external whenNotPaused {

        uint256 cr = currentRound();

        if ( cr != currentRevealRound ) {
            delete currentReveals;
            currentRevealRound = cr;
        }

        require(cr == currentCommitRound, "round received no commits");

        bytes32 commitHash = keccak256(abi.encode(_hash, _depth, revealNonce, _overlay));


        uint commitsArrayLength = currentCommits.length;

        for(uint i=0; i<commitsArrayLength; i++) {

            if ( currentCommits[i].overlay == _overlay && commitHash == currentCommits[i].obfuscatedHash ) {

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

        uint commitsArrayLength = currentCommits.length;
        uint revealsArrayLength = currentReveals.length;
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
                continue;
            }

            if ( revealed ) {
                stakeDensity = currentReveals[revealIndex].stake * uint256(2 ** currentReveals[revealIndex].depth);
                currentSum += stakeDensity;
                int128 probability = ABDKMath64x64.divu(stakeDensity, currentSum);
                randomNumber = keccak256(abi.encodePacked(truthSelectionAnchor, revealIndex));
                int128 chance = ABDKMath64x64.divu(uint256(randomNumber), uint256(maxH));
                // question is whether randomNumber / MaxH < probability 
                // where probability is stakeDensity / currentSum
                // to avoid resorting to floating points all divisions should be simplified with multiplying both sides (as long as divisor > 0)
                // randomNumber / MaxH < stakeDensity / currentSum
                // randomNumber / MaxH * currentSum < stakeDensity
                // randomNumber * currentSum < stakeDensity * MaxH
                if ( chance < probability ) {
                    // truthRevealIndex = revealIndex
                    truthRevealedHash = currentReveals[revealIndex].hash;
                    truthRevealedDepth = currentReveals[revealIndex].depth;
                }

            }


        }

        uint k = 0;
        for(uint i=0; i<revealsArrayLength; i++) {
            if ( truthRevealedHash == currentReveals[i].hash && truthRevealedDepth == currentReveals[i].depth ) {

                stakeDensity = currentReveals[i].stake * uint256(2 ** currentReveals[revealIndex].depth);
                currentWinnerSelectionSum += stakeDensity;
                int128 probability = ABDKMath64x64.divu(stakeDensity, currentWinnerSelectionSum);
                // probability = stakeDensity / currentWinnerSelectionSum
                randomNumber = keccak256(abi.encodePacked(winnerSelectionAnchor, k));
                int128 chance = ABDKMath64x64.divu(uint256(randomNumber), uint256(maxH));

                if ( chance < probability ) {
                    // truthRevealIndex = revealIndex
                    winner = currentReveals[i].owner;
                }

                k++;
            } // else {
                // slash ph4
            //   }
        }

        // require(msg.sender == winner);

        // // // pot.withdraw(winner);

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
