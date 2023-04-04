// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.1;
import "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title EnvOracle contract.
 * @author The Swarm Authors.
 * @dev Holds environment related data for the stack
 */
contract EnvOracle is AccessControl {
  // states the minimum Bee version from which the stack can be used
  string public minimumBeeVersion;

  constructor(string memory _minimumBeeVersion) {
    _assertMinimumBeeVersion(_minimumBeeVersion);
    _setupRole(DEFAULT_ADMIN_ROLE, msg.sender);

    minimumBeeVersion = _minimumBeeVersion;
  }

  function setMinimumBeeVersion(string memory _minimumBeeVersion) public {
    require(hasRole(DEFAULT_ADMIN_ROLE, msg.sender), "only administrator can use copy method");
    _assertMinimumBeeVersion(_minimumBeeVersion);

    minimumBeeVersion = _minimumBeeVersion;
  }

  function _assertMinimumBeeVersion(string memory _minimumBeeVersion) internal pure {
    bytes1 dot = 0x2E;
    uint8 dotCount = 0;
    bytes memory versionBytes = bytes(_minimumBeeVersion);
    uint256 bytelength = versionBytes.length;
    bool zeroStarted;

    for (uint256 i = 0; i < bytelength; i++) {
      bytes1 b = versionBytes[i];
      if (b == dot) {
        dotCount += 1;
        zeroStarted = false;
      } else {
        require(b >= 0x30 && b <= 0x39 && !zeroStarted, "Minimum Bee version should be in semver form");
        if (b == 0x30) {
          zeroStarted = true;
        }
      }
    }

    require(dotCount == 2, "Minimum Bee version should be in semver form");
  }
}
