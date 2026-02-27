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

contract EchidnaStakeActor {
    TestToken internal immutable token;
    StakeRegistry internal immutable registry;

    constructor(TestToken token_, StakeRegistry registry_) {
        token = token_;
        registry = registry_;
        token.approve(address(registry), type(uint256).max);
    }

    function manageStake(bytes32 setNonce, uint256 addAmount, uint8 height) external returns (bool ok) {
        (ok, ) = address(registry).call(abi.encodeWithSelector(registry.manageStake.selector, setNonce, addAmount, height));
    }

    function withdrawFromStake() external returns (bool ok) {
        (ok, ) = address(registry).call(abi.encodeWithSelector(registry.withdrawFromStake.selector));
    }

    function migrateStake() external returns (bool ok) {
        (ok, ) = address(registry).call(abi.encodeWithSelector(registry.migrateStake.selector));
    }

    function tryPause() external returns (bool ok) {
        (ok, ) = address(registry).call(abi.encodeWithSelector(registry.pause.selector));
    }

    function tryUnpause() external returns (bool ok) {
        (ok, ) = address(registry).call(abi.encodeWithSelector(registry.unPause.selector));
    }

    function tryChangeNetworkId(uint64 newNetworkId) external returns (bool ok) {
        (ok, ) = address(registry).call(abi.encodeWithSelector(registry.changeNetworkId.selector, newNetworkId));
    }

    function tryFreezeDeposit(address owner, uint256 time) external returns (bool ok) {
        (ok, ) = address(registry).call(abi.encodeWithSelector(registry.freezeDeposit.selector, owner, time));
    }

    function trySlashDeposit(address owner, uint256 amount) external returns (bool ok) {
        (ok, ) = address(registry).call(abi.encodeWithSelector(registry.slashDeposit.selector, owner, amount));
    }
}

/// @notice Echidna harness for stateful, multi-actor fuzzing of StakeRegistry.
/// @dev Echidna calls public/external functions on this contract.
contract EchidnaStakeRegistryHarness {
    TestToken internal immutable token;
    StakeRegistry internal immutable registry;
    ConstantPriceOracle internal immutable oracle;

    uint256 internal immutable initialSupply;

    uint256 internal constant MIN_STAKE = 100000000000000000; // 1e17 (matches StakeRegistry)
    uint32 internal constant ORACLE_PRICE = 1;

    uint256 internal constant ACTOR_COUNT = 3;
    EchidnaStakeActor[3] internal actors;
    EchidnaStakeActor internal redistributor;

    uint64 internal trackedNetworkId;

    // Tracking per-actor last successful state.
    uint256[3] internal lastCommittedStakeByActor;
    bytes32[3] internal lastSetNonceByActor;
    uint64[3] internal networkIdAtLastStakeByActor;

    // “Must never happen” flags (set by actions, checked by properties).
    bool internal unauthorizedAdminCallSucceeded;
    bool internal unauthorizedFreezeSlashSucceeded;
    bool internal pausedManageStakeSucceeded;
    bool internal frozenManageStakeSucceeded;
    bool internal actionInvariantViolated;

    constructor() {
        // Keep values modest so arithmetic in invariants stays safe.
        initialSupply = 1_000_000_000_000_000_000_000_000; // 1e24

        token = new TestToken("TestToken", "TT", initialSupply);
        oracle = new ConstantPriceOracle(ORACLE_PRICE);
        trackedNetworkId = 10;
        registry = new StakeRegistry(address(token), trackedNetworkId, address(oracle));

        // Create actors and fund them.
        for (uint256 i = 0; i < ACTOR_COUNT; i++) {
            actors[i] = new EchidnaStakeActor(token, registry);
            token.transfer(address(actors[i]), initialSupply / 20); // 5% each
            networkIdAtLastStakeByActor[i] = trackedNetworkId;
        }

        // A dedicated redistributor actor (role granted by admin = this harness).
        redistributor = new EchidnaStakeActor(token, registry);
        registry.grantRole(registry.REDISTRIBUTOR_ROLE(), address(redistributor));
    }

    // -----------------------------
    // Actions (state transitions)
    // -----------------------------

    function act_fundActor(uint8 actorId, uint256 amount) external {
        EchidnaStakeActor a = _actor(actorId);
        uint256 bal = token.balanceOf(address(this));
        if (bal == 0) return;
        uint256 x = amount % (bal + 1);
        if (x == 0) return;
        token.transfer(address(a), x);
    }

    function act_actor_manageStake(uint8 actorId, bytes32 setNonce, uint256 addAmount, uint8 height) external {
        EchidnaStakeActor actor = _actor(actorId);
        // Keep height small to avoid huge powers of two.
        uint8 h = uint8(height % 16);

        uint256 available = token.balanceOf(address(actor));
        if (available == 0) return;

        uint256 add = addAmount % (available + 1);

        // If this is the first stake update, enforce the minimum stake rule
        // (or skip the call when we can't satisfy it).
        uint256 lastUpdated = registry.lastUpdatedBlockNumberOfAddress(address(actor));
        if (lastUpdated == 0 && add > 0) {
            uint256 minStake = MIN_STAKE * (1 << h);
            if (add < minStake) {
                add = minStake;
                if (add > available) return;
            }
        }

        // If paused, manageStake must not succeed.
        if (registry.paused()) {
            bool okPaused = actor.manageStake(setNonce, add, h);
            if (okPaused) pausedManageStakeSucceeded = true;
            return;
        }

        // If frozen (including same-block update), manageStake must not succeed.
        if (lastUpdated != 0 && lastUpdated >= block.number) {
            bool okFrozen = actor.manageStake(setNonce, add, h);
            if (okFrozen) frozenManageStakeSucceeded = true;
            return;
        }

        bool ok = actor.manageStake(setNonce, add, h);
        if (!ok) return;

        (, uint256 committedStake, , , ) = registry.stakes(address(actor));
        uint256 idx = uint256(actorId) % ACTOR_COUNT;
        if (committedStake < lastCommittedStakeByActor[idx]) actionInvariantViolated = true;
        lastCommittedStakeByActor[idx] = committedStake;
        lastSetNonceByActor[idx] = setNonce;
        networkIdAtLastStakeByActor[idx] = trackedNetworkId;
    }

    function act_actor_withdrawSurplus(uint8 actorId) external {
        EchidnaStakeActor a = _actor(actorId);
        (bytes32 ov, uint256 committed, uint256 potential, uint256 lastUpdated, uint8 h) = registry.stakes(address(a));
        uint256 beforeBal = token.balanceOf(address(a));

        bool ok = a.withdrawFromStake();
        if (!ok) return;

        (bytes32 ov2, , uint256 potentialAfter, , ) = registry.stakes(address(a));
        uint256 afterBal = token.balanceOf(address(a));

        // No changes to overlay expected from withdraw.
        if (ov2 != ov) actionInvariantViolated = true;

        // Expected surplus based on contract math.
        uint256 effective = _min(potential, committed * (1 << h) * uint256(ORACLE_PRICE));
        uint256 surplus = potential - effective;

        if (surplus == 0) {
            if (potentialAfter != potential) actionInvariantViolated = true;
            if (afterBal != beforeBal) actionInvariantViolated = true;
            return;
        }

        if (potentialAfter + surplus != potential) actionInvariantViolated = true;
        if (afterBal != beforeBal + surplus) actionInvariantViolated = true;

        // lastUpdated should not be modified by withdrawFromStake() in this contract.
        if (registry.lastUpdatedBlockNumberOfAddress(address(a)) != lastUpdated) actionInvariantViolated = true;
    }

    function act_actor_migrateStake(uint8 actorId) external {
        EchidnaStakeActor a = _actor(actorId);

        uint256 beforeBal = token.balanceOf(address(a));
        (, , uint256 potential, uint256 lastUpdated, ) = registry.stakes(address(a));

        bool ok = a.migrateStake();
        if (!ok) return;

        // migrateStake only succeeds when paused; if it succeeded, stake must be deleted.
        (bytes32 ov2, uint256 c2, uint256 p2, uint256 u2, uint8 h2) = registry.stakes(address(a));
        if (lastUpdated != 0) {
            if (ov2 != bytes32(0) || c2 != 0 || p2 != 0 || u2 != 0 || h2 != 0) actionInvariantViolated = true;
            if (token.balanceOf(address(a)) != beforeBal + potential) actionInvariantViolated = true;
            // Keep tracking in sync so "committed never decreases" doesn't trip on deletion.
            uint256 idx = uint256(actorId) % ACTOR_COUNT;
            lastCommittedStakeByActor[idx] = 0;
            lastSetNonceByActor[idx] = bytes32(0);
            networkIdAtLastStakeByActor[idx] = trackedNetworkId;
        } else {
            // If no stake existed, migrate is a no-op.
            if (token.balanceOf(address(a)) != beforeBal) actionInvariantViolated = true;
        }
    }

    function act_admin_pause() external {
        registry.pause();
    }

    function act_admin_unpause() external {
        registry.unPause();
    }

    function act_admin_changeNetworkId(uint64 newNetworkId) external {
        registry.changeNetworkId(newNetworkId);
        trackedNetworkId = newNetworkId;
    }

    function act_actor_tryPause(uint8 actorId) external {
        bool ok = _actor(actorId).tryPause();
        if (ok) unauthorizedAdminCallSucceeded = true;
    }

    function act_actor_tryUnpause(uint8 actorId) external {
        bool ok = _actor(actorId).tryUnpause();
        if (ok) unauthorizedAdminCallSucceeded = true;
    }

    function act_actor_tryChangeNetworkId(uint8 actorId, uint64 newNetworkId) external {
        bool ok = _actor(actorId).tryChangeNetworkId(newNetworkId);
        if (ok) unauthorizedAdminCallSucceeded = true;
    }

    function act_redistributor_freeze(uint8 targetActorId, uint32 time) external {
        EchidnaStakeActor t = _actor(targetActorId);
        uint256 before = registry.lastUpdatedBlockNumberOfAddress(address(t));
        bool ok = redistributor.tryFreezeDeposit(address(t), uint256(time));
        if (!ok) return;

        // Only affects existing stakes.
        if (before != 0) {
            uint256 afterU = registry.lastUpdatedBlockNumberOfAddress(address(t));
            if (afterU != block.number + uint256(time)) actionInvariantViolated = true;
        }
    }

    function act_redistributor_slash(uint8 targetActorId, uint256 amount) external {
        EchidnaStakeActor t = _actor(targetActorId);
        (, uint256 cBefore, uint256 pBefore, uint256 uBefore, uint8 hBefore) = registry.stakes(address(t));
        bool ok = redistributor.trySlashDeposit(address(t), amount);
        if (!ok) return;

        (bytes32 ovAfter, uint256 cAfter, uint256 pAfter, uint256 uAfter, uint8 hAfter) = registry.stakes(address(t));

        if (uBefore == 0) {
            // No stake: should remain unchanged.
            if (cAfter != cBefore || pAfter != pBefore || uAfter != uBefore || hAfter != hBefore) actionInvariantViolated = true;
            return;
        }

        if (pBefore > amount) {
            if (pAfter != pBefore - amount) actionInvariantViolated = true;
            if (uAfter != block.number) actionInvariantViolated = true;
            // overlay/committed/height must remain unchanged on partial slash.
            if (ovAfter != registry.overlayOfAddress(address(t))) actionInvariantViolated = true;
            if (cAfter != cBefore || hAfter != hBefore) actionInvariantViolated = true;
        } else {
            // Stake deleted.
            if (ovAfter != bytes32(0) || cAfter != 0 || pAfter != 0 || uAfter != 0 || hAfter != 0) actionInvariantViolated = true;
            uint256 idx = uint256(targetActorId) % ACTOR_COUNT;
            lastCommittedStakeByActor[idx] = 0;
            lastSetNonceByActor[idx] = bytes32(0);
            networkIdAtLastStakeByActor[idx] = trackedNetworkId;
        }
    }

    function act_actor_tryFreeze(uint8 actorId, uint8 targetActorId, uint32 time) external {
        bool ok = _actor(actorId).tryFreezeDeposit(address(_actor(targetActorId)), uint256(time));
        if (ok) unauthorizedFreezeSlashSucceeded = true;
    }

    function act_actor_trySlash(uint8 actorId, uint8 targetActorId, uint256 amount) external {
        bool ok = _actor(actorId).trySlashDeposit(address(_actor(targetActorId)), amount);
        if (ok) unauthorizedFreezeSlashSucceeded = true;
    }

    // -----------------------------
    // Properties (checked by Echidna)
    // -----------------------------

    function echidna_never_performed_forbidden_calls() external view returns (bool) {
        return
            !unauthorizedAdminCallSucceeded &&
            !unauthorizedFreezeSlashSucceeded &&
            !pausedManageStakeSucceeded &&
            !frozenManageStakeSucceeded &&
            !actionInvariantViolated;
    }

    function echidna_registry_token_is_expected() external view returns (bool) {
        return registry.bzzToken() == address(token);
    }

    function echidna_registry_balance_covers_sum_potential() external view returns (bool) {
        uint256 sumPotential;
        for (uint256 i = 0; i < ACTOR_COUNT; i++) {
            (, , uint256 potentialStake, , ) = registry.stakes(address(actors[i]));
            sumPotential += potentialStake;
        }
        return token.balanceOf(address(registry)) >= sumPotential;
    }

    function echidna_stake_committed_never_decreases_per_actor() external view returns (bool) {
        for (uint256 i = 0; i < ACTOR_COUNT; i++) {
            (, uint256 committedStake, , uint256 lastUpdated, ) = registry.stakes(address(actors[i]));
            if (lastUpdated == 0) continue;
            if (committedStake < lastCommittedStakeByActor[i]) return false;
        }
        return true;
    }

    function echidna_nodeEffective_matches_freeze_rule_per_actor() external view returns (bool) {
        for (uint256 i = 0; i < ACTOR_COUNT; i++) {
            (, uint256 committedStake, uint256 potentialStake, uint256 lastUpdated, uint8 h) = registry.stakes(
                address(actors[i])
            );
            uint256 fromView = registry.nodeEffectiveStake(address(actors[i]));
            if (lastUpdated == 0) {
                if (fromView != 0) return false;
                continue;
            }
            if (lastUpdated >= block.number) {
                if (fromView != 0) return false;
                continue;
            }
            uint256 expected = _min(potentialStake, committedStake * (1 << h) * uint256(ORACLE_PRICE));
            if (fromView != expected) return false;
        }
        return true;
    }

    function echidna_empty_state_is_zeroed_for_all() external view returns (bool) {
        for (uint256 i = 0; i < ACTOR_COUNT; i++) {
            (bytes32 overlay, uint256 committedStake, uint256 potentialStake, uint256 lastUpdated, uint8 h) = registry
                .stakes(address(actors[i]));
            if (lastUpdated != 0) continue;
            if (overlay != bytes32(0) || committedStake != 0 || potentialStake != 0 || h != 0) return false;
        }
        return true;
    }

    function echidna_overlay_matches_last_manageStake_for_all() external view returns (bool) {
        for (uint256 i = 0; i < ACTOR_COUNT; i++) {
            (bytes32 overlay, , , uint256 lastUpdated, ) = registry.stakes(address(actors[i]));
            if (lastUpdated == 0) continue;
            bytes32 expected = keccak256(
                abi.encodePacked(address(actors[i]), _reverse(networkIdAtLastStakeByActor[i]), lastSetNonceByActor[i])
            );
            if (overlay != expected) return false;
        }
        return true;
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

    function _actor(uint8 actorId) internal view returns (EchidnaStakeActor) {
        return actors[uint256(actorId) % ACTOR_COUNT];
    }
}
