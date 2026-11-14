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
 * `commitmentOf` computes it (about 60k gas) and keeps it. It computes it again only after the record
 * changed, so a settlement usually pays one storage read for each node. See docs/SNARK-SETTLEMENT.md.
 */
contract GameKeyRegistry {
    // The curve: -x^2 + y^2 = 1 + D x^2 y^2 over the BN254 scalar field.
    uint256 internal constant D = 12181644023421730124874158521699555681764249180949974110617291017600649128846;

    struct Key {
        uint256 x;
        uint256 y;
    }

    struct Cached {
        // keccak256 of the record and the key the commitment was computed from.
        bytes32 tag;
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
    function commitmentOf(address owner) external returns (uint256 commitment) {
        (bytes32 tag, uint256[] memory fields) = _fields(owner);
        Cached storage c = cache[owner];
        if (c.tag == tag) return c.commitment;
        commitment = MiMC.hash(fields);
        c.tag = tag;
        c.commitment = commitment;
    }

    /// @notice The same value, without the storage write.
    function peekCommitment(address owner) external view returns (uint256) {
        (bytes32 tag, uint256[] memory fields) = _fields(owner);
        Cached storage c = cache[owner];
        return c.tag == tag ? c.commitment : MiMC.hash(fields);
    }

    /// @notice MiMC compression, for contracts that do not hold the constants themselves.
    function compress(uint256 left, uint256 right) external pure returns (uint256) {
        return MiMC.compress(left, right);
    }

    /// @notice MiMC hash of a list of field elements.
    function mimc(uint256[] calldata xs) external pure returns (uint256) {
        return MiMC.hash(xs);
    }

    function _fields(address owner) internal view returns (bytes32 tag, uint256[] memory f) {
        (bytes32 overlay, uint256 committed, uint256 potential, uint256 lastUpdated, uint8 height) = Stakes.stakes(
            owner
        );
        if (committed >> 96 != 0 || potential >> 96 != 0 || lastUpdated >> 64 != 0) revert OutOfRange();
        Key memory k = keys[owner];
        tag = keccak256(abi.encode(overlay, committed, potential, lastUpdated, height, k.x, k.y));
        f = new uint256[](6);
        f[0] = (uint256(uint160(owner)) << 72) | (uint256(height) << 64) | lastUpdated;
        f[1] = uint256(overlay) >> 128;
        f[2] = uint256(uint128(uint256(overlay)));
        f[3] = (committed << 96) | potential;
        f[4] = k.x;
        f[5] = k.y;
    }
}
