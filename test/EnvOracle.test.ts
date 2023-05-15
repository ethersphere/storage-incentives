import { expect } from 'chai';
import { Contract } from 'ethers';
import { ethers, deployments, getUnnamedAccounts } from 'hardhat';
import { ENV_ORACLE_BEE_VERSION } from '../helper-hardhat-config';

const errors = {
  setMinimumBeeVersion: 'Minimum Bee version should be in semver form',
  permission: 'only administrator can use copy method',
};

describe('EnvOracle', function () {
  let envOracle: Contract;
  let otherAccounts: string[];

  beforeEach(async function () {
    await deployments.fixture();
    envOracle = await ethers.getContract('EnvOracle');
    otherAccounts = await getUnnamedAccounts();
  });

  it('should match the deployed minimum Bee version with the default one', async () => {
    expect(await envOracle.minimumBeeVersion()).to.equal(ENV_ORACLE_BEE_VERSION);
  });

  it('should change the version to different correct ones', async () => {
    const setterChecker = async function (version: string) {
      const tx = await envOracle.setMinimumBeeVersion(version);
      expect(await envOracle.minimumBeeVersion()).to.equal(version);

      const receipt = await tx.wait();
      const beeVersionChangedEvent = receipt.events[0];
      expect(beeVersionChangedEvent.event).to.be.equal('MinimumBeeVersionChanged');
      expect(beeVersionChangedEvent.args[0]).to.be.equal(version);
    };

    await setterChecker('0.0.1');
    await setterChecker('99.999.9999');
    await setterChecker('10.101.101');
    await setterChecker('100.100.100');
  });

  it('should not change the version in a wrong format', async () => {
    const revertedChecker = async function (version: string) {
      await expect(envOracle.setMinimumBeeVersion(version)).to.be.revertedWith(errors.setMinimumBeeVersion);
    };

    await revertedChecker('0.0.1.');
    await revertedChecker('01.0.1');
    await revertedChecker('0.a.1');
    await revertedChecker('0.1');
    await revertedChecker('0.0.-1');
    await revertedChecker('0.0.');
    await revertedChecker('0..');
    await revertedChecker('.0.');
    await revertedChecker('..0');
    await revertedChecker('11..0');
    await revertedChecker('..');
    await revertedChecker('');
  });

  it('should not change minimum version without admin permission', async () => {
    const revertedChecker = async function (account: string) {
      const envOracle = await ethers.getContract('EnvOracle', account);
      await expect(envOracle.setMinimumBeeVersion('0.0.1')).to.be.revertedWith(errors.permission);
    };

    for (const account of otherAccounts) {
      await revertedChecker(account);
    }
  });

  it('should grant admin role to other account to perform action', async () => {
    const otherAccount = otherAccounts[0];
    const envOracle2 = await ethers.getContract('EnvOracle', otherAccount);
    await expect(envOracle2.setMinimumBeeVersion('0.0.1')).to.be.revertedWith(errors.permission);

    const adminRole = await envOracle.DEFAULT_ADMIN_ROLE();
    await envOracle.grantRole(adminRole, otherAccount);
    await envOracle2.setMinimumBeeVersion('0.0.1');
    expect(await envOracle2.minimumBeeVersion()).to.equal('0.0.1');
  });
});
