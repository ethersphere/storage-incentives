// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.19;

import "../TestToken.sol";
import "../Staking.sol";
import "../Util/Constants.sol";

contract EchidnaStakingActor {
    TestToken internal immutable token;
    StakeRegistry internal immutable registry;

    constructor(TestToken token_, StakeRegistry registry_) {
        token = token_;
        registry = registry_;
        token.approve(address(registry), type(uint256).max);
    }

    function createDeposit(bytes32 setNonce, uint256 amount, uint8 height) external returns (bool ok) {
        (ok, ) = address(registry).call(
            abi.encodeWithSelector(registry.createDeposit.selector, setNonce, amount, height)
        );
    }

    function addTokens(uint256 amount) external returns (bool ok) {
        (ok, ) = address(registry).call(abi.encodeWithSelector(registry.addTokens.selector, amount));
    }

    function changeOverlay(bytes32 setNonce) external returns (bool ok) {
        (ok, ) = address(registry).call(abi.encodeWithSelector(registry.changeOverlay.selector, setNonce));
    }

    function increaseHeight(uint8 height) external returns (bool ok) {
        (ok, ) = address(registry).call(abi.encodeWithSelector(registry.increaseHeight.selector, height));
    }

    function withdraw(uint256 amount) external returns (bool ok) {
        (ok, ) = address(registry).call(abi.encodeWithSelector(registry.withdraw.selector, amount));
    }

    function exit() external returns (bool ok) {
        (ok, ) = address(registry).call(abi.encodeWithSelector(registry.exit.selector));
    }

    function migrateStake() external returns (bool ok) {
        (ok, ) = address(registry).call(abi.encodeWithSelector(registry.migrateStake.selector));
    }

    function tryPause() external returns (bool ok) {
        (ok, ) = address(registry).call(abi.encodeWithSelector(registry.pause.selector));
    }

    function tryUnpause() external returns (bool ok) {
        (ok, ) = address(registry).call(abi.encodeWithSelector(registry.unpause.selector));
    }

    function tryFreezeDeposit(address owner, uint256 time) external returns (bool ok) {
        (ok, ) = address(registry).call(abi.encodeWithSelector(registry.freezeDeposit.selector, owner, time));
    }
}

/// @notice Echidna harness for the queued-update StakeRegistry (src/Staking.sol).
contract EchidnaStakingHarness {
    TestToken internal immutable token;
    StakeRegistry internal immutable registry;

    uint256 internal constant MIN_STAKE = Constants.MIN_STAKE;
    uint256 internal constant ACTOR_COUNT = 3;
    uint64 internal constant WAIT_BASE = 2;
    uint64 internal constant WAIT_OVERLAY = 2;
    uint64 internal constant WAIT_WITHDRAWAL = 2;

    uint256 internal immutable initialSupply;

    EchidnaStakingActor[3] internal actors;
    EchidnaStakingActor internal redistributor;

    bytes32[3] internal lastSetNonceByActor;

    bool internal unauthorizedAdminCallSucceeded;
    bool internal unauthorizedFreezeSucceeded;
    bool internal pausedMutationSucceeded;
    bool internal migrateSucceededWhileUnpaused;
    bool internal actionInvariantViolated;

    bool internal pendingDepositCheck;
    uint256 internal pendingDepositIdx;
    uint256 internal pendingDepositAmount;
    uint256 internal pendingRegistryBalanceBefore;

    bool internal pendingMigrateCheck;
    uint256 internal pendingMigrateIdx;
    uint256 internal pendingMigrateBalanceBefore;
    uint256 internal pendingMigrateRegistryBalBefore;
    bool internal pendingMigrateHadStake;

    constructor() {
        initialSupply = 1_000_000_000_000_000_000_000_000;

        token = new TestToken("TestToken", "TT", initialSupply);
        registry = new StakeRegistry(address(token), 10, WAIT_BASE, WAIT_OVERLAY, WAIT_WITHDRAWAL);

        for (uint256 i = 0; i < ACTOR_COUNT; i++) {
            actors[i] = new EchidnaStakingActor(token, registry);
            token.transfer(address(actors[i]), initialSupply / 20);
        }

        redistributor = new EchidnaStakingActor(token, registry);
        registry.grantRole(registry.REDISTRIBUTOR_ROLE(), address(redistributor));
    }

    // -----------------------------
    // Actions
    // -----------------------------

    function act_tick() external {
        _clearPendingChecks();
    }

    function act_fundActor(uint8 actorId, uint256 amount) external {
        _clearPendingChecks();
        bytes32 d0 = _stakeDigest(address(actors[0]));
        bytes32 d1 = _stakeDigest(address(actors[1]));
        bytes32 d2 = _stakeDigest(address(actors[2]));

        EchidnaStakingActor a = _actor(actorId);
        uint256 bal = token.balanceOf(address(this));
        if (bal == 0) return;
        uint256 x = amount % (bal + 1);
        if (x == 0) return;
        token.transfer(address(a), x);

        _checkDigestsUnchanged(d0, d1, d2);
    }

    function act_applyUpdates(uint8 actorId) external {
        _clearPendingChecks();
        bytes32 d0 = _stakeDigest(address(actors[0]));
        bytes32 d1 = _stakeDigest(address(actors[1]));
        bytes32 d2 = _stakeDigest(address(actors[2]));

        address owner = address(_actor(actorId));
        try registry.applyUpdates(owner) {} catch {}

        _checkDigestsUnchanged(d0, d1, d2);
    }

    function act_actor_createDeposit(uint8 actorId, bytes32 setNonce, uint256 amount, uint8 height) external {
        _clearPendingChecks();

        uint256 idx = uint256(actorId) % ACTOR_COUNT;
        EchidnaStakingActor actor = actors[idx];
        uint8 h = uint8(height % 16);

        uint256 available = token.balanceOf(address(actor));
        if (available == 0) return;

        uint256 minStake = MIN_STAKE * (1 << h);
        uint256 amt = amount % (available + 1);
        if (amt < minStake) {
            if (minStake > available) return;
            amt = minStake;
        }

        (bytes32 otherA, bytes32 otherB) = _otherDigests(idx);

        if (registry.paused()) {
            bool okPaused = actor.createDeposit(setNonce, amt, h);
            if (okPaused) pausedMutationSucceeded = true;
            return;
        }

        pendingDepositIdx = idx;
        pendingDepositAmount = amt;
        pendingRegistryBalanceBefore = token.balanceOf(address(registry));

        bool ok = actor.createDeposit(setNonce, amt, h);
        if (!ok) return;

        _checkOtherDigestsUnchanged(idx, otherA, otherB);
        lastSetNonceByActor[idx] = setNonce;
        pendingDepositCheck = true;
    }

    function act_actor_addTokens(uint8 actorId, uint256 amount) external {
        _clearPendingChecks();

        uint256 idx = uint256(actorId) % ACTOR_COUNT;
        EchidnaStakingActor actor = actors[idx];
        (bytes32 ov, uint256 bal, ) = _stakes(address(actor));
        if (ov == bytes32(0) || bal == 0) return;

        uint256 available = token.balanceOf(address(actor));
        if (available == 0) return;
        uint256 amt = amount % (available + 1);
        if (amt == 0) return;

        (bytes32 otherA, bytes32 otherB) = _otherDigests(idx);

        if (registry.paused()) {
            bool okPaused = actor.addTokens(amt);
            if (okPaused) pausedMutationSucceeded = true;
            return;
        }

        uint256 regBefore = token.balanceOf(address(registry));
        bool ok = actor.addTokens(amt);
        if (!ok) return;

        _checkOtherDigestsUnchanged(idx, otherA, otherB);
        if (token.balanceOf(address(registry)) != regBefore + amt) actionInvariantViolated = true;
    }

    function act_actor_changeOverlay(uint8 actorId, bytes32 setNonce) external {
        _clearPendingChecks();

        uint256 idx = uint256(actorId) % ACTOR_COUNT;
        EchidnaStakingActor actor = actors[idx];
        (bytes32 ov, uint256 bal, ) = _stakes(address(actor));
        if (ov == bytes32(0) || bal == 0) return;

        (bytes32 otherA, bytes32 otherB) = _otherDigests(idx);
        bool ok = actor.changeOverlay(setNonce);
        if (!ok) return;

        _checkOtherDigestsUnchanged(idx, otherA, otherB);
    }

    function act_actor_increaseHeight(uint8 actorId, uint8 height) external {
        _clearPendingChecks();

        uint256 idx = uint256(actorId) % ACTOR_COUNT;
        EchidnaStakingActor actor = actors[idx];
        (, uint256 bal, uint8 curH) = _stakes(address(actor));
        if (bal == 0) return;

        uint8 h = uint8(height % 16);
        if (h <= curH) return;

        uint256 minForH = MIN_STAKE * (1 << h);
        if (bal < minForH) return;

        (bytes32 otherA, bytes32 otherB) = _otherDigests(idx);
        bool ok = actor.increaseHeight(h);
        if (!ok) return;
        _checkOtherDigestsUnchanged(idx, otherA, otherB);
    }

    function act_actor_withdraw(uint8 actorId, uint256 amount) external {
        _clearPendingChecks();

        uint256 idx = uint256(actorId) % ACTOR_COUNT;
        EchidnaStakingActor actor = actors[idx];
        (, uint256 bal, uint8 h) = _stakes(address(actor));
        if (bal == 0) return;

        uint256 minRemain = MIN_STAKE * (1 << h);
        if (bal <= minRemain) return;

        uint256 maxWithdraw = bal - minRemain;
        uint256 amt = amount % (maxWithdraw + 1);
        if (amt == 0) return;

        (bytes32 otherA, bytes32 otherB) = _otherDigests(idx);
        bool ok = actor.withdraw(amt);
        if (!ok) return;
        _checkOtherDigestsUnchanged(idx, otherA, otherB);
    }

    function act_actor_exit(uint8 actorId) external {
        _clearPendingChecks();

        uint256 idx = uint256(actorId) % ACTOR_COUNT;
        EchidnaStakingActor actor = actors[idx];
        (, uint256 bal, ) = _stakes(address(actor));
        if (bal == 0) return;

        (bytes32 otherA, bytes32 otherB) = _otherDigests(idx);
        bool ok = actor.exit();
        if (!ok) return;
        _checkOtherDigestsUnchanged(idx, otherA, otherB);
    }

    function act_actor_migrateStake(uint8 actorId) external {
        _clearPendingChecks();

        uint256 idx = uint256(actorId) % ACTOR_COUNT;
        EchidnaStakingActor actor = actors[idx];
        (bytes32 otherA, bytes32 otherB) = _otherDigests(idx);

        pendingMigrateIdx = idx;
        pendingMigrateBalanceBefore = token.balanceOf(address(actor));
        (, uint256 bal, ) = _stakes(address(actor));
        pendingMigrateHadStake = bal > 0;
        pendingMigrateRegistryBalBefore = token.balanceOf(address(registry));

        bool ok = actor.migrateStake();
        if (!ok) return;

        if (!registry.paused()) migrateSucceededWhileUnpaused = true;
        _checkOtherDigestsUnchanged(idx, otherA, otherB);
        pendingMigrateCheck = true;

        if (pendingMigrateHadStake) {
            lastSetNonceByActor[idx] = bytes32(0);
        }
    }

    function act_admin_pause() external {
        _clearPendingChecks();
        bytes32 d0 = _stakeDigest(address(actors[0]));
        bytes32 d1 = _stakeDigest(address(actors[1]));
        bytes32 d2 = _stakeDigest(address(actors[2]));
        registry.pause();
        _checkDigestsUnchanged(d0, d1, d2);
    }

    function act_admin_unpause() external {
        _clearPendingChecks();
        bytes32 d0 = _stakeDigest(address(actors[0]));
        bytes32 d1 = _stakeDigest(address(actors[1]));
        bytes32 d2 = _stakeDigest(address(actors[2]));
        registry.unpause();
        _checkDigestsUnchanged(d0, d1, d2);
    }

    function act_redistributor_freeze(uint8 targetActorId, uint32 time) external {
        _clearPendingChecks();

        uint256 idx = uint256(targetActorId) % ACTOR_COUNT;
        address t = address(actors[idx]);
        (bytes32 otherA, bytes32 otherB) = _otherDigests(idx);

        bool ok = redistributor.tryFreezeDeposit(t, uint256(time));
        if (!ok) return;
        _checkOtherDigestsUnchanged(idx, otherA, otherB);
    }

    function act_actor_tryPause(uint8 actorId) external {
        _clearPendingChecks();
        bytes32 d0 = _stakeDigest(address(actors[0]));
        bytes32 d1 = _stakeDigest(address(actors[1]));
        bytes32 d2 = _stakeDigest(address(actors[2]));
        bool ok = _actor(actorId).tryPause();
        if (ok) unauthorizedAdminCallSucceeded = true;
        _checkDigestsUnchanged(d0, d1, d2);
    }

    function act_actor_tryUnpause(uint8 actorId) external {
        _clearPendingChecks();
        bytes32 d0 = _stakeDigest(address(actors[0]));
        bytes32 d1 = _stakeDigest(address(actors[1]));
        bytes32 d2 = _stakeDigest(address(actors[2]));
        bool ok = _actor(actorId).tryUnpause();
        if (ok) unauthorizedAdminCallSucceeded = true;
        _checkDigestsUnchanged(d0, d1, d2);
    }

    function act_actor_tryFreeze(uint8 actorId, uint8 targetActorId, uint32 time) external {
        _clearPendingChecks();
        bytes32 d0 = _stakeDigest(address(actors[0]));
        bytes32 d1 = _stakeDigest(address(actors[1]));
        bytes32 d2 = _stakeDigest(address(actors[2]));
        bool ok = _actor(actorId).tryFreezeDeposit(address(_actor(targetActorId)), uint256(time));
        if (ok) unauthorizedFreezeSucceeded = true;
        _checkDigestsUnchanged(d0, d1, d2);
    }

    // -----------------------------
    // Properties
    // -----------------------------

    function echidna_never_performed_forbidden_calls() external view returns (bool) {
        return
            !unauthorizedAdminCallSucceeded &&
            !unauthorizedFreezeSucceeded &&
            !pausedMutationSucceeded &&
            !actionInvariantViolated;
    }

    function echidna_migrate_never_succeeds_while_unpaused() external view returns (bool) {
        return !migrateSucceededWhileUnpaused;
    }

    function echidna_registry_balance_covers_previewed_balances() external view returns (bool) {
        uint256 sum;
        for (uint256 i = 0; i < ACTOR_COUNT; i++) {
            (, uint256 bal, ) = _stakes(address(actors[i]));
            sum += bal;
        }
        return token.balanceOf(address(registry)) >= sum;
    }

    function echidna_last_createDeposit_increases_registry_balance() external view returns (bool) {
        if (!pendingDepositCheck) return true;
        return token.balanceOf(address(registry)) == pendingRegistryBalanceBefore + pendingDepositAmount;
    }

    function echidna_frozen_accounts_have_zero_effective_stake() external view returns (bool) {
        for (uint256 i = 0; i < ACTOR_COUNT; i++) {
            address a = address(actors[i]);
            if (registry.freezeUntilBlock(a) >= block.number) {
                if (registry.nodeEffectiveStake(a) != 0) return false;
            }
        }
        return true;
    }

    function echidna_empty_overlay_means_zero_balance_and_height() external view returns (bool) {
        for (uint256 i = 0; i < ACTOR_COUNT; i++) {
            (bytes32 ov, uint256 bal, uint8 h) = _stakes(address(actors[i]));
            if (ov == bytes32(0)) {
                if (bal != 0 || h != 0) return false;
            }
        }
        return true;
    }

    function echidna_last_migrate_refunds_when_stake_exists() external view returns (bool) {
        if (!pendingMigrateCheck) return true;
        if (!registry.paused()) return false;

        address a = address(actors[pendingMigrateIdx]);
        (, uint256 balAfter, ) = _stakes(a);
        if (balAfter != 0) return false;

        // migrateStake also refunds queued create/add amounts even when preview balance was zero.
        return token.balanceOf(a) >= pendingMigrateBalanceBefore;
    }

    // -----------------------------
    // Internal helpers
    // -----------------------------

    function _actor(uint8 actorId) internal view returns (EchidnaStakingActor) {
        return actors[uint256(actorId) % ACTOR_COUNT];
    }

    function _stakes(address who) internal view returns (bytes32 ov, uint256 bal, uint8 h) {
        StakeRegistry.Stake memory s = registry.stakes(who);
        return (s.overlay, s.balance, s.height);
    }

    function _stakeDigest(address who) internal view returns (bytes32) {
        (bytes32 ov, uint256 bal, uint8 h) = _stakes(who);
        return keccak256(abi.encodePacked(ov, bal, h, registry.freezeUntilBlock(who)));
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

    function _checkDigestsUnchanged(bytes32 d0, bytes32 d1, bytes32 d2) internal {
        if (_stakeDigest(address(actors[0])) != d0) actionInvariantViolated = true;
        if (_stakeDigest(address(actors[1])) != d1) actionInvariantViolated = true;
        if (_stakeDigest(address(actors[2])) != d2) actionInvariantViolated = true;
    }

    function _clearPendingChecks() internal {
        pendingDepositCheck = false;
        pendingMigrateCheck = false;
    }

    function _reverse(uint64 input) internal pure returns (uint64 v) {
        v = input;
        v = ((v & 0xFF00FF00FF00FF00) >> 8) | ((v & 0x00FF00FF00FF00FF) << 8);
        v = ((v & 0xFFFF0000FFFF0000) >> 16) | ((v & 0x0000FFFF0000FFFF) << 16);
        v = (v >> 32) | (v << 32);
    }
}
