// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.19;

import "../Redistribution.sol";

/// @notice Shared stake registry mock for redistribution harnesses.
contract EchidnaStakeRegistryMock is IStakeRegistry {
    struct Node {
        bytes32 overlay;
        uint8 height;
        uint256 effectiveStake;
        uint256 lastUpdated;
        bool exists;
    }

    mapping(address => Node) internal nodes;
    mapping(address => uint256) public freezeCount;
    mapping(address => uint256) public lastFreezeTime;

    function setNode(
        address owner,
        bytes32 overlay,
        uint8 height,
        uint256 effectiveStake,
        uint256 lastUpdated
    ) external {
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
        freezeCount[_owner] += 1;
        lastFreezeTime[_owner] = _time;
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

/// @notice Shared price oracle mock for redistribution harnesses.
contract EchidnaPriceOracleMock is IPriceOracle {
    uint256 public calls;
    uint16 public lastRedundancy;

    function adjustPrice(uint16 redundancy) external returns (bool) {
        calls += 1;
        lastRedundancy = redundancy;
        return true;
    }
}
