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
    bool public isPaused = false;

    // The number of the last round price adjusting happend
    uint64 public lastAdjustedRound;

    // The minimum price allowed
    uint32 public minimumPriceUpscaled = 24000 << 10; // we upscale it by 2^10

    // The priceBase to modulate the price
    uint32 public priceBase = 524288;

    uint64 public currentPriceUpScaled = minimumPriceUpscaled;

    // Constants used to modulate the price, see below usage
    uint32[9] public changeRate = [524324, 524315, 524306, 524297, 524288, 524279, 524270, 524261, 524252];

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

    constructor(address _postageStamp) {
        _setupRole(DEFAULT_ADMIN_ROLE, msg.sender);
        postageStamp = IPostageStamp(_postageStamp);
        lastAdjustedRound = currentRound();
        PRICE_UPDATER_ROLE = keccak256("PRICE_UPDATER_ROLE");
        emit PriceUpdate(currentPrice());
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

        uint64 _currentPriceUpScaled = _price << 10;
        uint64 _minimumPriceUpscaled = minimumPriceUpscaled;

        // Enforce minimum price
        if (_currentPriceUpScaled < _minimumPriceUpscaled) {
            _currentPriceUpScaled = _minimumPriceUpscaled;
        }
        currentPriceUpScaled = _currentPriceUpScaled;

        // Price in postagestamp is set at 256 so we need to upcast it
        postageStamp.setPrice(uint256(currentPrice()));
        emit PriceUpdate(currentPrice());
    }

    function adjustPrice(uint16 redundancy) external {
        if (isPaused == false) {
            if (!hasRole(PRICE_UPDATER_ROLE, msg.sender)) {
                revert CallerNotPriceUpdater();
            }

            uint16 usedRedundancy = redundancy;
            uint64 currentRoundNumber = currentRound();

            // Price can only be adjusted once per round
            if (currentRoundNumber <= lastAdjustedRound) {
                revert PriceAlreadyAdjusted();
            }
            // Redundancy may not be zero
            if (redundancy == 0) {
                revert UnexpectedZero();
            }

            // Enforce maximum considered extra redundancy
            uint16 maxConsideredRedundancy = targetRedundancy + maxConsideredExtraRedundancy;
            if (redundancy > maxConsideredRedundancy) {
                usedRedundancy = maxConsideredRedundancy;
            }

            uint64 _currentPriceUpScaled = currentPriceUpScaled;
            uint64 _minimumPriceUpscaled = minimumPriceUpscaled;
            uint32 _priceBase = priceBase;

            // Set the number of rounds that were skipped
            uint64 skippedRounds = currentRoundNumber - lastAdjustedRound - 1;

            // We first apply the increase/decrease rate for the current round
            uint32 _changeRate = changeRate[usedRedundancy];
            _currentPriceUpScaled = (_changeRate * _currentPriceUpScaled) / _priceBase;

            // If previous rounds were skipped, use MAX price increase for the previous rounds
            if (skippedRounds > 0) {
                _changeRate = changeRate[0];
                for (uint64 i = 0; i < skippedRounds; i++) {
                    _currentPriceUpScaled = (_changeRate * _currentPriceUpScaled) / _priceBase;
                }
            }

            // Enforce minimum price
            if (_currentPriceUpScaled < _minimumPriceUpscaled) {
                _currentPriceUpScaled = _minimumPriceUpscaled;
            }

            currentPriceUpScaled = _currentPriceUpScaled;
            lastAdjustedRound = currentRoundNumber;
            postageStamp.setPrice(uint256(currentPrice()));
            emit PriceUpdate(currentPrice());
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

    /**
     * @notice Return the price downscaled
     */
    function currentPrice() public view returns (uint32) {
        // We downcasted to uint32 and bitshift it by 2^10
        return uint32((currentPriceUpScaled) >> 10);
    }

    /**
     * @notice Return the price downscaled
     */
    function minimumPrice() public view returns (uint32) {
        // We downcasted to uint32 and bitshift it by 2^10
        return uint32((minimumPriceUpscaled) >> 10);
    }
}
