// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.19;

/**
 * @dev Simple implementation contract used in proxy/registry integration tests.
 */
contract SampleImplementation {
    uint256 public value;
    address public lastCaller;

    event ValueSet(uint256 value, address caller);

    function setValue(uint256 _value) external {
        value = _value;
        lastCaller = msg.sender;
        emit ValueSet(_value, msg.sender);
    }
}

/**
 * @dev Upgraded version with extra storage — used to test proxy upgrades
 *      and registry version transitions.
 */
contract SampleImplementationV2 {
    uint256 public value;
    address public lastCaller;
    uint256 public extra;

    event ValueSet(uint256 value, address caller);
    event ExtraSet(uint256 extra);

    function setValue(uint256 _value) external {
        value = _value;
        lastCaller = msg.sender;
        emit ValueSet(_value, msg.sender);
    }

    function setExtra(uint256 _extra) external {
        extra = _extra;
        emit ExtraSet(_extra);
    }
}
