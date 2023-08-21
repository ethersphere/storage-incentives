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
    /**
     *@dev Emitted on every price update.
     */
    event PriceUpdate(uint256 price);

    // Role allowed to update price
    bytes32 public constant PRICE_UPDATER_ROLE = keccak256("PRICE_UPDATER");

    // The minimum price allowed
    uint256 public constant minimumPrice = 1024;

    // The current price is the atomic unit.
    uint256 public currentPrice = minimumPrice;

    // Constants used to modulate the price, see below usage
    uint256[] public increaseRate = [0, 1036, 1027, 1025, 1024, 1023, 1021, 1017, 1012];

    uint16 targetRedundancy = 4;
    uint16 maxConsideredExtraRedundancy = 4;

    // When the contract is paused, price changes are not effective
    bool public isPaused = true;

    // The address of the linked PostageStamp contract
    IPostageStamp public postageStamp;

    constructor(address _postageStamp, address multisig) {
        _setupRole(DEFAULT_ADMIN_ROLE, multisig);
        postageStamp = IPostageStamp(_postageStamp);
    }

    /**
     * @notice Manually set the price.
     * @dev Can only be called by the admin role.
     * @param _price The new price.
     */
    function setPrice(uint256 _price) external {
        require(hasRole(DEFAULT_ADMIN_ROLE, msg.sender), "caller is not the admin");
        currentPrice = _price;

        //enforce minimum price
        if (currentPrice < minimumPrice) {
            currentPrice = minimumPrice;
        }

        postageStamp.setPrice(currentPrice);
        emit PriceUpdate(currentPrice);
    }

    /**
     * @notice Pause the contract.
     * @dev Can only be called by the admin role.
     */
    function pause() external {
        require(hasRole(DEFAULT_ADMIN_ROLE, msg.sender), "caller is not the admin");
        isPaused = true;
    }

    /**
     * @notice Unpause the contract.
     * @dev Can only be called by the admin role.
     */
    function unPause() public {
        require(hasRole(DEFAULT_ADMIN_ROLE, msg.sender), "caller is not the admin");
        isPaused = false;
    }

    /**
     * @notice Automatically adjusts the price, called from the Redistribution contract
     * @dev The ideal redundancy in Swarm is 4 nodes per neighbourhood. Each round, the
     * Redistribution contract reports the current amount of nodes in the neighbourhood
     * who have commited and revealed truthy reserve commitment hashes, this is called
     * the redundancy signal. The target redundancy is 4, so, if the redundancy signal is 4,
     * no action is taken. If the redundancy signal is greater than 4, i.e. there is extra
     * redundancy, a price decrease is applied in order to reduce the incentive to run a node.
     * If the redundancy signal is less than 4, a price increase is applied in order to
     * increase the incentive to run a node. If the redundancy signal is more than 8, we
     * apply the max price decrease as if there were just four extra nodes.
     *
     * Can only be called by the price updater role, this should be set to be the deployed
     * Redistribution contract's address. Rounds down to return an integer.
     */
    function adjustPrice(uint256 redundancy) external {
        if (isPaused == false) {
            require(hasRole(PRICE_UPDATER_ROLE, msg.sender), "caller is not a price updater");

            uint256 multiplier = minimumPrice;
            uint256 usedRedundancy = redundancy;

            // redundancy may not be zero
            require(redundancy > 0, "unexpected zero");

            // enforce maximum considered extra redundancy
            uint16 maxConsideredRedundancy = targetRedundancy + maxConsideredExtraRedundancy;
            if (redundancy > maxConsideredRedundancy) {
                usedRedundancy = maxConsideredRedundancy;
            }

            // use the increaseRate array of constants to determine
            // the rate at which the price will modulate - if usedRedundancy
            // is the target value 4 there is no change, > 4 causes an increase
            // and < 4 a decrease.
            uint256 ir = increaseRate[usedRedundancy];

            // the multiplier is used to ensure whole number
            currentPrice = (ir * currentPrice) / multiplier;

            //enforce minimum price
            if (currentPrice < minimumPrice) {
                currentPrice = minimumPrice;
            }

            postageStamp.setPrice(currentPrice);
            emit PriceUpdate(currentPrice);
        }
    }
}
