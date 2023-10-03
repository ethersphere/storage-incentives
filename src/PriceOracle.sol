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
    uint32 public lastAdjustedRound;

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
        PRICE_UPDATER_ROLE = keccak256("PRICE_UPDATER");
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
        currentPrice = _price;
        uint32 _currentPrice = currentPrice;

        //enforce minimum price
        if (_currentPrice < minimumPrice) {
            _currentPrice = minimumPrice;
        }

        // Price in postagestamp is set at 256 so we need to upcast it
        postageStamp.setPrice(uint256(_currentPrice));
        emit PriceUpdate(_currentPrice);
    }

    function adjustPrice(uint32 redundancy) external {
        if (isPaused == false) {
            if (!hasRole(PRICE_UPDATER_ROLE, msg.sender)) {
                revert CallerNotPriceUpdater();
            }

            uint32 usedRedundancy = redundancy;
            uint32 currentRoundNumber = currentRound();

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

            // Set the number of rounds that were skipped
            uint32 skippedRounds = currentRoundNumber - lastAdjustedRound - 1;

            // We first apply the increase/decrease rate for the current round
            uint32 ir = increaseRate[usedRedundancy];
            currentPrice = (ir * currentPrice) / priceBase;

            // If previous rounds were skipped, use MAX price increase for the previous rounds
            if (skippedRounds > 0) {
                ir = increaseRate[0];
                for (uint32 i = 0; i < skippedRounds; i++) {
                    currentPrice = (ir * currentPrice) / priceBase;
                }
            }

            // Enforce minimum price
            if (currentPrice < minimumPrice) {
                currentPrice = minimumPrice;
            }

            postageStamp.setPrice(currentPrice);
            lastAdjustedRound = currentRoundNumber;
            emit PriceUpdate(currentPrice);
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
    function currentRound() public view returns (uint32) {
        return uint32(block.number / uint256(ROUND_LENGTH));
    }
}
