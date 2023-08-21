// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.19;

import "../PriceOracle.sol";

contract TestPriceOracle is PriceOracle {
    constructor() PriceOracle(0x9A2F29598CB0787Aa806Bbfb65B82A9e558945E7, msg.sender) {}

    function echidna_minimumPrice() public view returns (bool) {
        return minimumPrice == 1024;
    }

    function echidna_BZZtoken_address() public view returns (bool) {
        return postageStamp.bzzToken() == address(0x942C6684eB9874C63d4ed26Ab0623F951D253081);
    }

    function echidna_paused() public view returns (bool) {
        return isPaused == true;
    }

    function echidna_unpaused() public returns (bool) {
        unPause();
        return isPaused == false;
    }
}
