// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.1;
import "@openzeppelin/contracts/access/AccessControl.sol";
import "./PostageStamp.sol";

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

    bytes32 public constant PRICE_UPDATER_ROLE = keccak256("PRICE_UPDATER");

    uint256 public currentPrice;

    uint256 public constant minimumPrice = 2 ** 10;

    uint256[] public increaseRate = [0, 1069, 1048, 1032, 1024, 1021, 1015, 1003, 980];

    // the address of the postageStamp contract
    PostageStamp public postageStamp;

    constructor(address _postageStamp) {
        _setupRole(DEFAULT_ADMIN_ROLE, msg.sender);
        postageStamp = PostageStamp(_postageStamp);
    }

    /**
     * @notice Update the price on the oracle.
     * @dev Can only be called by the price updater role.
     * @param _price The new price.
     */
    function setPrice(uint256 _price) external {
        require(hasRole(DEFAULT_ADMIN_ROLE, msg.sender), "caller is not the admin");
        currentPrice = _price;
        postageStamp.setPrice(_price);
        emit PriceUpdate(_price);
    }

    function adjustPrice(uint256 redundancy) external {

        require(hasRole(PRICE_UPDATER_ROLE, msg.sender), "caller is not a price updater");

        uint256 multiplier = minimumPrice;
        uint256 usedRedundancy = redundancy;

        require(redundancy > 0, "unexpected zero");

        if ( redundancy > 8 ) {
            usedRedundancy = 8;
        }

        uint256 ir = increaseRate[usedRedundancy];

        currentPrice = ir * currentPrice / multiplier;

        if ( currentPrice < minimumPrice ) {
            currentPrice = minimumPrice;
        }

        postageStamp.setPrice(currentPrice);
        emit PriceUpdate(currentPrice);
    }
}
