// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.19;

import "../Staking.sol";

contract TestStakeRegistry is StakeRegistry {
    constructor()
        StakeRegistry(0xa66be4A7De4DfA5478Cb2308469D90115C45aA23, 10, 0x3c8F39EE625fCF97cB6ee22bCe25BE1F1E5A5dE8)
    {}

    function echidna_bzz_is_zero() public view returns (bool) {
        return bzzToken != address(0);
    }
}
