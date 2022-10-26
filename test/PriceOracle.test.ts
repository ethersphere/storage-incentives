import { expect } from './util/chai';
import { ethers, deployments, getNamedAccounts, getUnnamedAccounts } from 'hardhat';
import { Event, Contract } from 'ethers';
import { mineNBlocks } from './util/tools';


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

const increaseRate = [0, 1069, 1040, 1032, 1024, 1014, 1004, 995, 980];

const errors = {
  manual: {
    notAdmin: 'caller is not the admin',
  },
  auto: {
    notZero: 'unexpected zero'
  }
};

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

    describe('manual update', function(){
      let minPriceString: string;
      let priceOracle: Contract, postageStamp: Contract;

      beforeEach(async function () {
        priceOracle = await ethers.getContract('PriceOracle', deployer);
        postageStamp = await ethers.getContract('PostageStamp')

        const updaterRole = await priceOracle.PRICE_UPDATER_ROLE();
        await priceOracle.grantRole(updaterRole, updater);

        //initialise, set minimum price
        const minimumPrice = await priceOracle.minimumPrice();
        minPriceString = minimumPrice.toString();
        await priceOracle.setPrice(minPriceString);
      });

      it('is initialised', async function () {
        expect(await priceOracle.currentPrice()).to.be.eq(minPriceString);

        expect(await postageStamp.lastPrice()).to.be.eq(minPriceString);
      });


      it('cannot be updated manually by non admin', async function () {
        const currentPrice = await priceOracle.currentPrice()
        const newPrice = currentPrice + 1024;

        const priceOracleN = await ethers.getContract('PriceOracle', others[1]);
        await expect(priceOracleN.setPrice(newPrice)).to.be.revertedWith(errors.manual.notAdmin);

        const priceOracleU = await ethers.getContract('PriceOracle', updater);
        await expect(priceOracleN.setPrice(newPrice)).to.be.revertedWith(errors.manual.notAdmin);
      });

      it('can be updated manually by admin', async function () {
        const currentPrice = await priceOracle.currentPrice()
        const newPrice = currentPrice + 1024;

        await expect(priceOracle.setPrice(newPrice)).to.emit(priceOracle, 'PriceUpdate').withArgs(newPrice);
        expect(await priceOracle.currentPrice()).to.be.eq(newPrice);

        expect(await postageStamp.lastPrice()).to.be.eq(newPrice);
      });

      it('should update the outpayments', async function () {
        const price1 = 100;
        await priceOracle.setPrice(price1);
        // the price initially is minimum, therefore minimum is charged
        expect(await postageStamp.totalOutPayment()).to.be.eq(minPriceString);

        const price2 = 200;
        await priceOracle.setPrice(price2);
        // price1 should be charged for the 1 block the prev line's tx mined
        // plus the initial 1 block at minimum
        const outPayment1 = parseInt(minPriceString) + price1;

        expect(await postageStamp.totalOutPayment()).to.be.eq(outPayment1);

        await mineNBlocks(2);

        const price3 = 300;
        await priceOracle.setPrice(price3);

        // price2 should be charged for 3 blocks (the 2 mined blocks and the new block setPrice is in)
        const outPayment2 = outPayment1 + 3 * price2
        expect(await postageStamp.totalOutPayment()).to.be.eq(outPayment2);
      });
    });

    describe('automatic update', function(){
      let minPriceString: string;
      let priceOracle: Contract, postageStamp: Contract;

      beforeEach(async function () {
        priceOracle = await ethers.getContract('PriceOracle', deployer);
        postageStamp = await ethers.getContract('PostageStamp')

        const updaterRole = await priceOracle.PRICE_UPDATER_ROLE();
        await priceOracle.grantRole(updaterRole, updater);

        //initialise, set minimum price
        const minimumPrice = await priceOracle.minimumPrice();
        minPriceString = minimumPrice.toString();
        await priceOracle.setPrice(minPriceString);
      });

      it('if redundany factor is 0', async function () {
        let priceOracleU = await ethers.getContract('PriceOracle', updater);
        await expect(priceOracleU.adjustPrice(0)).to.be.revertedWith(errors.auto.notZero);
      });

      it('if redundany factor is 1 twice', async function () {
        let priceOracleU = await ethers.getContract('PriceOracle', updater);

        const currentPrice = await priceOracle.currentPrice();
        expect(currentPrice).to.be.eq(minPriceString);
        expect(await postageStamp.lastPrice()).to.be.eq(minPriceString);

        await priceOracleU.adjustPrice(1);

        const newPrice1 = increaseRate[1] * parseInt(currentPrice) / parseInt(minPriceString);

        expect(await priceOracle.currentPrice()).to.be.eq(newPrice1);
        expect(await postageStamp.lastPrice()).to.be.eq(newPrice1);

        await priceOracleU.adjustPrice(1);

        const newPrice2 = Math.floor(increaseRate[1] * newPrice1 / parseInt(minPriceString));

        expect(await priceOracle.currentPrice()).to.be.eq(newPrice2);
        expect(await postageStamp.lastPrice()).to.be.eq(newPrice2);
      });

      it('if redundany factor modulates', async function () {
        let priceOracleU = await ethers.getContract('PriceOracle', updater);

        const currentPrice = await priceOracle.currentPrice();
        expect(currentPrice).to.be.eq(minPriceString);
        expect(await postageStamp.lastPrice()).to.be.eq(minPriceString);

        const r1 = 1;
        await priceOracleU.adjustPrice(r1);

        const newPrice1 = increaseRate[r1] * parseInt(currentPrice) / parseInt(minPriceString);

        expect(await priceOracle.currentPrice()).to.be.eq(newPrice1);
        expect(await postageStamp.lastPrice()).to.be.eq(newPrice1);

        const r2 = 2;
        await priceOracleU.adjustPrice(r2);

        const newPrice2 = Math.floor(increaseRate[r2] * newPrice1 / parseInt(minPriceString));

        expect(await priceOracle.currentPrice()).to.be.eq(newPrice2);
        expect(await postageStamp.lastPrice()).to.be.eq(newPrice2);

        const r3 = 2;
        await priceOracleU.adjustPrice(r3);

        const newPrice3 = Math.floor(increaseRate[r3] * newPrice2 / parseInt(minPriceString));

        expect(await priceOracle.currentPrice()).to.be.eq(newPrice3);
        expect(await postageStamp.lastPrice()).to.be.eq(newPrice3);

        const r4 = 2;
        await priceOracleU.adjustPrice(r4);

        const newPrice4 = Math.floor(increaseRate[r4] * newPrice3 / parseInt(minPriceString));

        expect(await priceOracle.currentPrice()).to.be.eq(newPrice4);
        expect(await postageStamp.lastPrice()).to.be.eq(newPrice4);
      });
    });
  });
});
