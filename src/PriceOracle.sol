// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.19;
import "@openzeppelin/contracts/access/AccessControl.sol";
import "./interface/IPostageStamp.sol";

/**
 * @title PriceOracle contract.
 * @author The Swarm Authors.
 * @dev The price oracle contract emits a price feed using events.
 */

contract PriceOracle is AccessControl {
    // ----------------------------- State variables ------------------------------

    // The address of the linked PostageStamp contract
    IPostageStamp public postageStamp;

    uint16 targetRedundancy = 4;
    uint16 maxConsideredExtraRedundancy = 4;

    // When the contract is paused, price changes are not effective
    bool public isPaused = true;

    // The number of the last round price adjusting happend
    uint64 public lastAdjustedRound;

    // The minimum price allowed
    uint32 public minimumPrice = 1024;

    // The priceBase to modulate the price
    uint32 public priceBase = 514155;

    // The current price is the atomic unit.
    uint32 public currentPrice = minimumPrice;

    // Constants used to modulate the price, see below usage
    uint32[9] public increaseRate = [514191, 514182, 514173, 514164, 514155, 514146, 514137, 514128, 514119];

    // Role allowed to update price
    bytes32 public immutable PRICE_UPDATER_ROLE;

    // The length of a round in blocks.
    uint8 private constant ROUND_LENGTH = 152;

    // ----------------------------- Events ------------------------------

    /**
     *@dev Emitted on every price update.
     */
    event PriceUpdate(uint256 price);

    // ----------------------------- Custom Errors ------------------------------
    error CallerNotAdmin(); // Caller is not the admin
    error CallerNotPriceUpdater(); // Caller is not a price updater
    error PriceAlreadyAdjusted(); // Price already adjusted in this round
    error UnexpectedZero(); // Redundancy needs to be higher then 0

    // ----------------------------- CONSTRUCTOR ------------------------------

    constructor(address _postageStamp, address multisig) {
        _setupRole(DEFAULT_ADMIN_ROLE, multisig);
        postageStamp = IPostageStamp(_postageStamp);
        lastAdjustedRound = currentRound();
        PRICE_UPDATER_ROLE = keccak256("PRICE_UPDATER_ROLE");
    }

    ////////////////////////////////////////
    //            STATE SETTING           //
    ////////////////////////////////////////

    /**
     * @notice Manually set the price.
     * @dev Can only be called by the admin role.
     * @param _price The new price.
     */ function setPrice(uint32 _price) external {
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
            revert CallerNotAdmin();
        }
        uint32 _currentPrice = _price;
        uint32 _minimumPrice = minimumPrice;

        //enforce minimum price
        if (_currentPrice < _minimumPrice) {
            _currentPrice = _minimumPrice;
        }
        currentPrice = _currentPrice;

        // Price in postagestamp is set at 256 so we need to upcast it
        postageStamp.setPrice(uint256(_currentPrice));
        emit PriceUpdate(_currentPrice);
    }

    function adjustPrice(uint16 redundancy) external {
        if (isPaused == false) {
            if (!hasRole(PRICE_UPDATER_ROLE, msg.sender)) {
                revert CallerNotPriceUpdater();
            }

            uint16 usedRedundancy = redundancy;
            uint64 currentRoundNumber = currentRound();

            // price can only be adjusted once per round
            if (currentRoundNumber <= lastAdjustedRound) {
                revert PriceAlreadyAdjusted();
            }
            // redundancy may not be zero
            if (redundancy == 0) {
                revert UnexpectedZero();
            }

            // enforce maximum considered extra redundancy
            uint16 maxConsideredRedundancy = targetRedundancy + maxConsideredExtraRedundancy;
            if (redundancy > maxConsideredRedundancy) {
                usedRedundancy = maxConsideredRedundancy;
            }

            uint32 _currentPrice = currentPrice;
            uint32 _minimumPrice = minimumPrice;
            uint32 _priceBase = priceBase;

            // Set the number of rounds that were skipped
            uint64 skippedRounds = currentRoundNumber - lastAdjustedRound - 1;

            // We first apply the increase/decrease rate for the current round
            uint32 ir = increaseRate[usedRedundancy];
            _currentPrice = (ir * _currentPrice) / _priceBase;

            // If previous rounds were skipped, use MAX price increase for the previous rounds
            if (skippedRounds > 0) {
                ir = increaseRate[0];
                for (uint64 i = 0; i < skippedRounds; i++) {
                    _currentPrice = (ir * _currentPrice) / _priceBase;
                }
            }

            // Enforce minimum price
            if (_currentPrice < _minimumPrice) {
                _currentPrice = _minimumPrice;
            }
            currentPrice = _currentPrice;

            postageStamp.setPrice(_currentPrice);
            lastAdjustedRound = currentRoundNumber;
            emit PriceUpdate(_currentPrice);
        }
    }

    function pause() external {
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
            revert CallerNotAdmin();
        }
        isPaused = true;
    }

    function unPause() external {
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
            revert CallerNotAdmin();
        }
        isPaused = false;
    }

    ////////////////////////////////////////
    //            STATE READING           //
    ////////////////////////////////////////

    /**
     * @notice Return the number of the current round.
     */
    function currentRound() public view returns (uint64) {
        // We downcasted to uint64 as uint64 has 18,446,744,073,709,551,616 places
        // as each round is 152 x 5 = 760, each day has around 113 rounds which is 41245 in a year
        // it results 4.4724801e+14 years to run this game
        return uint64(block.number / uint256(ROUND_LENGTH));
    }
}
