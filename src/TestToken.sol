// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.1;

import "@openzeppelin/contracts/token/ERC20/presets/ERC20PresetMinterPauser.sol";

contract TestToken is ERC20PresetMinterPauser {
    uint256 private _initialSupply;

    constructor(string memory name, string memory symbol, uint256 initialSupply) ERC20PresetMinterPauser(name, symbol) {
        _initialSupply = initialSupply;
        _mint(msg.sender, initialSupply);
    }
}
