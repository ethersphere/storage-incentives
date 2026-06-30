// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.19;

import "../PriceOracle.sol";

contract EchidnaPostageStampMock {
    uint256 public lastPrice;
    uint256 public setPriceCalls;
    bool public shouldRevert;

    function setShouldRevert(bool v) external {
        shouldRevert = v;
    }

    function setPrice(uint256 price) external {
        if (shouldRevert) revert("mock revert");
        lastPrice = price;
        setPriceCalls += 1;
    }
}

contract EchidnaOracleActor {
    PriceOracle internal immutable oracle;

    constructor(PriceOracle oracle_) {
        oracle = oracle_;
    }

    function callSetPrice(uint32 p) external returns (bool ok, bool returned) {
        bytes memory data;
        (ok, data) = address(oracle).call(abi.encodeWithSelector(oracle.setPrice.selector, p));
        returned = ok && data.length >= 32 ? abi.decode(data, (bool)) : false;
    }

    function callAdjustPrice(uint16 r) external returns (bool ok, bool returned) {
        bytes memory data;
        (ok, data) = address(oracle).call(abi.encodeWithSelector(oracle.adjustPrice.selector, r));
        returned = ok && data.length >= 32 ? abi.decode(data, (bool)) : false;
    }

    function callPause() external returns (bool ok) {
        (ok, ) = address(oracle).call(abi.encodeWithSelector(oracle.pause.selector));
    }

    function callUnpause() external returns (bool ok) {
        (ok, ) = address(oracle).call(abi.encodeWithSelector(oracle.unPause.selector));
    }
}

/// @notice Echidna harness for comprehensive fuzzing of PriceOracle.
contract EchidnaPriceOracleHarness {
    PriceOracle internal immutable oracle;
    EchidnaPostageStampMock internal immutable stamp;

    EchidnaOracleActor internal immutable updater;
    EchidnaOracleActor internal immutable rando;

    // “Must never happen” flags.
    bool internal unauthorizedAdminCallSucceeded;
    bool internal unauthorizedAdjustSucceeded;
    bool internal pausedAdjustChangedState;

    // Pending post-conditions (cleared on each action).
    bool internal pendingSetPrice;
    uint64 internal pendingExpectedUpScaled;
    uint256 internal pendingStampCallsBefore;
    bool internal pendingStampShouldCall;

    bool internal pendingAdjust;
    bool internal pendingAdjustPaused;
    uint64 internal pendingPriceBefore;
    uint64 internal pendingLastAdjustedBefore;
    uint64 internal pendingExpectedLastAdjustedAfter;
    uint64 internal pendingExpectedUpScaledAfter;
    uint256 internal pendingAdjustStampCallsBefore;
    bool internal pendingAdjustStampShouldCall;
    bool internal adjustWouldOverflowButSucceeded;

    constructor() {
        stamp = new EchidnaPostageStampMock();
        oracle = new PriceOracle(address(stamp));

        updater = new EchidnaOracleActor(oracle);
        rando = new EchidnaOracleActor(oracle);

        oracle.grantRole(oracle.PRICE_UPDATER_ROLE(), address(updater));
    }

    // -----------------------------
    // Actions
    // -----------------------------

    function act_setStampRevertMode(bool v) external {
        _clearPending();
        stamp.setShouldRevert(v);
    }

    function act_admin_setPrice(uint32 p) external {
        _clearPending();

        uint256 callsBefore = stamp.setPriceCalls();
        (bool ok, bool returned) = _callSetPriceAsAdmin(p);

        // Do not arm postconditions unless the call fully succeeded; otherwise
        // `pendingSetPrice` would not match what the contract actually did (e.g. stamp callback failed).
        if (!ok || !returned) return;

        pendingStampCallsBefore = callsBefore;
        pendingExpectedUpScaled = oracle.currentPriceUpScaled();
        pendingStampShouldCall = !stamp.shouldRevert();
        pendingSetPrice = true;
    }

    function act_admin_pause() external {
        _clearPending();
        oracle.pause();
    }

    function act_admin_unpause() external {
        _clearPending();
        oracle.unPause();
    }

    function act_updater_adjustPrice(uint16 redundancy) external {
        _clearPending();

        pendingAdjustPaused = oracle.isPaused();
        pendingPriceBefore = oracle.currentPriceUpScaled();
        pendingLastAdjustedBefore = oracle.lastAdjustedRound();
        pendingAdjustStampCallsBefore = stamp.setPriceCalls();

        (bool ok, bool returned) = updater.callAdjustPrice(redundancy);

        if (pendingAdjustPaused) {
            if (
                oracle.currentPriceUpScaled() != pendingPriceBefore ||
                oracle.lastAdjustedRound() != pendingLastAdjustedBefore ||
                stamp.setPriceCalls() != pendingAdjustStampCallsBefore
            ) {
                pausedAdjustChangedState = true;
            }
            return;
        }

        // Not paused. Determine whether the call is expected to revert on basic guards.
        uint64 currentRound = oracle.currentRound();
        bool wouldRevertEarly = (redundancy == 0) || (currentRound <= pendingLastAdjustedBefore);

        if (wouldRevertEarly) {
            if (ok) adjustWouldOverflowButSucceeded = true;
            if (
                oracle.currentPriceUpScaled() != pendingPriceBefore ||
                oracle.lastAdjustedRound() != pendingLastAdjustedBefore ||
                stamp.setPriceCalls() != pendingAdjustStampCallsBefore
            ) {
                pausedAdjustChangedState = true;
            }
            return;
        }

        // Compute expected post-state. If arithmetic would overflow in the contract, we expect a revert.
        (bool canCompute, uint64 expected) = _tryExpectedAdjustedPrice(
            pendingPriceBefore,
            redundancy,
            currentRound,
            pendingLastAdjustedBefore
        );

        if (!canCompute) {
            if (ok && returned) adjustWouldOverflowButSucceeded = true;
            return;
        }

        if (!ok) {
            adjustWouldOverflowButSucceeded = true;
            return;
        }

        pendingExpectedLastAdjustedAfter = currentRound;
        pendingExpectedUpScaledAfter = expected;
        pendingAdjustStampShouldCall = !stamp.shouldRevert();
        pendingAdjust = true;
    }

    function act_rando_tryAdjustPrice(uint16 redundancy) external {
        _clearPending();
        (bool ok, bool returned) = rando.callAdjustPrice(redundancy);
        // When not paused, adjustPrice is role-gated and should not succeed for a rando.
        if (!oracle.isPaused() && ok && returned) unauthorizedAdjustSucceeded = true;
    }

    function act_rando_trySetPrice(uint32 p) external {
        _clearPending();
        (bool ok, bool returned) = rando.callSetPrice(p);
        if (ok && returned) unauthorizedAdminCallSucceeded = true;
    }

    function act_rando_tryPause() external {
        _clearPending();
        bool ok = rando.callPause();
        if (ok) unauthorizedAdminCallSucceeded = true;
    }

    function act_rando_tryUnpause() external {
        _clearPending();
        bool ok = rando.callUnpause();
        if (ok) unauthorizedAdminCallSucceeded = true;
    }

    // -----------------------------
    // Properties
    // -----------------------------

    function echidna_never_performed_forbidden_calls() external view returns (bool) {
        return
            !unauthorizedAdminCallSucceeded &&
            !unauthorizedAdjustSucceeded &&
            !pausedAdjustChangedState &&
            !adjustWouldOverflowButSucceeded;
    }

    function echidna_price_never_below_minimum() external view returns (bool) {
        return oracle.currentPriceUpScaled() >= oracle.minimumPriceUpscaled();
    }

    function echidna_lastAdjustedRound_not_in_future() external view returns (bool) {
        return oracle.lastAdjustedRound() <= oracle.currentRound();
    }

    function echidna_setPrice_updates_expected_state_and_calls_stamp() external view returns (bool) {
        if (!pendingSetPrice) return true;
        if (oracle.currentPriceUpScaled() != pendingExpectedUpScaled) return false;
        if (oracle.currentPrice() != uint32(pendingExpectedUpScaled >> 10)) return false;

        uint256 callsAfter = stamp.setPriceCalls();
        if (pendingStampShouldCall) {
            if (callsAfter != pendingStampCallsBefore + 1) return false;
            if (stamp.lastPrice() != uint256(oracle.currentPrice())) return false;
        } else {
            if (callsAfter != pendingStampCallsBefore) return false;
        }
        return true;
    }

    function echidna_adjustPrice_postconditions_hold_when_applicable() external view returns (bool) {
        if (!pendingAdjust) return true;

        if (oracle.lastAdjustedRound() != pendingExpectedLastAdjustedAfter) return false;
        if (oracle.currentPriceUpScaled() != pendingExpectedUpScaledAfter) return false;
        if (oracle.currentPrice() != uint32(pendingExpectedUpScaledAfter >> 10)) return false;

        uint256 callsAfter = stamp.setPriceCalls();
        if (pendingAdjustStampShouldCall) {
            if (callsAfter != pendingAdjustStampCallsBefore + 1) return false;
            if (stamp.lastPrice() != uint256(oracle.currentPrice())) return false;
        } else {
            if (callsAfter != pendingAdjustStampCallsBefore) return false;
        }
        return true;
    }

    // -----------------------------
    // Helpers
    // -----------------------------

    function _callSetPriceAsAdmin(uint32 p) internal returns (bool ok, bool returned) {
        // This harness is the admin because it deployed PriceOracle.
        bytes memory data;
        (ok, data) = address(oracle).call(abi.encodeWithSelector(oracle.setPrice.selector, p));
        returned = ok && data.length >= 32 ? abi.decode(data, (bool)) : false;
    }

    function _tryExpectedAdjustedPrice(
        uint64 priceUpScaledBefore,
        uint16 redundancy,
        uint64 currentRound,
        uint64 lastAdjusted
    ) internal view returns (bool ok, uint64 expected) {
        uint16 used = redundancy;
        uint16 maxRed = uint16(4 + 4);
        if (used > maxRed) used = maxRed;

        uint256 price = uint256(priceUpScaledBefore);
        uint256 base = uint256(oracle.priceBase());

        uint256 rate = uint256(oracle.changeRate(uint256(used)));
        // In the real contract, this multiplication happens in uint64 space:
        // uint32 * uint64 -> uint64, and would revert on overflow.
        if (rate * price > type(uint64).max) return (false, 0);
        price = (rate * price) / base;

        uint64 skipped = currentRound - lastAdjusted - 1;
        if (skipped > 0) {
            uint256 rateMax = uint256(oracle.changeRate(0));
            for (uint64 i = 0; i < skipped; i++) {
                if (rateMax * price > type(uint64).max) return (false, 0);
                price = (rateMax * price) / base;
            }
        }

        uint256 minUp = uint256(oracle.minimumPriceUpscaled());
        if (price < minUp) price = minUp;
        if (price > type(uint64).max) return (false, 0);
        return (true, uint64(price));
    }

    function _clearPending() internal {
        pendingSetPrice = false;
        pendingAdjust = false;
        pendingExpectedUpScaled = 0;
        pendingStampCallsBefore = 0;
        pendingStampShouldCall = false;
        pendingAdjustPaused = false;
        pendingPriceBefore = 0;
        pendingLastAdjustedBefore = 0;
        pendingExpectedLastAdjustedAfter = 0;
        pendingExpectedUpScaledAfter = 0;
        pendingAdjustStampCallsBefore = 0;
        pendingAdjustStampShouldCall = false;
        adjustWouldOverflowButSucceeded = false;
    }
}
