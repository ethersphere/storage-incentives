import { expect } from './util/chai';
import { ethers, getNamedAccounts } from 'hardhat';
import { Contract } from 'ethers';

let deployer: string;
let admin: string;
let node_0: string;

let registry: Contract;
let ozProxyAdmin: Contract;
let sampleProxy: Contract;
let implV1: Contract;
let implV2: Contract;

const v1Semver = '1.0.0';
const v2Semver = '2.0.0';
const v1Id = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(v1Semver));
const v2Id = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(v2Semver));
const unusedVersionId = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('99.99.99'));

const SAMPLE_PROXY_ID = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('SampleProxy'));
const STAKING_PROXY_ID = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('StakeRegistry'));

const zeroBytes32 = '0x' + '0'.repeat(64);
const zeroAddress = '0x0000000000000000000000000000000000000000';

before(async function () {
  const namedAccounts = await getNamedAccounts();
  deployer = namedAccounts.deployer;
  admin = namedAccounts.admin;
  node_0 = namedAccounts.node_0;
});

async function getCodehash(address: string): Promise<string> {
  return ethers.utils.keccak256(await ethers.provider.getCode(address));
}

async function setupFixture() {
  const signer = await ethers.getSigner(deployer);

  const ProxyAdminFactory = await ethers.getContractFactory('ProxyAdmin', signer);
  ozProxyAdmin = await ProxyAdminFactory.deploy();
  await ozProxyAdmin.deployed();

  const ImplV1Factory = await ethers.getContractFactory('SampleImplementation', signer);
  implV1 = await ImplV1Factory.deploy();
  await implV1.deployed();

  const ImplV2Factory = await ethers.getContractFactory('SampleImplementationV2', signer);
  implV2 = await ImplV2Factory.deploy();
  await implV2.deployed();

  const ProxyFactory = await ethers.getContractFactory('TransparentUpgradeableProxy', signer);
  sampleProxy = await ProxyFactory.deploy(implV1.address, ozProxyAdmin.address, '0x');
  await sampleProxy.deployed();

  const RegistryFactory = await ethers.getContractFactory('VersionedRegistryRouter', signer);
  registry = await RegistryFactory.deploy(ozProxyAdmin.address);
  await registry.deployed();
}

describe('VersionedRegistryRouter', function () {
  // ====================================================================
  // Deployment
  // ====================================================================
  describe('when deploying', function () {
    beforeEach(setupFixture);

    it('should set the proxyAdmin address', async function () {
      expect(await registry.proxyAdmin()).to.equal(ozProxyAdmin.address);
    });

    it('should grant deployer all roles', async function () {
      const REGISTRAR_ROLE = await registry.REGISTRAR_ROLE();
      const DEPRECATOR_ROLE = await registry.DEPRECATOR_ROLE();
      const ROUTER_ADMIN_ROLE = await registry.ROUTER_ADMIN_ROLE();
      const DEFAULT_ADMIN_ROLE = await registry.DEFAULT_ADMIN_ROLE();

      expect(await registry.hasRole(DEFAULT_ADMIN_ROLE, deployer)).to.be.true;
      expect(await registry.hasRole(REGISTRAR_ROLE, deployer)).to.be.true;
      expect(await registry.hasRole(DEPRECATOR_ROLE, deployer)).to.be.true;
      expect(await registry.hasRole(ROUTER_ADMIN_ROLE, deployer)).to.be.true;
    });

    it('should revert with zero address proxyAdmin', async function () {
      const Factory = await ethers.getContractFactory('VersionedRegistryRouter');
      await expect(Factory.deploy(zeroAddress)).to.be.revertedWith('ZeroAddress()');
    });
  });

  // ====================================================================
  // Proxy registration
  // ====================================================================
  describe('Proxy registration', function () {
    beforeEach(setupFixture);

    it('should register a proxy and emit ProxyRegistered', async function () {
      await expect(registry.registerProxy(SAMPLE_PROXY_ID, sampleProxy.address))
        .to.emit(registry, 'ProxyRegistered')
        .withArgs(SAMPLE_PROXY_ID, sampleProxy.address);
    });

    it('should store proxy and make it queryable', async function () {
      await registry.registerProxy(SAMPLE_PROXY_ID, sampleProxy.address);

      expect(await registry.getProxyAddress(SAMPLE_PROXY_ID)).to.equal(sampleProxy.address);
      expect(await registry.getProxyCount()).to.equal(1);
    });

    it('should allow registering multiple proxies', async function () {
      const SecondImplFactory = await ethers.getContractFactory('SampleImplementation');
      const secondImpl = await SecondImplFactory.deploy();
      await secondImpl.deployed();

      const ProxyFactory = await ethers.getContractFactory('TransparentUpgradeableProxy');
      const secondProxy = await ProxyFactory.deploy(secondImpl.address, ozProxyAdmin.address, '0x');
      await secondProxy.deployed();

      await registry.registerProxy(SAMPLE_PROXY_ID, sampleProxy.address);
      await registry.registerProxy(STAKING_PROXY_ID, secondProxy.address);

      expect(await registry.getProxyCount()).to.equal(2);
      expect(await registry.getProxyAddress(SAMPLE_PROXY_ID)).to.equal(sampleProxy.address);
      expect(await registry.getProxyAddress(STAKING_PROXY_ID)).to.equal(secondProxy.address);
    });

    it('should revert if proxy already registered', async function () {
      await registry.registerProxy(SAMPLE_PROXY_ID, sampleProxy.address);
      await expect(registry.registerProxy(SAMPLE_PROXY_ID, sampleProxy.address)).to.be.reverted;
    });

    it('should revert if proxy is zero address', async function () {
      await expect(registry.registerProxy(SAMPLE_PROXY_ID, zeroAddress)).to.be.reverted;
    });

    it('should revert if proxy admin does not match registry proxyAdmin', async function () {
      const ProxyAdminFactory = await ethers.getContractFactory('ProxyAdmin');
      const otherAdmin = await ProxyAdminFactory.deploy();
      await otherAdmin.deployed();

      const ImplFactory = await ethers.getContractFactory('SampleImplementation');
      const impl = await ImplFactory.deploy();
      await impl.deployed();

      const ProxyFactory = await ethers.getContractFactory('TransparentUpgradeableProxy');
      const foreignProxy = await ProxyFactory.deploy(impl.address, otherAdmin.address, '0x');
      await foreignProxy.deployed();

      await expect(registry.registerProxy(SAMPLE_PROXY_ID, foreignProxy.address)).to.be.reverted;
    });

    it('should revert if caller lacks ROUTER_ADMIN_ROLE', async function () {
      const registryAsNode = registry.connect(await ethers.getSigner(node_0));
      await expect(registryAsNode.registerProxy(SAMPLE_PROXY_ID, sampleProxy.address)).to.be.reverted;
    });

    it('should revert getProxyAddress for unregistered proxyId', async function () {
      await expect(registry.getProxyAddress(SAMPLE_PROXY_ID)).to.be.reverted;
    });
  });

  // ====================================================================
  // Proxy deprecation
  // ====================================================================
  describe('Proxy deprecation', function () {
    beforeEach(async function () {
      await setupFixture();
      await registry.registerProxy(SAMPLE_PROXY_ID, sampleProxy.address);
    });

    it('should deprecate and emit ProxyDeprecated', async function () {
      await expect(registry.deprecateProxy(SAMPLE_PROXY_ID))
        .to.emit(registry, 'ProxyDeprecated')
        .withArgs(SAMPLE_PROXY_ID, sampleProxy.address);
    });

    it('should revert verifyProxy after deprecation', async function () {
      const codehash = await getCodehash(implV1.address);
      await registry.registerRelease(v1Id, v1Semver, implV1.address, codehash);

      expect(await registry.verifyProxy(SAMPLE_PROXY_ID)).to.equal(implV1.address);
      await registry.deprecateProxy(SAMPLE_PROXY_ID);
      await expect(registry.verifyProxy(SAMPLE_PROXY_ID)).to.be.reverted;
    });

    it('should revert if proxy not registered', async function () {
      await expect(registry.deprecateProxy(STAKING_PROXY_ID)).to.be.reverted;
    });

    it('should revert if already deprecated', async function () {
      await registry.deprecateProxy(SAMPLE_PROXY_ID);
      await expect(registry.deprecateProxy(SAMPLE_PROXY_ID)).to.be.reverted;
    });

    it('should revert if caller lacks DEPRECATOR_ROLE', async function () {
      const registryAsNode = registry.connect(await ethers.getSigner(node_0));
      await expect(registryAsNode.deprecateProxy(SAMPLE_PROXY_ID)).to.be.reverted;
    });
  });

  // ====================================================================
  // Release registry
  // ====================================================================
  describe('Registry — registerRelease', function () {
    beforeEach(setupFixture);

    it('should register a release successfully', async function () {
      const codehash = await getCodehash(implV1.address);

      await expect(registry.registerRelease(v1Id, v1Semver, implV1.address, codehash))
        .to.emit(registry, 'ReleaseRegistered')
        .withArgs(v1Id, v1Semver, implV1.address, codehash);

      const release = await registry.getRelease(v1Id);
      expect(release.implementation).to.equal(implV1.address);
      expect(release.exists).to.be.true;
      expect(release.deprecated).to.be.false;
      expect(release.codehash).to.equal(codehash);
      expect(release.semver).to.equal(v1Semver);
    });

    it('should set the reverse mapping', async function () {
      const codehash = await getCodehash(implV1.address);
      await registry.registerRelease(v1Id, v1Semver, implV1.address, codehash);
      expect(await registry.getVersionForImplementation(implV1.address)).to.equal(v1Id);
    });

    it('should allow registering multiple distinct releases', async function () {
      const ch1 = await getCodehash(implV1.address);
      const ch2 = await getCodehash(implV2.address);

      await registry.registerRelease(v1Id, v1Semver, implV1.address, ch1);
      await registry.registerRelease(v2Id, v2Semver, implV2.address, ch2);

      expect((await registry.getRelease(v1Id)).implementation).to.equal(implV1.address);
      expect((await registry.getRelease(v2Id)).implementation).to.equal(implV2.address);
    });

    it('should revert if codehash is zero', async function () {
      await expect(registry.registerRelease(v1Id, v1Semver, implV1.address, zeroBytes32)).to.be.reverted;
    });

    it('should revert if version already registered (Invariant 1)', async function () {
      const ch1 = await getCodehash(implV1.address);
      const ch2 = await getCodehash(implV2.address);
      await registry.registerRelease(v1Id, v1Semver, implV1.address, ch1);
      await expect(registry.registerRelease(v1Id, v1Semver, implV2.address, ch2)).to.be.reverted;
    });

    it('should revert if implementation already registered (Invariant 2)', async function () {
      const ch1 = await getCodehash(implV1.address);
      await registry.registerRelease(v1Id, v1Semver, implV1.address, ch1);
      await expect(registry.registerRelease(v2Id, v2Semver, implV1.address, ch1)).to.be.reverted;
    });

    it('should revert if implementation is zero address (Invariant 3)', async function () {
      const ch1 = await getCodehash(implV1.address);
      await expect(registry.registerRelease(v1Id, v1Semver, zeroAddress, ch1)).to.be.reverted;
    });

    it('should revert if caller lacks REGISTRAR_ROLE', async function () {
      const registryAsNode = registry.connect(await ethers.getSigner(node_0));
      const ch1 = await getCodehash(implV1.address);
      await expect(registryAsNode.registerRelease(v1Id, v1Semver, implV1.address, ch1)).to.be.reverted;
    });
  });

  // ====================================================================
  // Deprecation
  // ====================================================================
  describe('Registry — deprecateRelease', function () {
    beforeEach(async function () {
      await setupFixture();
      const ch1 = await getCodehash(implV1.address);
      await registry.registerRelease(v1Id, v1Semver, implV1.address, ch1);
    });

    it('should deprecate and emit ReleaseDeprecated', async function () {
      await expect(registry.deprecateRelease(v1Id))
        .to.emit(registry, 'ReleaseDeprecated')
        .withArgs(v1Id, implV1.address);

      expect((await registry.getRelease(v1Id)).deprecated).to.be.true;
    });

    it('should keep release queryable after deprecation (Invariant 5)', async function () {
      await registry.deprecateRelease(v1Id);

      const release = await registry.getRelease(v1Id);
      expect(release.exists).to.be.true;
      expect(release.deprecated).to.be.true;
      expect(release.implementation).to.equal(implV1.address);
      expect(release.semver).to.equal(v1Semver);
    });

    it('should preserve reverse mapping after deprecation', async function () {
      await registry.deprecateRelease(v1Id);
      expect(await registry.getVersionForImplementation(implV1.address)).to.equal(v1Id);
    });

    it('should revert if version does not exist', async function () {
      await expect(registry.deprecateRelease(unusedVersionId)).to.be.reverted;
    });

    it('should revert if already deprecated', async function () {
      await registry.deprecateRelease(v1Id);
      await expect(registry.deprecateRelease(v1Id)).to.be.reverted;
    });

    it('should revert if caller lacks DEPRECATOR_ROLE', async function () {
      const registryAsNode = registry.connect(await ethers.getSigner(node_0));
      await expect(registryAsNode.deprecateRelease(v1Id)).to.be.reverted;
    });
  });

  // ====================================================================
  // Approval check
  // ====================================================================
  describe('Registry — isImplementationApprovedForVersion', function () {
    beforeEach(async function () {
      await setupFixture();
      const ch1 = await getCodehash(implV1.address);
      await registry.registerRelease(v1Id, v1Semver, implV1.address, ch1);
    });

    it('should return true for matching pair', async function () {
      expect(await registry.isImplementationApprovedForVersion(v1Id, implV1.address)).to.be.true;
    });

    it('should return false for mismatched implementation', async function () {
      expect(await registry.isImplementationApprovedForVersion(v1Id, implV2.address)).to.be.false;
    });

    it('should return false for non-existent version', async function () {
      expect(await registry.isImplementationApprovedForVersion(unusedVersionId, implV1.address)).to.be.false;
    });

    it('should return false after deprecation', async function () {
      await registry.deprecateRelease(v1Id);
      expect(await registry.isImplementationApprovedForVersion(v1Id, implV1.address)).to.be.false;
    });
  });

  // ====================================================================
  // Router — verify proxy
  // ====================================================================
  describe('Router — verifyProxy', function () {
    beforeEach(async function () {
      await setupFixture();
      await registry.registerProxy(SAMPLE_PROXY_ID, sampleProxy.address);
    });

    it('should verify when implementation is registered', async function () {
      const codehash = await getCodehash(implV1.address);
      await registry.registerRelease(v1Id, v1Semver, implV1.address, codehash);

      const impl = await registry.verifyProxy(SAMPLE_PROXY_ID);
      expect(impl).to.equal(implV1.address);
    });

    it('should revert if proxy implementation is not registered', async function () {
      await expect(registry.verifyProxy(SAMPLE_PROXY_ID)).to.be.reverted;
    });

    it('should revert if proxy implementation is deprecated', async function () {
      const codehash = await getCodehash(implV1.address);
      await registry.registerRelease(v1Id, v1Semver, implV1.address, codehash);
      await registry.deprecateRelease(v1Id);
      await expect(registry.verifyProxy(SAMPLE_PROXY_ID)).to.be.reverted;
    });

    it('should revert if codehash does not match', async function () {
      const badCodehash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('wrong-code'));
      await registry.registerRelease(v1Id, v1Semver, implV1.address, badCodehash);
      await expect(registry.verifyProxy(SAMPLE_PROXY_ID)).to.be.reverted;
    });

    it('should revert for unregistered proxyId', async function () {
      await expect(registry.verifyProxy(STAKING_PROXY_ID)).to.be.reverted;
    });
  });

  // ====================================================================
  // Router — getProxyImplementation
  // ====================================================================
  describe('Router — getProxyImplementation', function () {
    beforeEach(async function () {
      await setupFixture();
      await registry.registerProxy(SAMPLE_PROXY_ID, sampleProxy.address);
    });

    it('should return current implementation from ProxyAdmin', async function () {
      const impl = await registry.getProxyImplementation(SAMPLE_PROXY_ID);
      expect(impl).to.equal(implV1.address);
    });

    it('should reflect upgraded implementation after ProxyAdmin.upgrade', async function () {
      await ozProxyAdmin.upgrade(sampleProxy.address, implV2.address);
      const impl = await registry.getProxyImplementation(SAMPLE_PROXY_ID);
      expect(impl).to.equal(implV2.address);
    });
  });

  // ====================================================================
  // Router — forward (selector-gated)
  // ====================================================================
  describe('Router — forward (selector-gated)', function () {
    beforeEach(async function () {
      await setupFixture();
      await registry.registerProxy(SAMPLE_PROXY_ID, sampleProxy.address);
      const codehash = await getCodehash(implV1.address);
      await registry.registerRelease(v1Id, v1Semver, implV1.address, codehash);
    });

    it('should forward a routed selector and emit Forwarded', async function () {
      const iface = (await ethers.getContractFactory('SampleImplementation')).interface;
      const setValueSelector = iface.getSighash('setValue');
      await registry.setRoutedSelector(setValueSelector, true);

      const calldata = iface.encodeFunctionData('setValue', [42]);
      await expect(registry.forward(SAMPLE_PROXY_ID, calldata)).to.emit(registry, 'Forwarded');

      const proxied = await ethers.getContractAt('SampleImplementation', sampleProxy.address);
      expect(await proxied.value()).to.equal(42);
    });

    it('should revert if selector is not routed', async function () {
      const iface = (await ethers.getContractFactory('SampleImplementation')).interface;
      const calldata = iface.encodeFunctionData('setValue', [42]);
      await expect(registry.forward(SAMPLE_PROXY_ID, calldata)).to.be.reverted;
    });

    it('should revert if calldata is shorter than 4 bytes', async function () {
      await expect(registry.forward(SAMPLE_PROXY_ID, '0x')).to.be.reverted;
      await expect(registry.forward(SAMPLE_PROXY_ID, '0x010203')).to.be.reverted;
    });

    it('should emit SelectorRouted when enabling', async function () {
      const iface = (await ethers.getContractFactory('SampleImplementation')).interface;
      const sel = iface.getSighash('setValue');
      await expect(registry.setRoutedSelector(sel, true)).to.emit(registry, 'SelectorRouted').withArgs(sel, true);
    });

    it('should allow disabling a previously routed selector', async function () {
      const iface = (await ethers.getContractFactory('SampleImplementation')).interface;
      const sel = iface.getSighash('setValue');
      await registry.setRoutedSelector(sel, true);
      await registry.setRoutedSelector(sel, false);

      const calldata = iface.encodeFunctionData('setValue', [42]);
      await expect(registry.forward(SAMPLE_PROXY_ID, calldata)).to.be.reverted;
    });

    it('should revert setRoutedSelector without ROUTER_ADMIN_ROLE', async function () {
      const registryAsNode = registry.connect(await ethers.getSigner(node_0));
      const iface = (await ethers.getContractFactory('SampleImplementation')).interface;
      await expect(registryAsNode.setRoutedSelector(iface.getSighash('setValue'), true)).to.be.reverted;
    });
  });

  // ====================================================================
  // Router — forwardUnchecked
  // ====================================================================
  describe('Router — forwardUnchecked', function () {
    beforeEach(async function () {
      await setupFixture();
      await registry.registerProxy(SAMPLE_PROXY_ID, sampleProxy.address);
      const codehash = await getCodehash(implV1.address);
      await registry.registerRelease(v1Id, v1Semver, implV1.address, codehash);
    });

    it('should forward without selector check when caller is ROUTER_ADMIN_ROLE', async function () {
      const iface = (await ethers.getContractFactory('SampleImplementation')).interface;
      const calldata = iface.encodeFunctionData('setValue', [99]);

      await expect(registry.forwardUnchecked(SAMPLE_PROXY_ID, calldata)).to.emit(registry, 'Forwarded');

      const proxied = await ethers.getContractAt('SampleImplementation', sampleProxy.address);
      expect(await proxied.value()).to.equal(99);
    });

    it('should revert when caller lacks ROUTER_ADMIN_ROLE', async function () {
      const registryAsNode = registry.connect(await ethers.getSigner(node_0));
      const iface = (await ethers.getContractFactory('SampleImplementation')).interface;
      const calldata = iface.encodeFunctionData('setValue', [99]);
      await expect(registryAsNode.forwardUnchecked(SAMPLE_PROXY_ID, calldata)).to.be.reverted;
    });

    it('should revert if calldata is shorter than 4 bytes', async function () {
      await expect(registry.forwardUnchecked(SAMPLE_PROXY_ID, '0x')).to.be.reverted;
    });

    it('should still verify implementation registration', async function () {
      await ozProxyAdmin.upgrade(sampleProxy.address, implV2.address);

      const iface = (await ethers.getContractFactory('SampleImplementation')).interface;
      const calldata = iface.encodeFunctionData('setValue', [1]);
      await expect(registry.forwardUnchecked(SAMPLE_PROXY_ID, calldata)).to.be.reverted;
    });
  });

  // ====================================================================
  // Immutable mappings (Invariant 4)
  // ====================================================================
  describe('Invariant 4 — immutable mappings', function () {
    beforeEach(setupFixture);

    it('should not allow same version with different implementation', async function () {
      const ch1 = await getCodehash(implV1.address);
      const ch2 = await getCodehash(implV2.address);
      await registry.registerRelease(v1Id, v1Semver, implV1.address, ch1);
      await expect(registry.registerRelease(v1Id, v1Semver, implV2.address, ch2)).to.be.reverted;
    });

    it('should not allow same implementation under different version', async function () {
      const ch1 = await getCodehash(implV1.address);
      await registry.registerRelease(v1Id, v1Semver, implV1.address, ch1);
      await expect(registry.registerRelease(v2Id, v2Semver, implV1.address, ch1)).to.be.reverted;
    });

    it('should not allow re-registering even after deprecation', async function () {
      const ch1 = await getCodehash(implV1.address);
      const ch2 = await getCodehash(implV2.address);
      await registry.registerRelease(v1Id, v1Semver, implV1.address, ch1);
      await registry.deprecateRelease(v1Id);
      await expect(registry.registerRelease(v1Id, '1.0.0-reuse', implV2.address, ch2)).to.be.reverted;
    });
  });

  // ====================================================================
  // End-to-end: full upgrade lifecycle with real proxy
  // ====================================================================
  describe('End-to-end: proxy upgrade lifecycle', function () {
    beforeEach(setupFixture);

    it('should handle: register v1 → use proxy → upgrade to v2 → deprecate v1', async function () {
      const ch1 = await getCodehash(implV1.address);
      const ch2 = await getCodehash(implV2.address);

      await registry.registerProxy(SAMPLE_PROXY_ID, sampleProxy.address);
      await registry.registerRelease(v1Id, v1Semver, implV1.address, ch1);
      expect(await registry.isImplementationApprovedForVersion(v1Id, implV1.address)).to.be.true;

      const addr1 = await registry.verifyProxy(SAMPLE_PROXY_ID);
      expect(addr1).to.equal(implV1.address);

      const iface = (await ethers.getContractFactory('SampleImplementation')).interface;
      const sel = iface.getSighash('setValue');
      await registry.setRoutedSelector(sel, true);
      await registry.forward(SAMPLE_PROXY_ID, iface.encodeFunctionData('setValue', [100]));

      const proxiedV1 = await ethers.getContractAt('SampleImplementation', sampleProxy.address);
      expect(await proxiedV1.value()).to.equal(100);

      await registry.registerRelease(v2Id, v2Semver, implV2.address, ch2);
      await ozProxyAdmin.upgrade(sampleProxy.address, implV2.address);

      const addr2 = await registry.verifyProxy(SAMPLE_PROXY_ID);
      expect(addr2).to.equal(implV2.address);

      // State preserved after upgrade
      expect(await proxiedV1.value()).to.equal(100);

      const ifaceV2 = (await ethers.getContractFactory('SampleImplementationV2')).interface;
      const selExtra = ifaceV2.getSighash('setExtra');
      await registry.setRoutedSelector(selExtra, true);
      await registry.forward(SAMPLE_PROXY_ID, ifaceV2.encodeFunctionData('setExtra', [999]));

      const proxiedV2 = await ethers.getContractAt('SampleImplementationV2', sampleProxy.address);
      expect(await proxiedV2.extra()).to.equal(999);

      await registry.deprecateRelease(v1Id);
      expect(await registry.isImplementationApprovedForVersion(v1Id, implV1.address)).to.be.false;
      const oldRelease = await registry.getRelease(v1Id);
      expect(oldRelease.exists).to.be.true;
      expect(oldRelease.deprecated).to.be.true;

      expect(await registry.isImplementationApprovedForVersion(v2Id, implV2.address)).to.be.true;
    });

    it('should reject proxy upgraded to unregistered implementation', async function () {
      const ch1 = await getCodehash(implV1.address);
      await registry.registerProxy(SAMPLE_PROXY_ID, sampleProxy.address);
      await registry.registerRelease(v1Id, v1Semver, implV1.address, ch1);

      await ozProxyAdmin.upgrade(sampleProxy.address, implV2.address);

      expect(await registry.getVersionForImplementation(implV2.address)).to.equal(zeroBytes32);
      await expect(registry.verifyProxy(SAMPLE_PROXY_ID)).to.be.reverted;
    });

    it('should simulate Bee node local allowlist verification', async function () {
      await registry.registerProxy(SAMPLE_PROXY_ID, sampleProxy.address);
      const ch1 = await getCodehash(implV1.address);
      await registry.registerRelease(v1Id, v1Semver, implV1.address, ch1);

      const beeAllowlist: Record<string, string> = {
        [v1Id]: implV1.address,
      };

      const currentImpl = await registry.getProxyImplementation(SAMPLE_PROXY_ID);
      const versionId = await registry.getVersionForImplementation(currentImpl);

      const allowedImpl = beeAllowlist[versionId];
      expect(allowedImpl).to.not.be.undefined;
      expect(allowedImpl.toLowerCase()).to.equal(currentImpl.toLowerCase());

      const release = await registry.getRelease(versionId);
      expect(release.exists).to.be.true;
      expect(release.deprecated).to.be.false;
    });
  });

  // ====================================================================
  // Multi-proxy verification
  // ====================================================================
  describe('Multi-proxy: verifyAllProxies', function () {
    let secondImpl: Contract;
    let secondProxy: Contract;

    beforeEach(async function () {
      await setupFixture();

      const SecondImplFactory = await ethers.getContractFactory('SampleImplementation');
      secondImpl = await SecondImplFactory.deploy();
      await secondImpl.deployed();

      const ProxyFactory = await ethers.getContractFactory('TransparentUpgradeableProxy');
      secondProxy = await ProxyFactory.deploy(secondImpl.address, ozProxyAdmin.address, '0x');
      await secondProxy.deployed();

      const ch1 = await getCodehash(implV1.address);
      const ch2 = await getCodehash(secondImpl.address);

      await registry.registerProxy(SAMPLE_PROXY_ID, sampleProxy.address);
      await registry.registerProxy(STAKING_PROXY_ID, secondProxy.address);

      await registry.registerRelease(v1Id, v1Semver, implV1.address, ch1);
      await registry.registerRelease(v2Id, v2Semver, secondImpl.address, ch2);
    });

    it('should verify all proxies when all implementations are registered', async function () {
      const verified = await registry.verifyAllProxies();
      expect(verified.length).to.equal(2);
      expect(verified[0]).to.equal(SAMPLE_PROXY_ID);
      expect(verified[1]).to.equal(STAKING_PROXY_ID);
    });

    it('should skip deprecated proxies without reverting', async function () {
      await registry.deprecateProxy(STAKING_PROXY_ID);
      const verified = await registry.verifyAllProxies();
      expect(verified.length).to.equal(2);
      expect(verified[0]).to.equal(SAMPLE_PROXY_ID);
      expect(verified[1]).to.equal(zeroBytes32);
    });

    it('should revert if any active proxy has unregistered implementation', async function () {
      const ThirdImplFactory = await ethers.getContractFactory('SampleImplementationV2');
      const thirdImpl = await ThirdImplFactory.deploy();
      await thirdImpl.deployed();

      const ProxyFactory = await ethers.getContractFactory('TransparentUpgradeableProxy');
      const thirdProxy = await ProxyFactory.deploy(thirdImpl.address, ozProxyAdmin.address, '0x');
      await thirdProxy.deployed();

      const THIRD_ID = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('ThirdProxy'));
      await registry.registerProxy(THIRD_ID, thirdProxy.address);

      await expect(registry.verifyAllProxies()).to.be.reverted;
    });
  });

  // ====================================================================
  // Edge cases
  // ====================================================================
  describe('Edge cases', function () {
    beforeEach(setupFixture);

    it('should return empty ReleaseInfo for unregistered versionId', async function () {
      const release = await registry.getRelease(unusedVersionId);
      expect(release.implementation).to.equal(zeroAddress);
      expect(release.exists).to.be.false;
    });

    it('should return zero bytes32 for unregistered implementation', async function () {
      expect(await registry.getVersionForImplementation(implV1.address)).to.equal(zeroBytes32);
    });

    it('should report 0 proxies initially', async function () {
      expect(await registry.getProxyCount()).to.equal(0);
    });
  });

  // ====================================================================
  // Role management
  // ====================================================================
  describe('Role management', function () {
    beforeEach(setupFixture);

    it('should allow admin to grant REGISTRAR_ROLE', async function () {
      const REGISTRAR_ROLE = await registry.REGISTRAR_ROLE();
      await registry.grantRole(REGISTRAR_ROLE, admin);

      const ch1 = await getCodehash(implV1.address);
      const registryAsAdmin = registry.connect(await ethers.getSigner(admin));
      await expect(registryAsAdmin.registerRelease(v1Id, v1Semver, implV1.address, ch1)).to.emit(
        registry,
        'ReleaseRegistered'
      );
    });

    it('should allow admin to revoke REGISTRAR_ROLE', async function () {
      const REGISTRAR_ROLE = await registry.REGISTRAR_ROLE();
      await registry.grantRole(REGISTRAR_ROLE, admin);
      await registry.revokeRole(REGISTRAR_ROLE, admin);

      const ch1 = await getCodehash(implV1.address);
      const registryAsAdmin = registry.connect(await ethers.getSigner(admin));
      await expect(registryAsAdmin.registerRelease(v1Id, v1Semver, implV1.address, ch1)).to.be.reverted;
    });

    it('should allow separate DEPRECATOR_ROLE from REGISTRAR_ROLE', async function () {
      const DEPRECATOR_ROLE = await registry.DEPRECATOR_ROLE();
      await registry.grantRole(DEPRECATOR_ROLE, admin);
      const ch1 = await getCodehash(implV1.address);
      await registry.registerRelease(v1Id, v1Semver, implV1.address, ch1);

      const registryAsAdmin = registry.connect(await ethers.getSigner(admin));
      await expect(registryAsAdmin.deprecateRelease(v1Id)).to.emit(registry, 'ReleaseDeprecated');
    });

    it('should allow granting ROUTER_ADMIN_ROLE to manage proxies', async function () {
      const ROUTER_ADMIN_ROLE = await registry.ROUTER_ADMIN_ROLE();
      await registry.grantRole(ROUTER_ADMIN_ROLE, admin);

      const registryAsAdmin = registry.connect(await ethers.getSigner(admin));
      await expect(registryAsAdmin.registerProxy(SAMPLE_PROXY_ID, sampleProxy.address)).to.emit(
        registry,
        'ProxyRegistered'
      );
    });
  });
});
