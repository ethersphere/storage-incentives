// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.19;

import "../PriceOracle.sol";

contract TestPriceOracle is PriceOracle {
    constructor() PriceOracle(0xa66be4A7De4DfA5478Cb2308469D90115C45aA23, 0x3c8F39EE625fCF97cB6ee22bCe25BE1F1E5A5dE8) {}

    function echidna_minimumPrice() public view returns (bool) {
        return minimumPrice == 1024;
    }

    function echidna_paused() public view returns (bool) {
        return isPaused == true;
    }

    function echidna_unpaused() public returns (bool) {
        this.unPause();
        return isPaused == false;
    }
}
