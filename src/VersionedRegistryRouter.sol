// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";
import "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

contract VersionedRegistryRouter is AccessControl {
    struct ReleaseInfo {
        address implementation;
        bool exists;
        bool deprecated;
        bytes32 codehash;
        string semver;
    }

    struct ProxyEntry {
        TransparentUpgradeableProxy proxy;
        bool exists;
        bool deprecated;
    }

    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");
    bytes32 public constant DEPRECATOR_ROLE = keccak256("DEPRECATOR_ROLE");
    bytes32 public constant ROUTER_ADMIN_ROLE = keccak256("ROUTER_ADMIN_ROLE");

    ProxyAdmin public immutable proxyAdmin;

    mapping(bytes32 => ReleaseInfo) public releaseByVersion;
    mapping(address => bytes32) public versionByImplementation;

    mapping(bytes32 => ProxyEntry) public proxies;
    bytes32[] public proxyIds;

    mapping(bytes4 => bool) public routedSelector;

    event ReleaseRegistered(bytes32 indexed versionId, string semver, address indexed implementation, bytes32 codehash);

    event ReleaseDeprecated(bytes32 indexed versionId, address indexed implementation);

    event ProxyRegistered(bytes32 indexed proxyId, address indexed proxy);

    event ProxyDeprecated(bytes32 indexed proxyId, address indexed proxy);

    event Forwarded(address indexed caller, bytes4 indexed selector, bytes32 indexed proxyId, address implementation);

    event SelectorRouted(bytes4 indexed selector, bool enabled);

    error VersionAlreadyRegistered(bytes32 versionId);
    error ImplementationAlreadyRegistered(address implementation);
    error ZeroAddress();
    error ZeroCodehash();
    error VersionNotFound(bytes32 versionId);
    error AlreadyDeprecated(bytes32 versionId);
    error ImplementationNotRegistered(address implementation);
    error ImplementationDeprecated(bytes32 versionId);
    error CodehashMismatch(bytes32 expected, bytes32 actual);
    error SelectorNotRouted(bytes4 selector);
    error ForwardFailed();
    error ProxyAlreadyRegistered(bytes32 proxyId);
    error ProxyNotFound(bytes32 proxyId);
    error ProxyDeprecatedError(bytes32 proxyId);
    error ProxyAdminMismatch(address expected, address actual);
    error CalldataTooShort();

    constructor(address _proxyAdmin) {
        if (_proxyAdmin == address(0)) revert ZeroAddress();
        proxyAdmin = ProxyAdmin(_proxyAdmin);
        _setupRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _setupRole(REGISTRAR_ROLE, msg.sender);
        _setupRole(DEPRECATOR_ROLE, msg.sender);
        _setupRole(ROUTER_ADMIN_ROLE, msg.sender);
    }

    // ----------------------------- Proxy management ------------------------------

    function registerProxy(bytes32 proxyId, address proxy) external onlyRole(ROUTER_ADMIN_ROLE) {
        if (proxy == address(0)) revert ZeroAddress();
        if (proxies[proxyId].exists) revert ProxyAlreadyRegistered(proxyId);

        // Sanity check: this router's ProxyAdmin must actually own the proxy,
        // otherwise verifyProxy() would revert later for confusing reasons.
        address actualAdmin = proxyAdmin.getProxyAdmin(TransparentUpgradeableProxy(payable(proxy)));
        if (actualAdmin != address(proxyAdmin)) revert ProxyAdminMismatch(address(proxyAdmin), actualAdmin);

        proxies[proxyId] = ProxyEntry({
            proxy: TransparentUpgradeableProxy(payable(proxy)),
            exists: true,
            deprecated: false
        });
        proxyIds.push(proxyId);

        emit ProxyRegistered(proxyId, proxy);
    }

    function deprecateProxy(bytes32 proxyId) external onlyRole(DEPRECATOR_ROLE) {
        ProxyEntry storage entry = proxies[proxyId];
        if (!entry.exists) revert ProxyNotFound(proxyId);
        if (entry.deprecated) revert ProxyDeprecatedError(proxyId);

        entry.deprecated = true;

        emit ProxyDeprecated(proxyId, address(entry.proxy));
    }

    function getProxyAddress(bytes32 proxyId) external view returns (address) {
        if (!proxies[proxyId].exists) revert ProxyNotFound(proxyId);
        return address(proxies[proxyId].proxy);
    }

    function getProxyCount() external view returns (uint256) {
        return proxyIds.length;
    }

    // ----------------------------- Release registry ------------------------------

    function registerRelease(
        bytes32 versionId,
        string calldata semver,
        address implementation,
        bytes32 codehash
    ) external onlyRole(REGISTRAR_ROLE) {
        if (implementation == address(0)) revert ZeroAddress();
        // Codehash is mandatory: a zero codehash would silently disable the
        // verification path in verifyProxy and defeat the registry's purpose.
        if (codehash == bytes32(0)) revert ZeroCodehash();
        if (releaseByVersion[versionId].exists) revert VersionAlreadyRegistered(versionId);
        if (versionByImplementation[implementation] != bytes32(0)) {
            revert ImplementationAlreadyRegistered(implementation);
        }

        releaseByVersion[versionId] = ReleaseInfo({
            implementation: implementation,
            exists: true,
            deprecated: false,
            codehash: codehash,
            semver: semver
        });
        versionByImplementation[implementation] = versionId;

        emit ReleaseRegistered(versionId, semver, implementation, codehash);
    }

    function deprecateRelease(bytes32 versionId) external onlyRole(DEPRECATOR_ROLE) {
        ReleaseInfo storage release = releaseByVersion[versionId];
        if (!release.exists) revert VersionNotFound(versionId);
        if (release.deprecated) revert AlreadyDeprecated(versionId);

        release.deprecated = true;

        emit ReleaseDeprecated(versionId, release.implementation);
    }

    // ----------------------------- Registry queries ------------------------------

    function getRelease(bytes32 versionId) external view returns (ReleaseInfo memory) {
        return releaseByVersion[versionId];
    }

    function getVersionForImplementation(address implementation) external view returns (bytes32) {
        return versionByImplementation[implementation];
    }

    function isImplementationApprovedForVersion(
        bytes32 versionId,
        address implementation
    ) external view returns (bool) {
        ReleaseInfo storage release = releaseByVersion[versionId];
        return release.exists && !release.deprecated && release.implementation == implementation;
    }

    // ----------------------------- Router / verification ------------------------------

    function setRoutedSelector(bytes4 selector, bool enabled) external onlyRole(ROUTER_ADMIN_ROLE) {
        routedSelector[selector] = enabled;
        emit SelectorRouted(selector, enabled);
    }

    function getProxyImplementation(bytes32 proxyId) public view returns (address) {
        ProxyEntry storage entry = proxies[proxyId];
        if (!entry.exists) revert ProxyNotFound(proxyId);
        return proxyAdmin.getProxyImplementation(entry.proxy);
    }

    function verifyProxy(bytes32 proxyId) public view returns (address implementation) {
        ProxyEntry storage entry = proxies[proxyId];
        if (!entry.exists) revert ProxyNotFound(proxyId);
        if (entry.deprecated) revert ProxyDeprecatedError(proxyId);

        implementation = proxyAdmin.getProxyImplementation(entry.proxy);

        bytes32 versionId = versionByImplementation[implementation];
        if (versionId == bytes32(0)) revert ImplementationNotRegistered(implementation);

        ReleaseInfo storage release = releaseByVersion[versionId];
        if (release.deprecated) revert ImplementationDeprecated(versionId);

        // Codehash is non-zero by construction (registerRelease enforces it).
        bytes32 actual;
        assembly {
            actual := extcodehash(implementation)
        }
        if (actual != release.codehash) revert CodehashMismatch(release.codehash, actual);
    }

    /**
     * @notice Forward a call to a registered proxy after verifying its implementation,
     *         restricted to selectors explicitly enabled via setRoutedSelector.
     * @dev The proxy implementation will see msg.sender == address(this). Only enable
     *      selectors whose semantics are compatible with the router being the caller.
     */
    function forward(bytes32 proxyId, bytes calldata data) external payable returns (bytes memory) {
        if (data.length < 4) revert CalldataTooShort();
        bytes4 selector = bytes4(data[:4]);
        if (!routedSelector[selector]) revert SelectorNotRouted(selector);

        address implementation = verifyProxy(proxyId);
        address proxyAddr = address(proxies[proxyId].proxy);

        emit Forwarded(msg.sender, selector, proxyId, implementation);

        (bool success, bytes memory result) = proxyAddr.call{value: msg.value}(data);
        if (!success) {
            assembly {
                revert(add(result, 32), mload(result))
            }
        }
        return result;
    }

    /**
     * @notice Admin-only forwarding that bypasses the selector allowlist.
     * @dev Restricted to ROUTER_ADMIN_ROLE because it can invoke any function on
     *      the proxy as the router. Intended for admin/maintenance flows only;
     *      regular Bee-node traffic should use {forward}.
     */
    function forwardUnchecked(
        bytes32 proxyId,
        bytes calldata data
    ) external payable onlyRole(ROUTER_ADMIN_ROLE) returns (bytes memory) {
        if (data.length < 4) revert CalldataTooShort();
        address implementation = verifyProxy(proxyId);
        address proxyAddr = address(proxies[proxyId].proxy);

        emit Forwarded(msg.sender, bytes4(data[:4]), proxyId, implementation);

        (bool success, bytes memory result) = proxyAddr.call{value: msg.value}(data);
        if (!success) {
            assembly {
                revert(add(result, 32), mload(result))
            }
        }
        return result;
    }

    // ----------------------------- Batch verification ------------------------------

    function verifyAllProxies() external view returns (bytes32[] memory verified) {
        uint256 count = proxyIds.length;
        verified = new bytes32[](count);
        for (uint256 i = 0; i < count; ) {
            bytes32 id = proxyIds[i];
            // Skip deprecated proxies rather than reverting the whole batch.
            if (proxies[id].exists && !proxies[id].deprecated) {
                verifyProxy(id);
                verified[i] = id;
            }
            unchecked {
                ++i;
            }
        }
    }
}
