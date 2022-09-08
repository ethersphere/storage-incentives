import { expect } from './util/chai';
import { ethers, deployments, getNamedAccounts, getUnnamedAccounts } from 'hardhat';
import { Signer } from 'ethers';

async function mineNBlocks(n: number) {
  for (let index = 0; index < n; index++) {
    await ethers.provider.send('evm_mine', []);
  }
}

describe('Redistribution', function () {
  describe('when deploying contract', function () {
    beforeEach(async function () {
      await deployments.fixture();
    });

    it('should deploy Redistribution', async function () {
      const redistribution = await ethers.getContract('Redistribution');
      expect(redistribution.address).to.be.properAddress;
    });
  });
});
