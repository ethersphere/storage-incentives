import { expect } from './util/chai';
import { ethers, deployments, getNamedAccounts, getUnnamedAccounts } from 'hardhat';

// Named accounts used by tests.
let updater: string;
let deployer: string;
let others: string[];

// Before the tests, set named accounts and read deployments.
before(async function () {
  const namedAccounts = await getNamedAccounts();
  deployer = namedAccounts.deployer;
  updater = namedAccounts.stamper;
  others = await getUnnamedAccounts();
});

describe('PriceOracle', function () {
  describe('when deploying contract', function () {
    beforeEach(async function () {
      await deployments.fixture();
    });

    it('should deploy PriceOracle', async function () {
      const priceOracle = await ethers.getContract('PriceOracle');
      expect(priceOracle.address).to.be.properAddress;
    });

    it('should set the default admin role', async function () {
      const priceOracle = await ethers.getContract('PriceOracle');
      const updaterRole = await priceOracle.DEFAULT_ADMIN_ROLE();
      expect(await priceOracle.hasRole(updaterRole, deployer)).to.be.true;
    });

    it('should set the postage stamp contract', async function () {
      const priceOracle = await ethers.getContract('PriceOracle');
      const postageStamp = await priceOracle.postageStamp();
      expect(postageStamp).to.be.eq((await ethers.getContract('PostageStamp')).address);
    });
  });

  describe('with deployed contract', async function () {
    beforeEach(async function () {
      await deployments.fixture();
    });

    describe('when updating the price', function () {
      beforeEach(async function () {
        const priceOracle = await ethers.getContract('PriceOracle', deployer);
        const updaterRole = await priceOracle.PRICE_UPDATER_ROLE();
        await priceOracle.grantRole(updaterRole, updater);
      });

      it('should fire the PriceUpdate event for price updaters', async function () {
        const priceOracle = await ethers.getContract('PriceOracle', updater);
        const price = 100;
        await expect(priceOracle.setPrice(price)).to.emit(priceOracle, 'PriceUpdate').withArgs(price);
      });

      it('should fail if not price updater', async function () {
        const priceOracle = await ethers.getContract('PriceOracle', others[0]);
        const price = 100;
        await expect(priceOracle.setPrice(price)).to.be.revertedWith('caller is not a price updater');
      });

      it('should update the outpayments', async function () {
        const priceOracle = await ethers.getContract('PriceOracle', updater);
        const postageStamp = await ethers.getContract('PostageStamp');

        const price1 = 100;
        await priceOracle.setPrice(price1);
        // the price initially is 0, therefore nothing is charged
        expect(await postageStamp.totalOutPayment()).to.be.eq(0);

        const price2 = 200;
        await priceOracle.setPrice(price2);
        // price1 should be charged for 1 block
        expect(await postageStamp.totalOutPayment()).to.be.eq(price1);

        // mine 2 blocks
        await ethers.provider.send('evm_mine', []);
        await ethers.provider.send('evm_mine', []);
        await priceOracle.setPrice(0);
        // price2 should be charged for 3 blocks (the 2 mined blocks and the new block setPrice is in)
        expect(await postageStamp.totalOutPayment()).to.be.eq(price1 + 3 * price2);
      });
    });
  });
});
