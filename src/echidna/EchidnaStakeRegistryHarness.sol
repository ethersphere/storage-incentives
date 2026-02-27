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

    // Tracks the inputs that should determine the current overlay.
    bytes32 internal lastSetNonce;
    uint64 internal trackedNetworkId;
    uint64 internal networkIdAtLastStake;

    constructor() {
        // Keep values modest so arithmetic in invariants stays safe.
        initialSupply = 1_000_000_000_000_000_000_000_000; // 1e24

        token = new TestToken("TestToken", "TT", initialSupply);
        oracle = new ConstantPriceOracle(1);
        trackedNetworkId = 10;
        networkIdAtLastStake = trackedNetworkId;
        registry = new StakeRegistry(address(token), trackedNetworkId, address(oracle));

        // Allow the registry to pull our tokens during manageStake().
        token.approve(address(registry), type(uint256).max);
    }

    // -----------------------------
    // Actions (state transitions)
    // -----------------------------

    function act_tokenTransfer(address to, uint256 amount) external {
        if (to == address(0)) return;
        if (to == address(registry)) return;
        if (to == address(token)) return;

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
        lastSetNonce = setNonce;
        networkIdAtLastStake = trackedNetworkId;
    }

    function act_withdrawSurplus() external {
        // withdrawFromStake() can be a no-op, but we keep this action non-reverting.
        (bool ok, ) = address(registry).call(abi.encodeWithSelector(registry.withdrawFromStake.selector));
        ok; // silence unused var warning
    }

    function act_pause() external {
        (bool ok, ) = address(registry).call(abi.encodeWithSelector(registry.pause.selector));
        ok;
    }

    function act_unpause() external {
        (bool ok, ) = address(registry).call(abi.encodeWithSelector(registry.unPause.selector));
        ok;
    }

    function act_changeNetworkId(uint64 newNetworkId) external {
        (bool ok, ) = address(registry).call(abi.encodeWithSelector(registry.changeNetworkId.selector, newNetworkId));
        if (!ok) return;
        trackedNetworkId = newNetworkId;
    }

    // -----------------------------
    // Properties (checked by Echidna)
    // -----------------------------

    function echidna_stake_committed_never_decreases() external view returns (bool) {
        (, uint256 committedStake, , , ) = registry.stakes(address(this));
        return committedStake >= lastCommittedStake;
    }

    function echidna_registry_token_is_expected() external view returns (bool) {
        return registry.bzzToken() == address(token);
    }

    function echidna_registry_balance_covers_potential() external view returns (bool) {
        (, , uint256 potentialStake, , ) = registry.stakes(address(this));
        return token.balanceOf(address(registry)) >= potentialStake;
    }

    function echidna_withdrawable_matches_effective_math() external view returns (bool) {
        (, uint256 committedStake, uint256 potentialStake, , uint8 h) = registry.stakes(address(this));

        uint256 effective = _min(potentialStake, committedStake * (1 << h) * uint256(oracle.currentPrice()));
        uint256 expectedWithdrawable = potentialStake - effective;

        return registry.withdrawableStake() == expectedWithdrawable;
    }

    function echidna_nodeEffective_matches_freeze_rule() external view returns (bool) {
        (, uint256 committedStake, uint256 potentialStake, , uint8 h) = registry.stakes(address(this));
        uint256 lastUpdated = registry.lastUpdatedBlockNumberOfAddress(address(this));
        uint256 fromView = registry.nodeEffectiveStake(address(this));

        if (lastUpdated >= block.number) {
            return fromView == 0;
        }

        uint256 expected = _min(potentialStake, committedStake * (1 << h) * uint256(oracle.currentPrice()));
        return fromView == expected;
    }

    function echidna_stake_empty_state_is_zeroed() external view returns (bool) {
        (bytes32 overlay, uint256 committedStake, uint256 potentialStake, uint256 lastUpdated, uint8 h) = registry
            .stakes(address(this));
        if (lastUpdated != 0) return true;
        return overlay == bytes32(0) && committedStake == 0 && potentialStake == 0 && h == 0;
    }

    function echidna_overlay_matches_nonce_and_network() external view returns (bool) {
        (bytes32 overlay, , , uint256 lastUpdated, ) = registry.stakes(address(this));
        if (lastUpdated == 0) return true;
        return overlay == keccak256(abi.encodePacked(address(this), _reverse(networkIdAtLastStake), lastSetNonce));
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    function _reverse(uint64 input) internal pure returns (uint64 v) {
        v = input;
        v = ((v & 0xFF00FF00FF00FF00) >> 8) | ((v & 0x00FF00FF00FF00FF) << 8);
        v = ((v & 0xFFFF0000FFFF0000) >> 16) | ((v & 0x0000FFFF0000FFFF) << 16);
        v = (v >> 32) | (v << 32);
    }
}
