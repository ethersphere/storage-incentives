// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "./MockPostageStamp.sol";

contract PostageStampV3 is PostageStampV2 {
    string public testString;
    event StringChanged(string value);

    function setString(string memory _value) public {
        testString = _value;
        emit StringChanged(testString);
    }
}
