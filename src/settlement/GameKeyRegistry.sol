// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.19;

import {MiMC} from "./MiMC.sol";

interface IGameStakes {
    function stakes(
        address owner
    )
        external
        view
        returns (
            bytes32 overlay,
            uint256 committedStake,
            uint256 potentialStake,
            uint256 lastUpdatedBlockNumber,
            uint8 height
        );
}

/**
 * @title Game keys and stake commitments for the SNARK settlement
 * @notice A node signs its off-chain commits with a game key: an EdDSA key on the twisted Edwards curve
 * of BN254 (the curve of gnark-crypto), which the settlement circuit checks with few constraints.
 *
 * The circuit reads a node's stake record and game key as one MiMC hash, the stake commitment.
 * `commitmentOf` computes it and keeps it. It computes it again only after the record
 * changed, so a settlement usually pays one storage read for each node. See docs/SNARK-SETTLEMENT.md.
 */
contract GameKeyRegistry {
    // The curve: -x^2 + y^2 = 1 + D x^2 y^2 over the BN254 scalar field.
    uint256 internal constant D = 12181644023421730124874158521699555681764249180949974110617291017600649128846;

    struct Key {
        uint256 x;
        uint256 y;
    }

    // The commitment is a MiMC hash chain of 7 elements. The first 6 change seldom (owner, overlay, game
    // key, stake amounts): their hash is `mid`. The last element (height and lastUpdated) changes at each
    // freeze, and then only one more compression is necessary.
    struct Cached {
        bytes32 midTag; // keccak256 of the data behind `mid`
        uint256 mid;
        bytes32 tag; // keccak256 of the data behind `commitment`
        uint256 commitment;
    }

    IGameStakes public immutable Stakes;
    mapping(address => Key) public keys;
    mapping(address => Cached) internal cache;

    event GameKeySet(address indexed owner, uint256 x, uint256 y);

    error NotOnCurve();
    error KeyAlreadySet();
    error OutOfRange();

    constructor(address staking) {
        Stakes = IGameStakes(staking);
    }

    /**
     * @notice Register the game key of the sender. The key cannot change afterwards: a node that could
     * change its key in a round could make its own commit invalid after it saw the seed.
     */
    function setKey(uint256 x, uint256 y) external {
        uint256 p = MiMC.P;
        if (x >= p || y >= p || (x == 0 && y == 0)) revert NotOnCurve();
        uint256 x2 = mulmod(x, x, p);
        uint256 y2 = mulmod(y, y, p);
        if (addmod(y2, p - x2, p) != addmod(1, mulmod(D, mulmod(x2, y2, p), p), p)) revert NotOnCurve();
        Key storage k = keys[msg.sender];
        if (k.x != 0 || k.y != 0) revert KeyAlreadySet();
        keys[msg.sender] = Key(x, y);
        emit GameKeySet(msg.sender, x, y);
    }

    /// @notice The stake commitment of `owner` as of now. Stores it when the record changed.
    /// @notice The stake commitment of `owner` as of now, and the lastUpdatedBlockNumber of its stake
    /// record. Stores the commitment when the record changed.
    function commitmentOf(address owner) external returns (uint256 commitment, uint256 lastUpdated) {
        (bytes32 midTag, bytes32 tag, uint256[] memory f, uint256 last, uint256 raw) = _fields(owner);
        lastUpdated = raw;
        Cached storage c = cache[owner];
        if (c.tag == tag) return (c.commitment, raw);
        uint256 mid = c.mid;
        if (c.midTag != midTag) {
            mid = MiMC.hash(f);
            c.midTag = midTag;
            c.mid = mid;
        }
        commitment = MiMC.compress(mid, last);
        c.tag = tag;
        c.commitment = commitment;
    }

    /// @notice The same value, without the storage write.
    function peekCommitment(address owner) external view returns (uint256) {
        (bytes32 midTag, bytes32 tag, uint256[] memory f, uint256 last, ) = _fields(owner);
        Cached storage c = cache[owner];
        if (c.tag == tag) return c.commitment;
        return MiMC.compress(c.midTag == midTag ? c.mid : MiMC.hash(f), last);
    }

    /// @dev MiMC(owner, overlay high, overlay low, key.x, key.y, committed << 96 | potential,
    /// height << 64 | lastUpdated): the first 6 elements in `f`, the last in `last`. `raw` is the
    /// lastUpdatedBlockNumber of the record. In the commitment it is capped at 2^64 - 1: a freeze at a
    /// very large depth can move it beyond that, and the node is then not eligible either way.
    function _fields(
        address owner
    ) internal view returns (bytes32 midTag, bytes32 tag, uint256[] memory f, uint256 last, uint256 raw) {
        (bytes32 overlay, uint256 committed, uint256 potential, uint256 lastUpdated, uint8 height) = Stakes.stakes(
            owner
        );
        if (committed >> 96 != 0 || potential >> 96 != 0) revert OutOfRange();
        raw = lastUpdated;
        if (lastUpdated > type(uint64).max) lastUpdated = type(uint64).max;
        Key memory k = keys[owner];
        midTag = keccak256(abi.encode(overlay, committed, potential, k.x, k.y));
        last = (uint256(height) << 64) | lastUpdated;
        tag = keccak256(abi.encode(midTag, last));
        f = new uint256[](6);
        f[0] = uint256(uint160(owner));
        f[1] = uint256(overlay) >> 128;
        f[2] = uint256(uint128(uint256(overlay)));
        f[3] = k.x;
        f[4] = k.y;
        f[5] = (committed << 96) | potential;
    }

    /**
     * @notice The message a node signs with its game key (EdDSA) for an off-chain commit. Binds the commit
     * to this chain, the Settlement contract and the round.
     */
    function commitMessage(address settlement, uint64 round, bytes32 obfuscatedHash) external view returns (uint256) {
        uint256[] memory x = new uint256[](5);
        x[0] = uint256(uint88(bytes11("SwarmCommit")));
        x[1] = block.chainid;
        x[2] = uint256(uint160(settlement));
        x[3] = round;
        x[4] = uint256(obfuscatedHash);
        return MiMC.hash(x);
    }

    /// @notice The obfuscated commit hash: MiMC(overlay, depth, hash, nonce), 256-bit values as two halves.
    function wrapCommit(bytes32 overlay, uint8 depth, bytes32 hash, bytes32 nonce) external pure returns (bytes32) {
        uint256[] memory x = new uint256[](7);
        x[0] = uint256(overlay) >> 128;
        x[1] = uint256(uint128(uint256(overlay)));
        x[2] = depth;
        x[3] = uint256(hash) >> 128;
        x[4] = uint256(uint128(uint256(hash)));
        x[5] = uint256(nonce) >> 128;
        x[6] = uint256(uint128(uint256(nonce)));
        return bytes32(MiMC.hash(x));
    }

    /// @notice MiMC compression, for contracts that do not hold the constants themselves.
    function compress(uint256 left, uint256 right) external pure returns (uint256) {
        return MiMC.compress(left, right);
    }

    /// @notice MiMC hash of a list of field elements.
    function mimc(uint256[] calldata xs) external pure returns (uint256) {
        return MiMC.hash(xs);
    }

}
