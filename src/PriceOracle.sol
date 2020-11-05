// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.7.4;
import "@openzeppelin/contracts/access/AccessControl.sol";

/**
@title PriceOracle contract
@author The Swarm Authors
@dev The price oracle contract emits a price feed using events
*/
contract PriceOracle is AccessControl {
  /**
  @dev Emitted on every price update
  */
  event PriceUpdate(uint256 price);

  bytes32 public constant PRICE_UPDATER_ROLE = keccak256("PRICE_UPDATER");

  constructor() {
    _setupRole(DEFAULT_ADMIN_ROLE, msg.sender);
  }

  /**
  @notice update the prices
  @dev can only be called by accounts with the price updater role
  @param price the new price
  */
  function setPrice(uint256 price) external {
    require(hasRole(PRICE_UPDATER_ROLE, msg.sender), "caller is not a price updater");
    emit PriceUpdate(price);
  }
}