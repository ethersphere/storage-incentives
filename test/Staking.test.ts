import { expect } from './util/chai';
import { ethers, deployments, getNamedAccounts, getUnnamedAccounts } from 'hardhat';

describe('Staking', function () {
  describe('when deploying contract', function () {
    beforeEach(async function () {
      await deployments.fixture();
    });

    it('should deploy StakeRegistry', async function () {
      const stakeRegistry = await ethers.getContract('StakeRegistry');
      expect(stakeRegistry.address).to.be.properAddress;
    });
  });
});
