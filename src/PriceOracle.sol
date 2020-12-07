// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.7.4;
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

    // the address of the postageStamp contract
    PostageStamp public postageStamp;
    // the price from the last update
    uint256 public lastPrice;
    // the block at which the last update occured
    uint256 public lastUpdatedBlock;

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
        require(hasRole(PRICE_UPDATER_ROLE, msg.sender), "caller is not a price updater");

        // if there was a last price, charge for the time since the last update with the last price
        if(lastPrice != 0) {
            uint256 blocks = block.number - lastUpdatedBlock;
            postageStamp.increaseTotalOutPayment(lastPrice * blocks);
        }

        lastPrice = _price;
        lastUpdatedBlock = block.number;

        emit PriceUpdate(_price);
    }
}
