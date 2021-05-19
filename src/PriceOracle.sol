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
        postageStamp.setPrice(_price);
        emit PriceUpdate(_price);
    }
}
