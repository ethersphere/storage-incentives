// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.19;

import "../Redistribution.sol";
import "../interface/IPostageStamp.sol";

contract EchidnaStakeRegistryMock is IStakeRegistry {
    struct Node {
        bytes32 overlay;
        uint8 height;
        uint256 effectiveStake;
        uint256 lastUpdated;
        bool exists;
    }

    mapping(address => Node) internal nodes;

    function setNode(address owner, bytes32 overlay, uint8 height, uint256 effectiveStake, uint256 lastUpdated) external {
        nodes[owner] = Node({
            overlay: overlay,
            height: height,
            effectiveStake: effectiveStake,
            lastUpdated: lastUpdated,
            exists: true
        });
    }

    function freezeDeposit(address _owner, uint256 _time) external {
        if (!nodes[_owner].exists) return;
        nodes[_owner].lastUpdated = block.number + _time;
    }

    function lastUpdatedBlockNumberOfAddress(address _owner) external view returns (uint256) {
        return nodes[_owner].lastUpdated;
    }

    function overlayOfAddress(address _owner) external view returns (bytes32) {
        return nodes[_owner].overlay;
    }

    function heightOfAddress(address _owner) external view returns (uint8) {
        return nodes[_owner].height;
    }

    function nodeEffectiveStake(address _owner) external view returns (uint256) {
        return nodes[_owner].effectiveStake;
    }
}

contract EchidnaPriceOracleMock is IPriceOracle {
    uint256 public calls;
    uint16 public lastRedundancy;

    function adjustPrice(uint16 redundancy) external returns (bool) {
        calls += 1;
        lastRedundancy = redundancy;
        return true;
    }
}

contract EchidnaPostageStampMock is IPostageStamp {
    uint256 public withdrawCalls;
    address public lastBeneficiary;
    uint256 public validChunkCountValue;

    // Minimal batch data for claim's stampFunction() access pattern.
    mapping(bytes32 => Batch) internal _batches;

    struct Batch {
        address owner;
        uint8 depth;
        uint8 bucketDepth;
        bool immutableFlag;
        uint256 normalisedBalance;
        uint256 lastUpdatedBlockNumber;
    }

    function setValidChunkCount(uint256 v) external {
        validChunkCountValue = v;
    }

    function seedBatch(bytes32 id, address owner, uint8 depth, uint8 bucketDepth) external {
        _batches[id] = Batch({
            owner: owner,
            depth: depth,
            bucketDepth: bucketDepth,
            immutableFlag: false,
            normalisedBalance: 1,
            lastUpdatedBlockNumber: block.number
        });
    }

    function withdraw(address beneficiary) external {
        withdrawCalls += 1;
        lastBeneficiary = beneficiary;
    }

    function setPrice(uint256) external {}

    function validChunkCount() external view returns (uint256) {
        return validChunkCountValue;
    }

    function batchOwner(bytes32 _batchId) external view returns (address) {
        return _batches[_batchId].owner;
    }

    function batchDepth(bytes32 _batchId) external view returns (uint8) {
        return _batches[_batchId].depth;
    }

    function batchBucketDepth(bytes32 _batchId) external view returns (uint8) {
        return _batches[_batchId].bucketDepth;
    }

    function remainingBalance(bytes32) external pure returns (uint256) {
        return 1;
    }

    function minimumInitialBalancePerChunk() external pure returns (uint256) {
        return 1;
    }

    function batches(
        bytes32 id
    )
        external
        view
        returns (address owner, uint8 depth, uint8 bucketDepth, bool immutableFlag, uint256 normalisedBalance, uint256 lastUpdatedBlockNumber)
    {
        Batch memory b = _batches[id];
        return (b.owner, b.depth, b.bucketDepth, b.immutableFlag, b.normalisedBalance, b.lastUpdatedBlockNumber);
    }
}

contract EchidnaRedistributionActor {
    Redistribution internal immutable redist;

    constructor(Redistribution r) {
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

    function tryPause() external returns (bool ok) {
        (ok, ) = address(redist).call(abi.encodeWithSelector(redist.pause.selector));
    }

    function tryUnpause() external returns (bool ok) {
        (ok, ) = address(redist).call(abi.encodeWithSelector(redist.unPause.selector));
    }

    function trySetSampleMaxValue(uint256 v) external returns (bool ok) {
        (ok, ) = address(redist).call(abi.encodeWithSelector(redist.setSampleMaxValue.selector, v));
    }

    function trySetFreezingParams(uint8 a, uint8 b, uint8 c) external returns (bool ok) {
        (ok, ) = address(redist).call(abi.encodeWithSelector(redist.setFreezingParams.selector, a, b, c));
    }
}

/// @notice Base Echidna harness for Redistribution.
/// @dev Focuses on wiring dependencies, access control, and basic internal consistency.
contract EchidnaRedistributionHarness {
    EchidnaStakeRegistryMock internal immutable stakeMock;
    EchidnaPostageStampMock internal immutable stampMock;
    EchidnaPriceOracleMock internal immutable oracleMock;
    Redistribution internal immutable redist;

    uint256 internal constant ACTOR_COUNT = 3;
    EchidnaRedistributionActor[3] internal actors;

    // Forbidden-call flags.
    bool internal unauthorizedAdminCallSucceeded;

    constructor() {
        stakeMock = new EchidnaStakeRegistryMock();
        stampMock = new EchidnaPostageStampMock();
        oracleMock = new EchidnaPriceOracleMock();

        redist = new Redistribution(address(stakeMock), address(stampMock), address(oracleMock));

        for (uint256 i = 0; i < ACTOR_COUNT; i++) {
            actors[i] = new EchidnaRedistributionActor(redist);
            // Seed a stake that will eventually satisfy commit constraints once block.number is large enough.
            stakeMock.setNode(address(actors[i]), bytes32(uint256(i + 1)), 0, 1e18, 1);
        }
    }

    // -----------------------------
    // Actions
    // -----------------------------

    function act_setActorStake(uint8 actorId, bytes32 overlay, uint8 height, uint256 effectiveStake, uint256 lastUpdated)
        external
    {
        EchidnaRedistributionActor a = actors[uint256(actorId) % ACTOR_COUNT];
        // Bound height so 2**depthResponsibility doesn't explode too hard during reveal.
        uint8 h = uint8(height % 16);
        // Avoid lastUpdated=0 unless we want NotStaked; keep at least 1.
        uint256 u = lastUpdated == 0 ? 1 : lastUpdated;
        stakeMock.setNode(address(a), overlay, h, effectiveStake, u);
    }

    function act_commit(uint8 actorId, bytes32 obfuscatedHash, int8 roundDelta) external {
        EchidnaRedistributionActor a = actors[uint256(actorId) % ACTOR_COUNT];
        uint64 cr = redist.currentRound();
        uint64 rn = cr;
        if (roundDelta < 0 && uint64(uint8(-roundDelta)) < cr) rn = cr - uint64(uint8(-roundDelta));
        if (roundDelta > 0) rn = cr + uint64(uint8(roundDelta));
        a.callCommit(obfuscatedHash, rn);
    }

    function act_reveal(uint8 actorId, uint8 depth, bytes32 hash, bytes32 nonce) external {
        EchidnaRedistributionActor a = actors[uint256(actorId) % ACTOR_COUNT];
        a.callReveal(uint8(depth % 32), hash, nonce);
    }

    function act_claim(uint8 actorId) external {
        EchidnaRedistributionActor a = actors[uint256(actorId) % ACTOR_COUNT];
        a.callClaim();
    }

    function act_admin_pause() external {
        redist.pause();
    }

    function act_admin_unpause() external {
        redist.unPause();
    }

    function act_admin_setSampleMaxValue(uint256 v) external {
        redist.setSampleMaxValue(v);
    }

    function act_admin_setFreezingParams(uint8 a, uint8 b, uint8 c) external {
        redist.setFreezingParams(a, b, c);
    }

    function act_rando_tryPause(uint8 actorId) external {
        bool ok = actors[uint256(actorId) % ACTOR_COUNT].tryPause();
        if (ok) unauthorizedAdminCallSucceeded = true;
    }

    function act_rando_tryUnpause(uint8 actorId) external {
        bool ok = actors[uint256(actorId) % ACTOR_COUNT].tryUnpause();
        if (ok) unauthorizedAdminCallSucceeded = true;
    }

    function act_rando_trySetSampleMaxValue(uint8 actorId, uint256 v) external {
        bool ok = actors[uint256(actorId) % ACTOR_COUNT].trySetSampleMaxValue(v);
        if (ok) unauthorizedAdminCallSucceeded = true;
    }

    function act_rando_trySetFreezingParams(uint8 actorId, uint8 a, uint8 b, uint8 c) external {
        bool ok = actors[uint256(actorId) % ACTOR_COUNT].trySetFreezingParams(a, b, c);
        if (ok) unauthorizedAdminCallSucceeded = true;
    }

    // -----------------------------
    // Properties
    // -----------------------------

    function echidna_never_performed_forbidden_calls() external view returns (bool) {
        return !unauthorizedAdminCallSucceeded;
    }

    function echidna_round_counters_not_in_future() external view returns (bool) {
        uint64 cr = redist.currentRound();
        return redist.currentCommitRound() <= cr && redist.currentRevealRound() <= cr;
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
        (uint256 cN, , uint256[25] memory revealIndex, bool[25] memory revealed, address[25] memory owner) = _scanCommits();
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

    // -----------------------------
    // View helpers (avoid needing array length getters)
    // -----------------------------

    function _scanCommits()
        internal
        view
        returns (uint256 n, bytes32[25] memory overlays, uint256[25] memory revealIndex, bool[25] memory revealed, address[25] memory owner)
    {
        for (uint256 i = 0; i < 25; i++) {
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
        for (uint256 i = 0; i < 25; i++) {
            (bool ok, , ) = _revealOverlayOwner(i);
            if (!ok) break;
            n++;
        }
    }

    function _commitOverlayOwner(uint256 i) internal view returns (bool ok, bytes32 ov, address ow) {
        (ok, ov, ow, , ) = _commitFields(i);
    }

    function _commitFields(
        uint256 i
    ) internal view returns (bool ok, bytes32 ov, address ow, bool rev, uint256 ri) {
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
}

