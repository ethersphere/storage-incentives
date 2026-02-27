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

    // Post-condition checks for the last *successful* manageStake(add > 0).
    // We keep these checks "pending" only until the next action, so properties
    // validate the immediate post-state without being invalidated by later actions.
    bool internal pendingManageStakeAddCheck;
    uint256 internal pendingActorIdx;
    uint256 internal pendingAddAmount;
    uint8 internal pendingHeight;
    uint256 internal pendingPotentialBefore;
    uint256 internal pendingRegistryBalanceBefore;

    // Post-condition checks for the last freeze/slash/migrate call (pending until next action).
    bool internal pendingFreezeCheck;
    uint256 internal pendingFreezeIdx;
    bool internal pendingFreezeHadStake;
    bytes32 internal pendingFreezeOverlay;
    uint256 internal pendingFreezeCommitted;
    uint256 internal pendingFreezePotential;
    uint8 internal pendingFreezeHeight;
    uint256 internal pendingFreezeExpectedLastUpdated;

    bool internal pendingSlashCheck;
    uint256 internal pendingSlashIdx;
    bool internal pendingSlashHadStake;
    bytes32 internal pendingSlashOverlay;
    uint256 internal pendingSlashCommitted;
    uint256 internal pendingSlashPotential;
    uint8 internal pendingSlashHeight;
    uint256 internal pendingSlashLastUpdated;
    uint256 internal pendingSlashAmount;
    uint256 internal pendingSlashExpectedBlockNumber;

    bool internal pendingMigrateCheck;
    uint256 internal pendingMigrateIdx;
    bool internal pendingMigrateHadStake;
    uint256 internal pendingMigratePotentialBefore;
    uint256 internal pendingMigrateActorBalanceBefore;
    uint256 internal pendingMigrateLastUpdatedBefore;
    bool internal migrateSucceededWhileUnpaused;

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
        _clearPendingChecks();
        bytes32 d0 = _stakeDigest(address(actors[0]));
        bytes32 d1 = _stakeDigest(address(actors[1]));
        bytes32 d2 = _stakeDigest(address(actors[2]));

        EchidnaStakeActor a = _actor(actorId);
        uint256 bal = token.balanceOf(address(this));
        if (bal == 0) return;
        uint256 x = amount % (bal + 1);
        if (x == 0) return;
        token.transfer(address(a), x);

        if (_stakeDigest(address(actors[0])) != d0) actionInvariantViolated = true;
        if (_stakeDigest(address(actors[1])) != d1) actionInvariantViolated = true;
        if (_stakeDigest(address(actors[2])) != d2) actionInvariantViolated = true;
    }

    function act_actor_manageStake(uint8 actorId, bytes32 setNonce, uint256 addAmount, uint8 height) external {
        _clearPendingChecks();

        uint256 idx = uint256(actorId) % ACTOR_COUNT;
        EchidnaStakeActor actor = actors[idx];
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

        // Snapshot other actors so we can detect unintended writes.
        (bytes32 otherDigestA, bytes32 otherDigestB) = _otherDigests(idx);

        // Prepare pending post-conditions only for add > 0.
        if (add > 0) {
            pendingActorIdx = idx;
            pendingAddAmount = add;
            pendingHeight = h;
            (, , pendingPotentialBefore, , ) = registry.stakes(address(actor));
            pendingRegistryBalanceBefore = token.balanceOf(address(registry));
        }

        bool ok = actor.manageStake(setNonce, add, h);
        if (!ok) return;

        _checkOtherDigestsUnchanged(idx, otherDigestA, otherDigestB);

        (, uint256 committedStake, , , ) = registry.stakes(address(actor));
        if (committedStake < lastCommittedStakeByActor[idx]) actionInvariantViolated = true;
        lastCommittedStakeByActor[idx] = committedStake;
        lastSetNonceByActor[idx] = setNonce;
        networkIdAtLastStakeByActor[idx] = trackedNetworkId;

        // Arm post-condition properties for the immediate post-state.
        if (add > 0) pendingManageStakeAddCheck = true;
    }

    function act_actor_withdrawSurplus(uint8 actorId) external {
        _clearPendingChecks();

        uint256 idx = uint256(actorId) % ACTOR_COUNT;
        EchidnaStakeActor a = actors[idx];
        (bytes32 otherDigestA, bytes32 otherDigestB) = _otherDigests(idx);

        (bytes32 ov, uint256 committed, uint256 potential, , uint8 h) = registry.stakes(address(a));
        uint256 beforeBal = token.balanceOf(address(a));

        bool ok = a.withdrawFromStake();
        if (!ok) return;

        _checkOtherDigestsUnchanged(idx, otherDigestA, otherDigestB);

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
    }

    function act_actor_migrateStake(uint8 actorId) external {
        _clearPendingChecks();

        uint256 idx = uint256(actorId) % ACTOR_COUNT;
        EchidnaStakeActor a = actors[idx];
        (bytes32 otherDigestA, bytes32 otherDigestB) = _otherDigests(idx);

        pendingMigrateIdx = idx;
        pendingMigrateActorBalanceBefore = token.balanceOf(address(a));
        (, , pendingMigratePotentialBefore, pendingMigrateLastUpdatedBefore, ) = registry.stakes(address(a));
        pendingMigrateHadStake = pendingMigrateLastUpdatedBefore != 0;

        bool ok = a.migrateStake();
        if (!ok) return;

        if (!registry.paused()) migrateSucceededWhileUnpaused = true;
        _checkOtherDigestsUnchanged(idx, otherDigestA, otherDigestB);
        pendingMigrateCheck = true;

        // If a stake existed, migrateStake refunds and deletes it. Reset per-actor tracking
        // so future re-stakes don't incorrectly look like "commitment decreased".
        if (pendingMigrateHadStake) {
            lastCommittedStakeByActor[idx] = 0;
            lastSetNonceByActor[idx] = bytes32(0);
            networkIdAtLastStakeByActor[idx] = trackedNetworkId;
        }
    }

    function act_admin_pause() external {
        _clearPendingChecks();
        bytes32 d0 = _stakeDigest(address(actors[0]));
        bytes32 d1 = _stakeDigest(address(actors[1]));
        bytes32 d2 = _stakeDigest(address(actors[2]));
        registry.pause();
        if (_stakeDigest(address(actors[0])) != d0) actionInvariantViolated = true;
        if (_stakeDigest(address(actors[1])) != d1) actionInvariantViolated = true;
        if (_stakeDigest(address(actors[2])) != d2) actionInvariantViolated = true;
    }

    function act_admin_unpause() external {
        _clearPendingChecks();
        bytes32 d0 = _stakeDigest(address(actors[0]));
        bytes32 d1 = _stakeDigest(address(actors[1]));
        bytes32 d2 = _stakeDigest(address(actors[2]));
        registry.unPause();
        if (_stakeDigest(address(actors[0])) != d0) actionInvariantViolated = true;
        if (_stakeDigest(address(actors[1])) != d1) actionInvariantViolated = true;
        if (_stakeDigest(address(actors[2])) != d2) actionInvariantViolated = true;
    }

    function act_admin_changeNetworkId(uint64 newNetworkId) external {
        _clearPendingChecks();
        bytes32 d0 = _stakeDigest(address(actors[0]));
        bytes32 d1 = _stakeDigest(address(actors[1]));
        bytes32 d2 = _stakeDigest(address(actors[2]));
        registry.changeNetworkId(newNetworkId);
        trackedNetworkId = newNetworkId;
        if (_stakeDigest(address(actors[0])) != d0) actionInvariantViolated = true;
        if (_stakeDigest(address(actors[1])) != d1) actionInvariantViolated = true;
        if (_stakeDigest(address(actors[2])) != d2) actionInvariantViolated = true;
    }

    function act_actor_tryPause(uint8 actorId) external {
        _clearPendingChecks();
        bytes32 d0 = _stakeDigest(address(actors[0]));
        bytes32 d1 = _stakeDigest(address(actors[1]));
        bytes32 d2 = _stakeDigest(address(actors[2]));
        bool ok = _actor(actorId).tryPause();
        if (ok) unauthorizedAdminCallSucceeded = true;
        if (_stakeDigest(address(actors[0])) != d0) actionInvariantViolated = true;
        if (_stakeDigest(address(actors[1])) != d1) actionInvariantViolated = true;
        if (_stakeDigest(address(actors[2])) != d2) actionInvariantViolated = true;
    }

    function act_actor_tryUnpause(uint8 actorId) external {
        _clearPendingChecks();
        bytes32 d0 = _stakeDigest(address(actors[0]));
        bytes32 d1 = _stakeDigest(address(actors[1]));
        bytes32 d2 = _stakeDigest(address(actors[2]));
        bool ok = _actor(actorId).tryUnpause();
        if (ok) unauthorizedAdminCallSucceeded = true;
        if (_stakeDigest(address(actors[0])) != d0) actionInvariantViolated = true;
        if (_stakeDigest(address(actors[1])) != d1) actionInvariantViolated = true;
        if (_stakeDigest(address(actors[2])) != d2) actionInvariantViolated = true;
    }

    function act_actor_tryChangeNetworkId(uint8 actorId, uint64 newNetworkId) external {
        _clearPendingChecks();
        bytes32 d0 = _stakeDigest(address(actors[0]));
        bytes32 d1 = _stakeDigest(address(actors[1]));
        bytes32 d2 = _stakeDigest(address(actors[2]));
        bool ok = _actor(actorId).tryChangeNetworkId(newNetworkId);
        if (ok) unauthorizedAdminCallSucceeded = true;
        if (_stakeDigest(address(actors[0])) != d0) actionInvariantViolated = true;
        if (_stakeDigest(address(actors[1])) != d1) actionInvariantViolated = true;
        if (_stakeDigest(address(actors[2])) != d2) actionInvariantViolated = true;
    }

    function act_redistributor_freeze(uint8 targetActorId, uint32 time) external {
        _clearPendingChecks();

        uint256 idx = uint256(targetActorId) % ACTOR_COUNT;
        EchidnaStakeActor t = actors[idx];
        (bytes32 otherDigestA, bytes32 otherDigestB) = _otherDigests(idx);

        (pendingFreezeOverlay, pendingFreezeCommitted, pendingFreezePotential, pendingFreezeExpectedLastUpdated, pendingFreezeHeight) = registry
            .stakes(address(t));
        pendingFreezeIdx = idx;
        pendingFreezeHadStake = pendingFreezeExpectedLastUpdated != 0;
        pendingFreezeExpectedLastUpdated = pendingFreezeHadStake ? block.number + uint256(time) : 0;

        bool ok = redistributor.tryFreezeDeposit(address(t), uint256(time));
        if (!ok) return;

        _checkOtherDigestsUnchanged(idx, otherDigestA, otherDigestB);
        pendingFreezeCheck = true;
    }

    function act_redistributor_slash(uint8 targetActorId, uint256 amount) external {
        _clearPendingChecks();

        uint256 idx = uint256(targetActorId) % ACTOR_COUNT;
        EchidnaStakeActor t = actors[idx];
        (bytes32 otherDigestA, bytes32 otherDigestB) = _otherDigests(idx);

        (pendingSlashOverlay, pendingSlashCommitted, pendingSlashPotential, pendingSlashLastUpdated, pendingSlashHeight) = registry
            .stakes(address(t));
        pendingSlashIdx = idx;
        pendingSlashHadStake = pendingSlashLastUpdated != 0;
        pendingSlashAmount = amount;
        pendingSlashExpectedBlockNumber = block.number;

        bool ok = redistributor.trySlashDeposit(address(t), amount);
        if (!ok) return;

        _checkOtherDigestsUnchanged(idx, otherDigestA, otherDigestB);
        pendingSlashCheck = true;

        // If the slash deleted the stake (amount >= potential), reset per-actor tracking
        // so future re-stakes don't incorrectly look like "commitment decreased".
        if (pendingSlashHadStake && pendingSlashPotential <= pendingSlashAmount) {
            lastCommittedStakeByActor[idx] = 0;
            lastSetNonceByActor[idx] = bytes32(0);
            networkIdAtLastStakeByActor[idx] = trackedNetworkId;
        }
    }

    function act_actor_tryFreeze(uint8 actorId, uint8 targetActorId, uint32 time) external {
        _clearPendingChecks();
        bytes32 d0 = _stakeDigest(address(actors[0]));
        bytes32 d1 = _stakeDigest(address(actors[1]));
        bytes32 d2 = _stakeDigest(address(actors[2]));
        bool ok = _actor(actorId).tryFreezeDeposit(address(_actor(targetActorId)), uint256(time));
        if (ok) unauthorizedFreezeSlashSucceeded = true;
        if (_stakeDigest(address(actors[0])) != d0) actionInvariantViolated = true;
        if (_stakeDigest(address(actors[1])) != d1) actionInvariantViolated = true;
        if (_stakeDigest(address(actors[2])) != d2) actionInvariantViolated = true;
    }

    function act_actor_trySlash(uint8 actorId, uint8 targetActorId, uint256 amount) external {
        _clearPendingChecks();
        bytes32 d0 = _stakeDigest(address(actors[0]));
        bytes32 d1 = _stakeDigest(address(actors[1]));
        bytes32 d2 = _stakeDigest(address(actors[2]));
        bool ok = _actor(actorId).trySlashDeposit(address(_actor(targetActorId)), amount);
        if (ok) unauthorizedFreezeSlashSucceeded = true;
        if (_stakeDigest(address(actors[0])) != d0) actionInvariantViolated = true;
        if (_stakeDigest(address(actors[1])) != d1) actionInvariantViolated = true;
        if (_stakeDigest(address(actors[2])) != d2) actionInvariantViolated = true;
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

    /// @notice After a successful manageStake(add > 0), potential and registry balance
    /// must both increase by exactly `add`.
    function echidna_last_manageStake_add_updates_potential_and_registry_balance() external view returns (bool) {
        if (!pendingManageStakeAddCheck) return true;
        address a = address(actors[pendingActorIdx]);
        (, , uint256 potentialAfter, , ) = registry.stakes(a);
        if (potentialAfter != pendingPotentialBefore + pendingAddAmount) return false;
        if (token.balanceOf(address(registry)) != pendingRegistryBalanceBefore + pendingAddAmount) return false;
        return true;
    }

    /// @notice After a successful manageStake(add > 0), committedStake must be
    /// recomputed to floor(potential / (price * 2**height)).
    function echidna_last_manageStake_add_recomputes_committedStake() external view returns (bool) {
        if (!pendingManageStakeAddCheck) return true;
        address a = address(actors[pendingActorIdx]);
        (, uint256 committedAfter, uint256 potentialAfter, , uint8 hAfter) = registry.stakes(a);
        if (hAfter != pendingHeight) return false;
        uint256 denom = uint256(ORACLE_PRICE) * (1 << pendingHeight);
        uint256 expectedCommitted = potentialAfter / denom;
        return committedAfter == expectedCommitted;
    }

    function echidna_migrate_never_succeeds_while_unpaused() external view returns (bool) {
        return !migrateSucceededWhileUnpaused;
    }

    function echidna_last_migrate_refunds_and_deletes_when_stake_exists() external view returns (bool) {
        if (!pendingMigrateCheck) return true;
        address a = address(actors[pendingMigrateIdx]);

        // migrateStake has whenPaused; if the call succeeded, we must be paused.
        if (!registry.paused()) return false;

        if (!pendingMigrateHadStake) {
            // No stake existed; migrate is a no-op.
            if (token.balanceOf(a) != pendingMigrateActorBalanceBefore) return false;
            return registry.lastUpdatedBlockNumberOfAddress(a) == 0;
        }

        // Stake existed; it must be deleted and balance refunded.
        if (token.balanceOf(a) != pendingMigrateActorBalanceBefore + pendingMigratePotentialBefore) return false;
        return registry.lastUpdatedBlockNumberOfAddress(a) == 0;
    }

    function echidna_last_freeze_only_updates_lastUpdated() external view returns (bool) {
        if (!pendingFreezeCheck) return true;
        address a = address(actors[pendingFreezeIdx]);
        (bytes32 ov, uint256 c, uint256 p, uint256 u, uint8 h) = registry.stakes(a);

        if (!pendingFreezeHadStake) {
            return ov == bytes32(0) && c == 0 && p == 0 && u == 0 && h == 0;
        }

        if (ov != pendingFreezeOverlay) return false;
        if (c != pendingFreezeCommitted) return false;
        if (p != pendingFreezePotential) return false;
        if (h != pendingFreezeHeight) return false;
        return u == pendingFreezeExpectedLastUpdated;
    }

    function echidna_last_slash_updates_expected_fields() external view returns (bool) {
        if (!pendingSlashCheck) return true;
        address a = address(actors[pendingSlashIdx]);
        (bytes32 ov, uint256 c, uint256 p, uint256 u, uint8 h) = registry.stakes(a);

        if (!pendingSlashHadStake) {
            // No stake existed; slash does nothing.
            return ov == bytes32(0) && c == 0 && p == 0 && u == 0 && h == 0;
        }

        if (pendingSlashPotential > pendingSlashAmount) {
            // Partial slash: only potential decreases, lastUpdated set to block.number at slash time.
            if (ov != pendingSlashOverlay) return false;
            if (c != pendingSlashCommitted) return false;
            if (h != pendingSlashHeight) return false;
            if (p != pendingSlashPotential - pendingSlashAmount) return false;
            return u == pendingSlashExpectedBlockNumber;
        }

        // Full slash: stake deleted.
        return ov == bytes32(0) && c == 0 && p == 0 && u == 0 && h == 0;
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

    function _stakeDigest(address who) internal view returns (bytes32) {
        (bytes32 overlay, uint256 committedStake, uint256 potentialStake, uint256 lastUpdated, uint8 h) = registry.stakes(
            who
        );
        return keccak256(abi.encodePacked(overlay, committedStake, potentialStake, lastUpdated, h));
    }

    function _otherDigests(uint256 idx) internal view returns (bytes32 dA, bytes32 dB) {
        if (idx == 0) {
            dA = _stakeDigest(address(actors[1]));
            dB = _stakeDigest(address(actors[2]));
        } else if (idx == 1) {
            dA = _stakeDigest(address(actors[0]));
            dB = _stakeDigest(address(actors[2]));
        } else {
            dA = _stakeDigest(address(actors[0]));
            dB = _stakeDigest(address(actors[1]));
        }
    }

    function _checkOtherDigestsUnchanged(uint256 idx, bytes32 dA, bytes32 dB) internal {
        if (idx == 0) {
            if (_stakeDigest(address(actors[1])) != dA) actionInvariantViolated = true;
            if (_stakeDigest(address(actors[2])) != dB) actionInvariantViolated = true;
        } else if (idx == 1) {
            if (_stakeDigest(address(actors[0])) != dA) actionInvariantViolated = true;
            if (_stakeDigest(address(actors[2])) != dB) actionInvariantViolated = true;
        } else {
            if (_stakeDigest(address(actors[0])) != dA) actionInvariantViolated = true;
            if (_stakeDigest(address(actors[1])) != dB) actionInvariantViolated = true;
        }
    }

    function _clearPendingChecks() internal {
        pendingManageStakeAddCheck = false;
        pendingFreezeCheck = false;
        pendingSlashCheck = false;
        pendingMigrateCheck = false;
    }
}
