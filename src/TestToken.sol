// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/presets/ERC20PresetMinterPauser.sol";

contract TestToken is ERC20PresetMinterPauser {
    uint256 private _initialSupply;

    constructor(
        string memory name,
        string memory symbol,
        uint256 initialSupply,
        address multisig
    ) ERC20PresetMinterPauser(name, symbol) {
        _initialSupply = initialSupply;
        _setupRole(DEFAULT_ADMIN_ROLE, multisig);
        _mint(multisig, initialSupply);
    }

    // We use 16 decimals for BZZ/sBZZ token so we need to override it here
    function decimals() public view virtual override returns (uint8) {
        return 16;
    }
}
