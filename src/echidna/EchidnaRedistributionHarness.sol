// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.19;

import "../Redistribution.sol";
import "../Util/Constants.sol";
import "../interface/IPostageStamp.sol";
import "./RedistributionExposed.sol";
import "./EchidnaMocks.sol";

contract EchidnaPostageStampMock is IPostageStamp {
    uint256 public withdrawCalls;
    address public lastBeneficiary;
    uint256 public validChunkCountValue;

    function setValidChunkCount(uint256 v) external {
        validChunkCountValue = v;
    }

    function withdraw(address beneficiary) external {
        withdrawCalls += 1;
        lastBeneficiary = beneficiary;
    }

    function setPrice(uint256) external {}

    function validChunkCount() external view returns (uint256) {
        return validChunkCountValue;
    }

    function batchOwner(bytes32) external pure returns (address) {
        return address(0);
    }
    function batchDepth(bytes32) external pure returns (uint8) {
        return 0;
    }
    function batchBucketDepth(bytes32) external pure returns (uint8) {
        return 0;
    }
    function remainingBalance(bytes32) external pure returns (uint256) {
        return 1;
    }
    function minimumInitialBalancePerChunk() external pure returns (uint256) {
        return 1;
    }
    function batches(
        bytes32
    )
        external
        pure
        returns (
            address owner,
            uint8 depth,
            uint8 bucketDepth,
            bool immutableFlag,
            uint256 normalisedBalance,
            uint256 lastUpdatedBlockNumber
        )
    {
        return (address(0), 0, 0, false, 0, 0);
    }
}

contract EchidnaRedistributionActor {
    RedistributionExposed internal immutable redist;

    constructor(RedistributionExposed r) {
        redist = r;
    }

    function callCommit(bytes32 obfuscatedHash, uint64 roundNumber) external returns (bool ok) {
        (ok, ) = address(redist).call(abi.encodeWithSelector(redist.commit.selector, obfuscatedHash, roundNumber));
    }

    function callReveal(uint8 depth, bytes32 hash, bytes32 nonce) external returns (bool ok) {
        (ok, ) = address(redist).call(abi.encodeWithSelector(redist.reveal.selector, depth, hash, nonce));
    }

    function callClaim() external returns (bool ok) {
        // Create minimal calldata that avoids immediate out-of-bounds panics.
        Redistribution.ChunkInclusionProof memory p;
        p.proofSegments = new bytes32[](1);
        p.proofSegments2 = new bytes32[](0);
        p.proofSegments3 = new bytes32[](0);
        p.socProof = new Redistribution.SOCProof[](0);

        (ok, ) = address(redist).call(abi.encodeWithSelector(redist.claim.selector, p, p, p));
    }

    function callWinnerSelection() external returns (bool ok) {
        (ok, ) = address(redist).call(abi.encodeWithSelector(redist.exposedWinnerSelection.selector));
    }
}

/// @notice Base Echidna harness for Redistribution.
/// @dev Focuses on commit/reveal state-machine consistency and winnerSelection postconditions.
contract EchidnaRedistributionHarness {
    EchidnaStakeRegistryMock internal immutable stakeMock;
    EchidnaPostageStampMock internal immutable stampMock;
    EchidnaPriceOracleMock internal immutable oracleMock;
    RedistributionExposed internal immutable redist;

    uint256 internal constant ACTOR_COUNT = 3;
    /// @dev Cap scans; must match pending winnerSelection snapshot arrays (size 25).
    uint256 internal constant MAX_COMMIT_REVEAL_SCAN = 25;
    EchidnaRedistributionActor[3] internal actors;

    bool internal winnerSelectionSucceededTwiceSameRound;

    // Pending winnerSelection postconditions.
    bool internal pendingWinnerSelection;
    uint64 internal pendingWinnerSelectionRound;
    uint8 internal pendingWinnerSelectionLen;
    address[25] internal pendingWSOwners;
    bool[25] internal pendingWSRevealed;
    uint256[25] internal pendingWSFreezeCountBefore;

    uint64 internal lastWinnerSelectionRound;

    // Tracked "happy-path" state per actor (used to assert strong postconditions when we succeed).
    bool[3] internal trackedHasCommit;
    bool[3] internal trackedHasReveal;
    uint64[3] internal trackedRound;
    bytes32[3] internal trackedOverlay;
    uint8[3] internal trackedHeight;
    uint8[3] internal trackedDepth;
    uint256[3] internal trackedStake;
    bytes32[3] internal trackedReserveHash;
    bytes32[3] internal trackedNonce;
    bytes32[3] internal trackedObfuscated;

    struct CommitView {
        bytes32 overlay;
        address owner;
        bool revealed;
        uint8 height;
        uint256 stake;
        bytes32 obfuscatedHash;
        uint256 revealIndex;
    }

    struct RevealView {
        bytes32 overlay;
        address owner;
        uint8 depth;
        uint256 stake;
        uint256 stakeDensity;
        bytes32 hash;
    }

    constructor() {
        stakeMock = new EchidnaStakeRegistryMock();
        stampMock = new EchidnaPostageStampMock();
        oracleMock = new EchidnaPriceOracleMock();

        redist = new RedistributionExposed(address(stakeMock), address(stampMock), address(oracleMock));

        for (uint256 i = 0; i < ACTOR_COUNT; i++) {
            actors[i] = new EchidnaRedistributionActor(redist);
            // Seed a stake that will eventually satisfy commit constraints once block.number is large enough.
            stakeMock.setNode(address(actors[i]), bytes32(uint256(i + 1)), 0, 1e18, 1);
        }
    }

    function _clearWinnerSelectionPending() internal {
        pendingWinnerSelection = false;
        pendingWinnerSelectionLen = 0;
    }

    function _boundedCommitsLen() internal view returns (uint256) {
        uint256 n = redist.currentCommitsLength();
        return n > MAX_COMMIT_REVEAL_SCAN ? MAX_COMMIT_REVEAL_SCAN : n;
    }

    function _boundedRevealsLen() internal view returns (uint256) {
        uint256 n = redist.currentRevealsLength();
        return n > MAX_COMMIT_REVEAL_SCAN ? MAX_COMMIT_REVEAL_SCAN : n;
    }

    // -----------------------------
    // Actions
    // -----------------------------

    /// @dev No-op that lets Echidna advance block.number without side effects,
    /// helping the fuzzer walk through round phases.
    function act_tick() external {}

    function act_setActorStake(
        uint8 actorId,
        bytes32 overlay,
        uint8 height,
        uint256 effectiveStake,
        uint256 lastUpdated
    ) external {
        _clearWinnerSelectionPending();
        EchidnaRedistributionActor a = actors[uint256(actorId) % ACTOR_COUNT];
        // Bound height so 2**depthResponsibility doesn't explode too hard during reveal.
        uint8 h = uint8(height % 16);
        // Avoid lastUpdated=0 unless we want NotStaked; keep at least 1.
        uint256 u = lastUpdated == 0 ? 1 : lastUpdated;
        uint256 stake = _boundStake(effectiveStake);
        stakeMock.setNode(address(a), overlay, h, stake, u);
    }

    function act_commit(uint8 actorId, bytes32 obfuscatedHash, int8 roundDelta) external {
        _clearWinnerSelectionPending();
        EchidnaRedistributionActor a = actors[uint256(actorId) % ACTOR_COUNT];
        uint64 cr = redist.currentRound();
        uint64 rn = cr;
        if (roundDelta < 0 && uint64(uint8(-roundDelta)) < cr) rn = cr - uint64(uint8(-roundDelta));
        if (roundDelta > 0) rn = cr + uint64(uint8(roundDelta));
        a.callCommit(obfuscatedHash, rn);
    }

    function act_reveal(uint8 actorId, uint8 depth, bytes32 hash, bytes32 nonce) external {
        _clearWinnerSelectionPending();
        EchidnaRedistributionActor a = actors[uint256(actorId) % ACTOR_COUNT];
        a.callReveal(uint8(depth % 32), hash, nonce);
    }

    function act_claim(uint8 actorId) external {
        _clearWinnerSelectionPending();
        EchidnaRedistributionActor a = actors[uint256(actorId) % ACTOR_COUNT];
        a.callClaim();
    }

    function act_admin_pause() external {
        _clearWinnerSelectionPending();
        redist.pause();
    }

    function act_admin_unpause() external {
        _clearWinnerSelectionPending();
        redist.unPause();
    }

    function act_admin_setSampleMaxValue(uint256 v) external {
        _clearWinnerSelectionPending();
        redist.setSampleMaxValue(v);
    }

    function act_admin_setFreezingParams(uint8 a, uint8 b, uint8 c) external {
        _clearWinnerSelectionPending();
        redist.setFreezingParams(a, b, c);
    }

    // -----------------------------
    // Advanced actions (aim for successful commit/reveal)
    // -----------------------------

    function act_happyCommit(
        uint8 actorId,
        uint8 height,
        uint256 stakeAmount,
        bytes32 reserveHash,
        bytes32 nonce
    ) external {
        _clearWinnerSelectionPending();
        if (redist.paused()) return;
        if (!redist.currentPhaseCommit()) return;
        // Avoid the "phase last block" restriction in commit phase.
        if (block.number % Constants.ROUND_LENGTH == Constants.PHASE_LENGTH - 1) return;

        uint256 idx = uint256(actorId) % ACTOR_COUNT;
        EchidnaRedistributionActor a = actors[idx];

        // Pick a unique overlay per actor that still has a high chance of being eligible.
        // We set depthResponsibility = 0 (depth == height), which makes proximity always pass.
        bytes32 anchor = redist.currentRoundAnchor();
        bytes32 overlay = keccak256(abi.encodePacked("overlay", idx, anchor));

        uint8 h = uint8(height % 16);
        uint8 d = h;
        uint256 stake = _boundStake(stakeAmount);
        uint256 lastUpdated = _backdateLastUpdated();

        // Set node data so commit checks can pass.
        stakeMock.setNode(address(a), overlay, h, stake, lastUpdated);

        // Avoid reverting on AlreadyCommitted for identical overlay.
        if (_commitOverlayExists(overlay)) return;

        bytes32 obfuscated = redist.wrapCommit(overlay, d, reserveHash, nonce);
        bool ok = a.callCommit(obfuscated, redist.currentRound());
        if (!ok) return;

        trackedHasCommit[idx] = true;
        trackedHasReveal[idx] = false;
        trackedRound[idx] = redist.currentRound();
        trackedOverlay[idx] = overlay;
        trackedHeight[idx] = h;
        trackedDepth[idx] = d;
        trackedStake[idx] = stake;
        trackedReserveHash[idx] = reserveHash;
        trackedNonce[idx] = nonce;
        trackedObfuscated[idx] = obfuscated;
    }

    function act_happyReveal(uint8 actorId) external {
        _clearWinnerSelectionPending();
        if (redist.paused()) return;
        if (!redist.currentPhaseReveal()) return;

        uint256 idx = uint256(actorId) % ACTOR_COUNT;
        if (!trackedHasCommit[idx] || trackedHasReveal[idx]) return;

        // Reveal must happen in the same round that received commits.
        if (redist.currentRound() != trackedRound[idx]) return;
        if (redist.currentCommitRound() != trackedRound[idx]) return;

        EchidnaRedistributionActor a = actors[idx];
        // Ensure the actor's overlay/height match the committed values.
        stakeMock.setNode(
            address(a),
            trackedOverlay[idx],
            trackedHeight[idx],
            trackedStake[idx],
            _backdateLastUpdated()
        );

        bool ok = a.callReveal(trackedDepth[idx], trackedReserveHash[idx], trackedNonce[idx]);
        if (!ok) return;

        trackedHasReveal[idx] = true;
    }

    function act_winnerSelection(uint8 actorId) external {
        _clearWinnerSelectionPending();
        uint256 idx = uint256(actorId) % ACTOR_COUNT;
        // Snapshot current commits (bounded) and freeze counts before selection.
        pendingWinnerSelectionRound = redist.currentRound();

        uint256 commitLim = _boundedCommitsLen();
        for (uint256 i = 0; i < commitLim; i++) {
            (bool ok, bytes memory data) = address(redist).staticcall(
                abi.encodeWithSignature("currentCommits(uint256)", i)
            );
            if (!ok) break;
            CommitView memory cv = abi.decode(data, (CommitView));
            pendingWSOwners[i] = cv.owner;
            pendingWSRevealed[i] = cv.revealed;
            pendingWSFreezeCountBefore[i] = stakeMock.freezeCount(cv.owner);
            pendingWinnerSelectionLen++;
        }

        bool okCall = actors[idx].callWinnerSelection();
        if (!okCall) return;

        // "Only once per round" should hold: a second success in the same round is forbidden.
        if (lastWinnerSelectionRound == pendingWinnerSelectionRound) winnerSelectionSucceededTwiceSameRound = true;
        lastWinnerSelectionRound = pendingWinnerSelectionRound;

        // Arm postconditions: non-revealers must have been frozen.
        pendingWinnerSelection = true;
    }

    // -----------------------------
    // Properties
    // -----------------------------

    function echidna_reveal_entries_imply_matching_commit() external view returns (bool) {
        // For each reveal entry, there must exist a commit marked revealed with matching overlay/owner and revealIndex pointing here.
        //
        // `commit()` deletes `currentCommits` when `currentCommitRound` advances but does not clear
        // `currentReveals` until the first `reveal()` of the new round (`reveal()` deletes when
        // `currentRevealRound` catches up to `cr`). Until then, `currentCommitRound != currentRevealRound`
        // even in **reveal phase** (currentPhaseCommit false): old `currentReveals` entries coexist with
        // fresh unrevealed `currentCommits`. Skip linkage checks for that whole transitional window.
        if (redist.currentCommitRound() != redist.currentRevealRound()) {
            return true;
        }

        uint256 rLim = _boundedRevealsLen();
        uint256 cLim = _boundedCommitsLen();
        for (uint256 i = 0; i < rLim; i++) {
            (bool okR, bytes32 rOverlay, address rOwner) = _revealOverlayOwner(i);
            if (!okR) return false;

            bool found = false;
            for (uint256 j = 0; j < cLim; j++) {
                (bool okC, bytes32 cOverlay, address cOwner, bool cRevealed, uint256 cRevealIndex) = _commitRevealLink(
                    j
                );
                if (!okC) return false;
                if (cRevealed && cRevealIndex == i && cOverlay == rOverlay && cOwner == rOwner) {
                    found = true;
                    break;
                }
            }
            if (!found) return false;
        }
        return true;
    }

    function echidna_winnerSelection_only_once_per_round() external view returns (bool) {
        return !winnerSelectionSucceededTwiceSameRound;
    }

    function echidna_last_winnerSelection_freezes_nonrevealed() external view returns (bool) {
        if (!pendingWinnerSelection) return true;
        // If we moved to another claim round, the commit set and expectations are stale; ignore.
        if (redist.currentClaimRound() != pendingWinnerSelectionRound) return true;

        for (uint256 i = 0; i < pendingWinnerSelectionLen; i++) {
            if (pendingWSRevealed[i]) continue;
            address ow = pendingWSOwners[i];
            if (ow == address(0)) continue;
            if (stakeMock.freezeCount(ow) <= pendingWSFreezeCountBefore[i]) return false;
            // Freeze should move lastUpdated into the future in the mock.
            if (stakeMock.lastUpdatedBlockNumberOfAddress(ow) <= block.number) return false;
        }
        return true;
    }

    function echidna_commit_overlays_unique() external view returns (bool) {
        (uint256 n, bytes32[25] memory overlays, , , ) = _scanCommits();
        for (uint256 i = 0; i < n; i++) {
            bytes32 oi = overlays[i];
            for (uint256 j = i + 1; j < n; j++) {
                bytes32 oj = overlays[j];
                if (oi != bytes32(0) && oi == oj) return false;
            }
        }
        return true;
    }

    function echidna_revealed_commit_indices_valid() external view returns (bool) {
        (
            uint256 cN,
            ,
            uint256[25] memory revealIndex,
            bool[25] memory revealed,
            address[25] memory owner
        ) = _scanCommits();
        uint256 rN = _scanRevealsLen();
        for (uint256 i = 0; i < cN; i++) {
            if (!revealed[i]) continue;
            uint256 ri = revealIndex[i];
            if (ri >= rN) return false;
            (bool ok, bytes32 rOverlay, address rOwner) = _revealOverlayOwner(ri);
            if (!ok) return false;
            // Compare against commit i overlay/owner.
            (bool ok2, bytes32 cOverlay, address cOwner) = _commitOverlayOwner(i);
            if (!ok2) return false;
            if (rOverlay != cOverlay) return false;
            if (rOwner != cOwner) return false;
            if (cOwner != owner[i]) return false;
        }
        return true;
    }

    function echidna_tracked_commit_matches_storage() external view returns (bool) {
        uint64 liveCommitRound = redist.currentCommitRound();
        for (uint256 i = 0; i < ACTOR_COUNT; i++) {
            if (!trackedHasCommit[i]) continue;
            // `currentCommits` is deleted when a new commit round begins.
            // Only assert strong postconditions for commits in the currently tracked commit round.
            if (trackedRound[i] != liveCommitRound) continue;

            (bool ok, uint256 commitIdx) = _findCommit(trackedOverlay[i], trackedObfuscated[i]);
            if (!ok) return false;

            (, bytes32 ov, address ow, , uint8 h, uint256 stake, bytes32 obf /* revealIndex */, ) = _commitFull(
                commitIdx
            );

            if (ov != trackedOverlay[i]) return false;
            if (obf != trackedObfuscated[i]) return false;
            if (ow != address(actors[i])) return false;
            if (h != trackedHeight[i]) return false;
            if (stake != trackedStake[i]) return false;
        }
        return true;
    }

    function echidna_tracked_reveal_matches_storage() external view returns (bool) {
        uint64 liveCommitRound = redist.currentCommitRound();
        for (uint256 i = 0; i < ACTOR_COUNT; i++) {
            if (!trackedHasReveal[i]) continue;
            if (trackedRound[i] != liveCommitRound) continue;
            if (!_checkTrackedReveal(i)) return false;
        }
        return true;
    }

    // -----------------------------
    // View helpers (avoid needing array length getters)
    // -----------------------------

    function _scanCommits()
        internal
        view
        returns (
            uint256 n,
            bytes32[25] memory overlays,
            uint256[25] memory revealIndex,
            bool[25] memory revealed,
            address[25] memory owner
        )
    {
        uint256 lim = _boundedCommitsLen();
        for (uint256 i = 0; i < lim; i++) {
            (bool ok, bytes32 ov, address ow, bool rev, uint256 ri) = _commitFields(i);
            if (!ok) break;
            overlays[i] = ov;
            owner[i] = ow;
            revealed[i] = rev;
            revealIndex[i] = ri;
            n++;
        }
    }

    function _scanRevealsLen() internal view returns (uint256 n) {
        n = _boundedRevealsLen();
    }

    function _commitOverlayOwner(uint256 i) internal view returns (bool ok, bytes32 ov, address ow) {
        (ok, ov, ow, , ) = _commitFields(i);
    }

    function _commitRevealLink(
        uint256 i
    ) internal view returns (bool ok, bytes32 overlay, address owner, bool revealed, uint256 revealIndex) {
        bytes memory data;
        (ok, data) = address(redist).staticcall(abi.encodeWithSignature("currentCommits(uint256)", i));
        if (!ok) return (false, bytes32(0), address(0), false, 0);
        (overlay, owner, revealed, , , , revealIndex) = abi.decode(
            data,
            (bytes32, address, bool, uint8, uint256, bytes32, uint256)
        );
    }

    function _commitFields(uint256 i) internal view returns (bool ok, bytes32 ov, address ow, bool rev, uint256 ri) {
        bytes memory data;
        (ok, data) = address(redist).staticcall(abi.encodeWithSignature("currentCommits(uint256)", i));
        if (!ok) return (false, bytes32(0), address(0), false, 0);
        // Commit struct getter returns:
        // (bytes32 overlay, address owner, bool revealed, uint8 height, uint256 stake, bytes32 obfuscatedHash, uint256 revealIndex)
        (ov, ow, rev, , , , ri) = abi.decode(data, (bytes32, address, bool, uint8, uint256, bytes32, uint256));
    }

    function _revealOverlayOwner(uint256 i) internal view returns (bool ok, bytes32 ov, address ow) {
        bytes memory data;
        (ok, data) = address(redist).staticcall(abi.encodeWithSignature("currentReveals(uint256)", i));
        if (!ok) return (false, bytes32(0), address(0));
        // Reveal struct getter returns:
        // (bytes32 overlay, address owner, uint8 depth, uint256 stake, uint256 stakeDensity, bytes32 hash)
        (ov, ow, , , , ) = abi.decode(data, (bytes32, address, uint8, uint256, uint256, bytes32));
    }

    function _commitFull(
        uint256 i
    )
        internal
        view
        returns (
            bool ok,
            bytes32 overlay,
            address owner,
            bool revealed,
            uint8 height,
            uint256 stake,
            bytes32 obfuscatedHash,
            uint256 revealIndex
        )
    {
        bytes memory data;
        (ok, data) = address(redist).staticcall(abi.encodeWithSignature("currentCommits(uint256)", i));
        if (!ok) return (false, bytes32(0), address(0), false, 0, 0, bytes32(0), 0);
        (overlay, owner, revealed, height, stake, obfuscatedHash, revealIndex) = abi.decode(
            data,
            (bytes32, address, bool, uint8, uint256, bytes32, uint256)
        );
    }

    function _checkTrackedReveal(uint256 actorIdx) internal view returns (bool) {
        (bool ok, uint256 commitIdx) = _findCommit(trackedOverlay[actorIdx], trackedObfuscated[actorIdx]);
        if (!ok) return false;

        bytes memory cdata;
        (ok, cdata) = address(redist).staticcall(abi.encodeWithSignature("currentCommits(uint256)", commitIdx));
        if (!ok) return false;
        CommitView memory c = abi.decode(cdata, (CommitView));

        if (c.owner != address(actors[actorIdx])) return false;
        if (c.overlay != trackedOverlay[actorIdx]) return false;
        if (c.obfuscatedHash != trackedObfuscated[actorIdx]) return false;
        if (c.height != trackedHeight[actorIdx]) return false;
        if (c.stake != trackedStake[actorIdx]) return false;
        if (!c.revealed) return false;

        bytes memory rdata;
        (ok, rdata) = address(redist).staticcall(abi.encodeWithSignature("currentReveals(uint256)", c.revealIndex));
        if (!ok) return false;
        RevealView memory r = abi.decode(rdata, (RevealView));

        if (r.overlay != trackedOverlay[actorIdx]) return false;
        if (r.owner != address(actors[actorIdx])) return false;
        if (r.depth != trackedDepth[actorIdx]) return false;
        if (r.hash != trackedReserveHash[actorIdx]) return false;
        if (r.stake != c.stake) return false;

        uint8 dr = trackedDepth[actorIdx] - c.height;
        uint256 expectedDensity = c.stake * (uint256(1) << dr);
        if (r.stakeDensity != expectedDensity) return false;
        return true;
    }

    function _findCommit(bytes32 overlay, bytes32 obfuscated) internal view returns (bool ok, uint256 idx) {
        uint256 lim = _boundedCommitsLen();
        for (uint256 i = 0; i < lim; i++) {
            (bool okI, bytes32 ov, , , , , bytes32 obf, ) = _commitFull(i);
            if (!okI) break;
            if (ov == overlay && obf == obfuscated) return (true, i);
        }
        return (false, 0);
    }

    function _commitOverlayExists(bytes32 overlay) internal view returns (bool) {
        uint256 lim = _boundedCommitsLen();
        for (uint256 i = 0; i < lim; i++) {
            (bool ok, bytes32 ov, , , ) = _commitFields(i);
            if (!ok) break;
            if (ov == overlay) return true;
        }
        return false;
    }

    function _backdateLastUpdated() internal view returns (uint256) {
        uint256 twoRounds = 2 * Constants.ROUND_LENGTH;
        if (block.number > twoRounds + 1) return block.number - twoRounds - 1;
        return 1;
    }

    function _boundStake(uint256 s) internal pure returns (uint256) {
        // Keep stake densities well within uint256 range even if depthResponsibility grows a bit.
        uint256 max = 1e24;
        if (s == 0) return 1;
        if (s > max) return (s % max) + 1;
        return s;
    }
}
