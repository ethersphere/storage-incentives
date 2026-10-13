// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import "./VersionedRegistryRouter.sol";

/**
 * @notice OZ transparent proxy that reverts on fallback/receive unless {VersionedRegistryRouter.verifyProxy}
 *         passes for this proxy's registered `proxyId`.
 * @dev Non-admin calls hit `_beforeFallback` → registry check → delegate to implementation. Admin upgrade
 *      paths use `ifAdmin` and never run this hook. Deploy with the same `registryProxyId` later used in
 *      `VersionedRegistryRouter.registerProxy`.
 */
contract RegistryGuardedTransparentUpgradeableProxy is TransparentUpgradeableProxy {
    VersionedRegistryRouter private immutable _registry;
    bytes32 private immutable _registryProxyId;

    error ZeroRegistry();
    error PinMismatch(address expected, address actual);
    error AdminCannotPin();

    /// @dev Emitted from {pinnedExecute} when the pin matches and the call is delegated.
    event PinnedExecuted(address indexed caller, address indexed expectedImpl);

    constructor(
        address _logic,
        address admin_,
        bytes memory _data,
        VersionedRegistryRouter registry_,
        bytes32 registryProxyId_
    ) payable TransparentUpgradeableProxy(_logic, admin_, _data) {
        if (address(registry_) == address(0)) revert ZeroRegistry();
        _registry = registry_;
        _registryProxyId = registryProxyId_;
    }

    function _beforeFallback() internal virtual override {
        super._beforeFallback();
        _registry.verifyProxy(_registryProxyId);
    }

    /**
     * @notice Atomically verify the registry, require the live implementation to equal
     *         `expectedImpl`, then delegatecall it with `data`.
     * @dev Caller (e.g. Bee) computes `expectedImpl` from its locally-pinned `versionId` via
     *      `VersionedRegistryRouter.getRelease(versionId).implementation`. Because release rows are
     *      immutable, an attacker who later upgrades the proxy to a different (even registered)
     *      implementation will cause this call to revert with {PinMismatch} in the same transaction.
     *      `delegatecall` preserves `msg.sender` for the implementation.
     *
     *      Admin is rejected to keep the transparent-proxy property: admin keys must use the
     *      upgrade paths, not delegate into the implementation through this contract.
     *
     *      Selector note: this function occupies `bytes4(keccak256("pinnedExecute(address,bytes)"))`
     *      on the proxy; implementations must not expose a function with the same selector.
     */
    function pinnedExecute(address expectedImpl, bytes calldata data) external payable {
        if (msg.sender == _getAdmin()) revert AdminCannotPin();

        _registry.verifyProxy(_registryProxyId);

        address impl = _implementation();
        if (impl != expectedImpl) revert PinMismatch(expectedImpl, impl);

        emit PinnedExecuted(msg.sender, expectedImpl);

        assembly {
            let ptr := mload(0x40)
            calldatacopy(ptr, data.offset, data.length)
            let ok := delegatecall(gas(), impl, ptr, data.length, 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch ok
            case 0 {
                revert(0, returndatasize())
            }
            default {
                return(0, returndatasize())
            }
        }
    }
}
