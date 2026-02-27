// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.19;

import "../TestToken.sol";
import "../Staking.sol";

contract ConstantPriceOracle is IPriceOracle {
    uint32 internal immutable _price;

    constructor(uint32 price_) {
        _price = price_;
    }

    function currentPrice() external view returns (uint32) {
        return _price;
    }
}

/// @notice Echidna harness for basic invariants across TestToken + StakeRegistry.
/// @dev Echidna calls public/external functions on this contract. We keep "actions"
/// non-reverting (by bounding inputs and using low-level calls) so Echidna can build
/// longer sequences.
contract EchidnaStakeRegistryHarness {
    TestToken internal immutable token;
    StakeRegistry internal immutable registry;
    ConstantPriceOracle internal immutable oracle;

    uint256 internal immutable initialSupply;

    // Tracks the committedStake after the last successful stake update.
    uint256 internal lastCommittedStake;

    constructor() {
        // Keep values modest so arithmetic in invariants stays safe.
        initialSupply = 1_000_000_000_000_000_000_000_000; // 1e24

        token = new TestToken("TestToken", "TT", initialSupply);
        oracle = new ConstantPriceOracle(1);
        registry = new StakeRegistry(address(token), 10, address(oracle));

        // Allow the registry to pull our tokens during manageStake().
        token.approve(address(registry), type(uint256).max);
    }

    // -----------------------------
    // Actions (state transitions)
    // -----------------------------

    function act_tokenTransfer(address to, uint256 amount) external {
        if (to == address(0)) return;

        uint256 bal = token.balanceOf(address(this));
        if (bal == 0) return;

        uint256 a = amount % (bal + 1);
        if (a == 0) return;

        token.transfer(to, a);
    }

    function act_manageStake(bytes32 setNonce, uint256 addAmount, uint8 height) external {
        // Keep height small to avoid huge powers of two.
        uint8 h = uint8(height % 16);

        uint256 available = token.balanceOf(address(this));
        if (available == 0) return;

        uint256 a = addAmount % (available + 1);

        // If this is the first stake update, enforce the minimum stake rule
        // (or skip the call when we can't satisfy it).
        uint256 lastUpdated = registry.lastUpdatedBlockNumberOfAddress(address(this));
        if (lastUpdated == 0 && a > 0) {
            uint256 minStake = 100000000000000000 * (2 ** h);
            if (a < minStake) {
                a = minStake;
                if (a > available) return;
            }
        }

        (bool ok, ) = address(registry).call(abi.encodeWithSelector(registry.manageStake.selector, setNonce, a, h));
        if (!ok) return;

        (, uint256 committedStake, , , ) = registry.stakes(address(this));
        lastCommittedStake = committedStake;
    }

    function act_withdrawSurplus() external {
        // withdrawFromStake() can be a no-op, but we keep this action non-reverting.
        (bool ok, ) = address(registry).call(abi.encodeWithSelector(registry.withdrawFromStake.selector));
        ok; // silence unused var warning
    }

    // -----------------------------
    // Properties (checked by Echidna)
    // -----------------------------

    function echidna_token_supply_constant() external view returns (bool) {
        return token.totalSupply() == initialSupply;
    }

    function echidna_token_decimals_16() external view returns (bool) {
        return token.decimals() == 16;
    }

    function echidna_stake_committed_never_decreases() external view returns (bool) {
        (, uint256 committedStake, , , ) = registry.stakes(address(this));
        return committedStake >= lastCommittedStake;
    }

    function echidna_stake_commitment_implies_potential_cover() external view returns (bool) {
        (, , uint256 potentialStake, , ) = registry.stakes(address(this));
        uint256 effective = registry.nodeEffectiveStake(address(this));
        return effective <= potentialStake;
    }
}
