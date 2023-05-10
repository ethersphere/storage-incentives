// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "../PostageStamp.sol";

contract PostageStampV2 is PostageStamp {
    // Increments the minimumValidityBlocks value by 1
    function incrementByOne() public {
        minimumValidityBlocks = 17281;
    }
}
