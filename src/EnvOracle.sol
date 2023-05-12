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

  // hex value of character dot
  bytes1 constant DOT = 0x2E;

  /**
   * @dev Emitted when the required minimum Bee version changes
   */
  event MinimumBeeVersionChanged(string newVersion);

  constructor(string memory _minimumBeeVersion) {
    _assertMinimumBeeVersion(_minimumBeeVersion);
    _setupRole(DEFAULT_ADMIN_ROLE, msg.sender);

    minimumBeeVersion = _minimumBeeVersion;
  }

  function setMinimumBeeVersion(string memory _minimumBeeVersion) public {
    require(hasRole(DEFAULT_ADMIN_ROLE, msg.sender), "only administrator can use copy method");
    _assertMinimumBeeVersion(_minimumBeeVersion);

    minimumBeeVersion = _minimumBeeVersion;

    emit MinimumBeeVersionChanged(_minimumBeeVersion);
  }

  function _assertMinimumBeeVersion(string memory _minimumBeeVersion) internal pure {
    uint8 dotCount = 0;
    bytes memory versionBytes = bytes(_minimumBeeVersion);
    uint256 bytelength = versionBytes.length;
    bool zeroStarted;
    bool started;
    bool numberStarted;

    for (uint256 i = 0; i < bytelength; i++) {
      bytes1 b = versionBytes[i];
      if (b == DOT) {
        require(numberStarted, "Minimum Bee version should be in semver form");
        dotCount += 1;
        zeroStarted = false;
        numberStarted = false;
        started = false;
      } else {
        require(b >= 0x30 && b <= 0x39 && !zeroStarted, "Minimum Bee version should be in semver form");
        numberStarted = true;
        if (b == 0x30 && !started) {
          zeroStarted = true;
        }
      }
      started = true;
    }

    require(dotCount == 2 && versionBytes[bytelength - 1] != DOT, "Minimum Bee version should be in semver form");
  }
}
