// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.19;

import "../PriceOracle.sol";

contract TestPriceOracle is PriceOracle {
    address bzzToken = 0x942C6684eB9874C63d4ed26Ab0623F951D253081;
    address stamp = 0x9A2F29598CB0787Aa806Bbfb65B82A9e558945E7;

    constructor() PriceOracle(stamp, msg.sender) {}

    function echidna_minimumPrice() public pure returns (bool) {
        return minimumPrice == 1024;
    }

    function echidna_BZZtoken_address() public view returns (bool) {
        return postageStamp.bzzToken() == bzzToken;
    }

    function echidna_stamp_bucket_depth() public view returns (bool) {
        return postageStamp.minimumBucketDepth() > 10;
    }

    function echidna_paused() public view returns (bool) {
        return isPaused == true;
    }

    function echidna_price_lower_min() public view returns (bool) {
        return currentPrice < minimumPrice == false;
    }

    function adjustPrice_check(uint256 val) public {
        if (hasRole(PRICE_UPDATER_ROLE, msg.sender)) {
            try this.adjustPrice(val) {
                /* not reverted */
            } catch {
                assert(false);
            }
        }
    }
}
