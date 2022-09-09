import { expect } from './util/chai';
import { ethers, deployments, getNamedAccounts, getUnnamedAccounts } from 'hardhat';
import { Signer,Contract } from 'ethers';

// Named accounts used by tests.
let deployer: string;
let others: string[];

// Before the tests, set named accounts and read deployments.
before(async function () {
  const namedAccounts = await getNamedAccounts();
  deployer = namedAccounts.deployer;
  others = await getUnnamedAccounts();
});

let stakeRegistry:Contract;

describe('Staking', function () {
  describe('when deploying contract', function () {
    beforeEach(async function () {
      stakeRegistry = await ethers.getContract('StakeRegistry');
      await deployments.fixture();
    });

    it('should deploy StakeRegistry', async function () {
      expect(stakeRegistry.address).to.be.properAddress;
    });
  });
});
