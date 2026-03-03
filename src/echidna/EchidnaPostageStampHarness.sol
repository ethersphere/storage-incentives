// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.19;

import "../TestToken.sol";
import "../PostageStamp.sol";

contract EchidnaPostageActor {
    TestToken internal immutable token;
    PostageStamp internal immutable stamp;

    constructor(TestToken token_, PostageStamp stamp_) {
        token = token_;
        stamp = stamp_;
        token.approve(address(stamp), type(uint256).max);
    }

    function createBatchMutable(
        uint256 initialBalancePerChunk,
        uint8 depth,
        uint8 bucketDepth,
        bytes32 nonce
    ) external returns (bool ok, bytes32 batchId) {
        bytes memory data;
        (ok, data) = address(stamp).call(
            abi.encodeWithSelector(
                stamp.createBatch.selector,
                address(this),
                initialBalancePerChunk,
                depth,
                bucketDepth,
                nonce,
                false
            )
        );
        if (ok && data.length >= 32) batchId = abi.decode(data, (bytes32));
    }

    function createBatchImmutable(
        uint256 initialBalancePerChunk,
        uint8 depth,
        uint8 bucketDepth,
        bytes32 nonce
    ) external returns (bool ok, bytes32 batchId) {
        bytes memory data;
        (ok, data) = address(stamp).call(
            abi.encodeWithSelector(
                stamp.createBatch.selector,
                address(this),
                initialBalancePerChunk,
                depth,
                bucketDepth,
                nonce,
                true
            )
        );
        if (ok && data.length >= 32) batchId = abi.decode(data, (bytes32));
    }

    function topUp(bytes32 batchId, uint256 topupAmountPerChunk) external returns (bool ok) {
        (ok, ) = address(stamp).call(abi.encodeWithSelector(stamp.topUp.selector, batchId, topupAmountPerChunk));
    }

    function increaseDepth(bytes32 batchId, uint8 newDepth) external returns (bool ok) {
        (ok, ) = address(stamp).call(abi.encodeWithSelector(stamp.increaseDepth.selector, batchId, newDepth));
    }

    function trySetPrice(uint256 price) external returns (bool ok) {
        (ok, ) = address(stamp).call(abi.encodeWithSelector(stamp.setPrice.selector, price));
    }

    function tryWithdraw(address beneficiary) external returns (bool ok) {
        (ok, ) = address(stamp).call(abi.encodeWithSelector(stamp.withdraw.selector, beneficiary));
    }

    function tryPause() external returns (bool ok) {
        (ok, ) = address(stamp).call(abi.encodeWithSelector(stamp.pause.selector));
    }

    function tryUnpause() external returns (bool ok) {
        (ok, ) = address(stamp).call(abi.encodeWithSelector(stamp.unPause.selector));
    }
}

/// @notice Echidna harness for PostageStamp state machine and invariants.
contract EchidnaPostageStampHarness {
    TestToken internal immutable token;
    PostageStamp internal immutable stamp;

    uint256 internal constant ACTOR_COUNT = 3;
    EchidnaPostageActor[3] internal actors;
    EchidnaPostageActor internal oracleActor;
    EchidnaPostageActor internal redistributorActor;
    EchidnaPostageActor internal pauserActor;

    // Ring buffer of observed batchIds.
    uint256 internal constant MAX_TRACKED = 16;
    bytes32[MAX_TRACKED] internal tracked;
    uint256 internal trackedCount;

    // Forbidden-call flags.
    bool internal unauthorizedPriceSetSucceeded;
    bool internal unauthorizedWithdrawSucceeded;
    bool internal unauthorizedPauseSucceeded;
    bool internal pausedMutationSucceeded;
    bool internal nonInterferenceViolated;

    // Pending postconditions (cleared on each action).
    bool internal pendingCreate;
    bytes32 internal pendingBatchId;
    uint256 internal pendingCreateTotalAmount;
    uint256 internal pendingStampTokenBalanceBefore;
    uint256 internal pendingCreateNormalisedExpected;
    uint8 internal pendingCreateDepth;
    uint8 internal pendingCreateBucketDepth;
    bool internal pendingCreateImmutable;

    bool internal pendingTopUp;
    bytes32 internal pendingTopUpBatchId;
    uint256 internal pendingTopUpTokenBefore;
    uint256 internal pendingTopUpNormalisedBefore;
    uint256 internal pendingTopUpTotalAmount;
    uint256 internal pendingTopUpPerChunk;

    bool internal pendingIncreaseDepth;
    bytes32 internal pendingIncBatchId;
    uint8 internal pendingIncOldDepth;
    uint8 internal pendingIncNewDepth;
    uint256 internal pendingIncValidChunkBefore;
    uint256 internal pendingIncTokenBefore;
    uint8 internal pendingIncBucketDepth;
    uint256 internal pendingIncExpectedNormalised;

    bool internal pendingExpireAll;

    bool internal pendingSetPrice;
    uint256 internal pendingSetPriceTotalOutPaymentBefore;
    uint64 internal pendingSetPriceLastUpdatedExpected;
    uint64 internal pendingSetPriceLastPriceExpected;

    bool internal pendingWithdraw;
    address internal pendingWithdrawBeneficiary;
    uint256 internal pendingWithdrawBeneficiaryBalBefore;
    uint256 internal pendingWithdrawExpectedAmount;
    uint256 internal pendingWithdrawStampBalBefore;

    // Temporary inputs to reduce stack pressure in helpers.
    bytes32 internal tmpNonce;
    bool internal tmpImmutable;
    bytes32 internal tmpBatchA;
    bytes32 internal tmpBatchB;
    bytes32 internal tmpDigestA;
    bytes32 internal tmpDigestB;

    constructor() {
        token = new TestToken("TestToken", "TT", 1_000_000_000_000_000_000_000_000); // 1e24
        stamp = new PostageStamp(address(token), 2);

        for (uint256 i = 0; i < ACTOR_COUNT; i++) {
            actors[i] = new EchidnaPostageActor(token, stamp);
            token.transfer(address(actors[i]), 1_000_000_000_000_000_000_000_00); // 1e23 / 10
        }

        oracleActor = new EchidnaPostageActor(token, stamp);
        redistributorActor = new EchidnaPostageActor(token, stamp);
        pauserActor = new EchidnaPostageActor(token, stamp);

        stamp.grantRole(stamp.PRICE_ORACLE_ROLE(), address(oracleActor));
        stamp.grantRole(stamp.REDISTRIBUTOR_ROLE(), address(redistributorActor));
        stamp.grantRole(stamp.PAUSER_ROLE(), address(pauserActor));
    }

    // -----------------------------
    // Actions
    // -----------------------------

    function act_fundActor(uint8 actorId, uint256 amount) external {
        _clearPending();
        uint256 bal = token.balanceOf(address(this));
        if (bal == 0) return;
        uint256 x = amount % (bal + 1);
        if (x == 0) return;
        token.transfer(address(_actor(actorId)), x);
    }

    function act_createBatch(uint8 actorId, uint256 initialPerChunk, uint8 depthRaw, bytes32 nonce, bool immutableFlag)
        external
    {
        _clearPending();
        // Normalize expiry so createBatch's internal expireLimited() doesn't unexpectedly mutate other batches.
        stamp.expireLimited(type(uint256).max);
        tmpNonce = nonce;
        tmpImmutable = immutableFlag;
        _createBatchInternal(actorId, initialPerChunk, depthRaw);
    }

    function act_topUp(uint8 actorId, uint8 batchIndex, uint256 topupPerChunk) external {
        _clearPending();
        EchidnaPostageActor a = _actor(actorId);

        if (stamp.paused()) {
            bool okPaused = a.topUp(_batch(batchIndex), 1);
            if (okPaused) pausedMutationSucceeded = true;
            return;
        }

        bytes32 batchId = _batch(batchIndex);
        if (batchId == bytes32(0)) return;
        _armNonInterference(batchIndex, batchId);

        // Only the creator can topUp (msg.sender irrelevant); topUp isn't owner gated but will revert if batch doesn't exist/expired.
        uint8 depth = stamp.batchDepth(batchId);
        if (depth == 0) return;

        uint256 maxPerChunk = token.balanceOf(address(a)) / (1 << depth);
        if (maxPerChunk == 0) return;
        uint256 perChunk = topupPerChunk % (maxPerChunk + 1);
        if (perChunk == 0) return;

        uint256 tokenBefore = token.balanceOf(address(stamp));
        uint256 normBefore = stamp.batchNormalisedBalance(batchId);
        uint256 totalAmount = perChunk * (1 << depth);

        bool ok = a.topUp(batchId, perChunk);
        if (!ok) return;
        _checkNonInterference(batchId);

        pendingTopUp = true;
        pendingTopUpBatchId = batchId;
        pendingTopUpTokenBefore = tokenBefore;
        pendingTopUpNormalisedBefore = normBefore;
        pendingTopUpTotalAmount = totalAmount;
        pendingTopUpPerChunk = perChunk;
    }

    function act_increaseDepth(uint8 actorId, uint8 batchIndex, uint8 newDepthRaw) external {
        _clearPending();
        EchidnaPostageActor a = _actor(actorId);

        if (stamp.paused()) {
            bool okPaused = a.increaseDepth(_batch(batchIndex), 3);
            if (okPaused) pausedMutationSucceeded = true;
            return;
        }

        bytes32 batchId = _batch(batchIndex);
        if (batchId == bytes32(0)) return;

        // increaseDepth is owner-gated; we only attempt if the batch owner matches this actor.
        if (stamp.batchOwner(batchId) != address(a)) return;

        // Normalize state to avoid this call also expiring unrelated batches (it calls expireLimited internally).
        stamp.expireLimited(type(uint256).max);

        uint8 oldDepth = stamp.batchDepth(batchId);
        if (oldDepth == 0) return;

        uint8 minBucket = stamp.minimumBucketDepth();
        uint8 newDepth = uint8(minBucket + 1 + (newDepthRaw % 12));
        if (newDepth <= oldDepth) return;

        uint256 validBefore = stamp.validChunkCount();
        uint256 tokenBefore = token.balanceOf(address(stamp));
        uint8 bucketDepthBefore = stamp.batchBucketDepth(batchId);

        uint256 ctopBefore = stamp.currentTotalOutPayment();
        uint256 remainingBefore = stamp.remainingBalance(batchId);
        uint8 depthChange = newDepth - oldDepth;
        uint256 expectedNormalisedAfter = ctopBefore + (remainingBefore / (1 << depthChange));

        _armNonInterference(batchIndex, batchId);

        bool ok = a.increaseDepth(batchId, newDepth);
        if (!ok) return;
        _checkNonInterference(batchId);

        pendingIncreaseDepth = true;
        pendingIncBatchId = batchId;
        pendingIncOldDepth = oldDepth;
        pendingIncNewDepth = newDepth;
        pendingIncValidChunkBefore = validBefore;
        pendingIncTokenBefore = tokenBefore;
        pendingIncBucketDepth = bucketDepthBefore;
        pendingIncExpectedNormalised = expectedNormalisedAfter;
    }

    function act_oracle_setPrice(uint256 price) external {
        _clearPending();
        bool ok = oracleActor.trySetPrice(price);
        if (!ok) return;

        pendingSetPrice = true;
        pendingSetPriceLastUpdatedExpected = uint64(block.number);
        pendingSetPriceLastPriceExpected = uint64(price);
        // Capture the exact base total payout immediately after setting the price.
        // At this point `lastUpdatedBlock == block.number`, so `currentTotalOutPayment()` equals `totalOutPayment`.
        pendingSetPriceTotalOutPaymentBefore = stamp.currentTotalOutPayment();
    }

    function act_expireAll() external {
        _clearPending();
        stamp.expireLimited(type(uint256).max);
        pendingExpireAll = true;
    }

    function act_redistributor_withdraw(uint8 beneficiaryActorId) external {
        _clearPending();
        address beneficiary = address(_actor(beneficiaryActorId));
        if (beneficiary == address(0)) beneficiary = address(0xBEEF);

        uint256 amount = stamp.totalPot();
        uint256 balBefore = token.balanceOf(beneficiary);
        uint256 stampBalBefore = token.balanceOf(address(stamp));

        bool ok = redistributorActor.tryWithdraw(beneficiary);
        if (!ok) return;

        pendingWithdraw = true;
        pendingWithdrawBeneficiary = beneficiary;
        pendingWithdrawBeneficiaryBalBefore = balBefore;
        pendingWithdrawStampBalBefore = stampBalBefore;
        pendingWithdrawExpectedAmount = amount;
    }

    function act_pauser_pause() external {
        _clearPending();
        pauserActor.tryPause();
    }

    function act_pauser_unpause() external {
        _clearPending();
        pauserActor.tryUnpause();
    }

    function act_rando_trySetPrice(uint8 actorId, uint256 price) external {
        _clearPending();
        bool ok = _actor(actorId).trySetPrice(price);
        if (ok) unauthorizedPriceSetSucceeded = true;
    }

    function act_rando_tryWithdraw(uint8 actorId, address beneficiary) external {
        _clearPending();
        if (beneficiary == address(0)) beneficiary = address(0xBEEF);
        bool ok = _actor(actorId).tryWithdraw(beneficiary);
        if (ok) unauthorizedWithdrawSucceeded = true;
    }

    function act_rando_tryPause(uint8 actorId) external {
        _clearPending();
        bool ok = _actor(actorId).tryPause();
        if (ok) unauthorizedPauseSucceeded = true;
    }

    function act_rando_tryUnpause(uint8 actorId) external {
        _clearPending();
        bool ok = _actor(actorId).tryUnpause();
        if (ok) unauthorizedPauseSucceeded = true;
    }

    // -----------------------------
    // Properties
    // -----------------------------

    function echidna_never_performed_forbidden_calls() external view returns (bool) {
        return
            !unauthorizedPriceSetSucceeded &&
            !unauthorizedWithdrawSucceeded &&
            !unauthorizedPauseSucceeded &&
            !pausedMutationSucceeded &&
            !nonInterferenceViolated;
    }

    function echidna_minimumInitialBalancePerChunk_matches_formula() external view returns (bool) {
        return stamp.minimumInitialBalancePerChunk() == uint256(stamp.minimumValidityBlocks()) * uint256(stamp.lastPrice());
    }

    function echidna_lastExpiryBalance_never_exceeds_currentTotalOutPayment() external view returns (bool) {
        return stamp.lastExpiryBalance() <= stamp.currentTotalOutPayment();
    }

    function echidna_createBatch_postconditions_hold() external view returns (bool) {
        if (!pendingCreate) return true;

        if (token.balanceOf(address(stamp)) != pendingStampTokenBalanceBefore + pendingCreateTotalAmount) return false;

        if (stamp.batchOwner(pendingBatchId) == address(0)) return false;
        if (stamp.batchDepth(pendingBatchId) != pendingCreateDepth) return false;
        if (stamp.batchBucketDepth(pendingBatchId) != pendingCreateBucketDepth) return false;
        if (stamp.batchImmutableFlag(pendingBatchId) != pendingCreateImmutable) return false;

        // Normalised balance is computed as currentTotalOutPayment + perChunk at creation time.
        if (stamp.batchNormalisedBalance(pendingBatchId) != pendingCreateNormalisedExpected) return false;
        return true;
    }

    function echidna_topUp_postconditions_hold() external view returns (bool) {
        if (!pendingTopUp) return true;
        if (token.balanceOf(address(stamp)) != pendingTopUpTokenBefore + pendingTopUpTotalAmount) return false;
        return stamp.batchNormalisedBalance(pendingTopUpBatchId) == pendingTopUpNormalisedBefore + pendingTopUpPerChunk;
    }

    function echidna_increaseDepth_updates_validChunkCount_and_keeps_balance() external view returns (bool) {
        if (!pendingIncreaseDepth) return true;
        if (token.balanceOf(address(stamp)) != pendingIncTokenBefore) return false;

        uint256 expectedDelta = (1 << pendingIncNewDepth) - (1 << pendingIncOldDepth);
        if (stamp.validChunkCount() != pendingIncValidChunkBefore + expectedDelta) return false;

        if (stamp.batchDepth(pendingIncBatchId) != pendingIncNewDepth) return false;
        if (stamp.batchBucketDepth(pendingIncBatchId) != pendingIncBucketDepth) return false;
        if (stamp.batchNormalisedBalance(pendingIncBatchId) != pendingIncExpectedNormalised) return false;
        return true;
    }

    function echidna_expireAll_clears_expired_batches() external view returns (bool) {
        if (!pendingExpireAll) return true;
        return !stamp.expiredBatchesExist();
    }

    function echidna_setPrice_postconditions_hold() external view returns (bool) {
        if (!pendingSetPrice) return true;
        if (stamp.lastUpdatedBlock() != pendingSetPriceLastUpdatedExpected) return false;
        if (stamp.lastPrice() != pendingSetPriceLastPriceExpected) return false;
        uint256 blocksSince = block.number - uint256(pendingSetPriceLastUpdatedExpected);
        uint256 expected = pendingSetPriceTotalOutPaymentBefore + uint256(pendingSetPriceLastPriceExpected) * blocksSince;
        return stamp.currentTotalOutPayment() == expected;
    }

    function echidna_withdraw_postconditions_hold() external view returns (bool) {
        if (!pendingWithdraw) return true;
        if (stamp.pot() != 0) return false;
        if (token.balanceOf(pendingWithdrawBeneficiary) != pendingWithdrawBeneficiaryBalBefore + pendingWithdrawExpectedAmount)
            return false;
        return token.balanceOf(address(stamp)) == pendingWithdrawStampBalBefore - pendingWithdrawExpectedAmount;
    }

    // -----------------------------
    // Helpers
    // -----------------------------

    function _actor(uint8 actorId) internal view returns (EchidnaPostageActor) {
        return actors[uint256(actorId) % ACTOR_COUNT];
    }

    function _batch(uint8 batchIndex) internal view returns (bytes32) {
        if (trackedCount == 0) return bytes32(0);
        return tracked[uint256(batchIndex) % MAX_TRACKED];
    }

    function _clearPending() internal {
        pendingCreate = false;
        pendingTopUp = false;
        pendingIncreaseDepth = false;
        pendingExpireAll = false;
        pendingSetPrice = false;
        pendingWithdraw = false;
    }

    function _batchDigest(bytes32 batchId) internal view returns (bytes32) {
        address owner = stamp.batchOwner(batchId);
        if (owner == address(0)) return bytes32(0);
        return keccak256(
            abi.encodePacked(
                owner,
                stamp.batchDepth(batchId),
                stamp.batchBucketDepth(batchId),
                stamp.batchImmutableFlag(batchId),
                stamp.batchNormalisedBalance(batchId),
                stamp.batchLastUpdatedBlockNumber(batchId)
            )
        );
    }

    function _armNonInterference(uint8 batchIndex, bytes32 target) internal {
        tmpBatchA = _batch(uint8(batchIndex + 1));
        tmpBatchB = _batch(uint8(batchIndex + 2));
        if (tmpBatchA == target) tmpBatchA = bytes32(0);
        if (tmpBatchB == target) tmpBatchB = bytes32(0);
        tmpDigestA = tmpBatchA == bytes32(0) ? bytes32(0) : _batchDigest(tmpBatchA);
        tmpDigestB = tmpBatchB == bytes32(0) ? bytes32(0) : _batchDigest(tmpBatchB);
    }

    function _checkNonInterference(bytes32 target) internal {
        target;
        if (tmpBatchA != bytes32(0) && _batchDigest(tmpBatchA) != tmpDigestA) nonInterferenceViolated = true;
        if (tmpBatchB != bytes32(0) && _batchDigest(tmpBatchB) != tmpDigestB) nonInterferenceViolated = true;
    }

    function _createBatchInternal(uint8 actorId, uint256 initialPerChunk, uint8 depthRaw) internal {
        if (stamp.paused()) return;

        EchidnaPostageActor a = _actor(actorId);

        // Bound depth and bucketDepth to safe values.
        uint8 depth = uint8(2 + (depthRaw % 12)); // [2..13]
        uint8 minBucket = stamp.minimumBucketDepth();
        if (minBucket >= depth) return;
        uint8 bucketDepth = uint8(minBucket + (uint8(uint256(tmpNonce) % uint256(depth - minBucket))));
        if (bucketDepth >= depth) return;

        // Bound initialPerChunk and ensure actor can pay.
        uint256 available = token.balanceOf(address(a));
        uint256 denom = (1 << depth);
        uint256 maxPerChunk = available / denom;
        if (maxPerChunk == 0) return;
        uint256 perChunk = (initialPerChunk % maxPerChunk) + 1; // non-zero

        // Store pre-call snapshots directly into pending fields (to reduce stack pressure).
        pendingStampTokenBalanceBefore = token.balanceOf(address(stamp));
        pendingCreateTotalAmount = perChunk * denom;
        pendingCreateNormalisedExpected = stamp.currentTotalOutPayment() + perChunk;
        pendingCreateDepth = depth;
        pendingCreateBucketDepth = bucketDepth;
        pendingCreateImmutable = tmpImmutable;

        bool ok;
        bytes32 batchId;
        if (tmpImmutable) {
            (ok, batchId) = a.createBatchImmutable(perChunk, depth, bucketDepth, tmpNonce);
        } else {
            (ok, batchId) = a.createBatchMutable(perChunk, depth, bucketDepth, tmpNonce);
        }
        if (!ok || batchId == bytes32(0)) return;

        tracked[trackedCount % MAX_TRACKED] = batchId;
        trackedCount++;

        pendingBatchId = batchId;
        pendingCreate = true;
    }
}

