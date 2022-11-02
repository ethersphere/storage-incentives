import { expect } from './util/chai';
import { ethers, deployments, getNamedAccounts, getUnnamedAccounts } from 'hardhat';
import { Event, Contract } from 'ethers';
import { mineNBlocks, getBlockNumber } from './util/tools';

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

const increaseRate = [0, 1069, 1048, 1032, 1024, 1021, 1015, 1003, 980];

const errors = {
  manual: {
    notAdmin: 'caller is not the admin',
  },
  auto: {
    notZero: 'unexpected zero',
  },
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

    describe('manual update', function () {
      let minPriceString: string;
      let priceOracle: Contract, postageStamp: Contract;
      let initialPriceSetBlock: number;
      let price0SetBlock: number;

      beforeEach(async function () {
        priceOracle = await ethers.getContract('PriceOracle', deployer);
        postageStamp = await ethers.getContract('PostageStamp');

        const updaterRole = await priceOracle.PRICE_UPDATER_ROLE();
        await priceOracle.grantRole(updaterRole, updater);

        //initialise, set minimum price, todo: move to deployment
        const minimumPrice = await priceOracle.minimumPrice();
        minPriceString = minimumPrice.toString();
        await priceOracle.setPrice(minPriceString);
        price0SetBlock = await getBlockNumber();

        //since postage contract was deployed in block 0
        initialPriceSetBlock = await getBlockNumber();
      });

      it('is initialised', async function () {
        expect(await priceOracle.currentPrice()).to.be.eq(minPriceString);

        expect(await postageStamp.lastPrice()).to.be.eq(minPriceString);
      });

      it('cannot be updated manually by non admin', async function () {
        const currentPrice = await priceOracle.currentPrice();
        const newPrice = currentPrice + 1024;

        const priceOracleN = await ethers.getContract('PriceOracle', others[1]);
        await expect(priceOracleN.setPrice(newPrice)).to.be.revertedWith(errors.manual.notAdmin);

        const priceOracleU = await ethers.getContract('PriceOracle', updater);
        await expect(priceOracleN.setPrice(newPrice)).to.be.revertedWith(errors.manual.notAdmin);
      });

      it('can be updated manually by admin', async function () {
        const currentPrice = await priceOracle.currentPrice();
        const newPrice = currentPrice + 1024;

        await expect(priceOracle.setPrice(newPrice)).to.emit(priceOracle, 'PriceUpdate').withArgs(newPrice);
        expect(await priceOracle.currentPrice()).to.be.eq(newPrice);

        expect(await postageStamp.lastPrice()).to.be.eq(newPrice);
      });

      it('does not set price less than minimum price', async function () {
        const currentPrice = await priceOracle.currentPrice();
        const newPrice = 2048;
        await expect(priceOracle.setPrice(newPrice)).to.emit(priceOracle, 'PriceUpdate').withArgs(newPrice);

        const tooLowPrice = 100;

        await expect(priceOracle.setPrice(tooLowPrice)).to.emit(priceOracle, 'PriceUpdate').withArgs(minPriceString);

        expect(await priceOracle.currentPrice()).to.be.eq(minPriceString);
        expect(await postageStamp.lastPrice()).to.be.eq(minPriceString);
      });

      it('should update the outpayments', async function () {
        const price0 = parseInt(minPriceString);
        //price 0 was set during bootstrapping deploynent of the contract to be the minimum price
        const blocksElapsed0Price0 = (await getBlockNumber()) - initialPriceSetBlock;
        const outPayment0 = price0 * blocksElapsed0Price0;

        // elapsed total based on current block 18
        // i | price | set | elapsed | outPayment
        // --------------------------------------
        // 0 |  1024 |  14 |      14 |         0
        // --------------------------------------
        //                  total => |         0

        expect(await postageStamp.currentTotalOutPayment()).to.be.eq(outPayment0);

        const price1 = 1025;
        await priceOracle.setPrice(price1);
        const price1SetBlock = await getBlockNumber();

        await mineNBlocks(3);

        const blocksElapsed1Price0 = price1SetBlock - price0SetBlock;
        const blocksElapsed1Price1 = (await getBlockNumber()) - price1SetBlock;

        const outPayment1 = outPayment0 + price0 * blocksElapsed1Price0 + price1 * blocksElapsed1Price1;

        // elapsed total based on current block 18
        // |------------------------------------------------------|
        // | price | price set | block set | elapsed | outPayment |
        // |------------------------------------------------------|
        // |     0 |      1024 |        14 |      14 |         0  |
        // |  1024 |      1025 |        15 |       1 |      1024  |
        // |  1025 |           |           |       3 |      3075  |
        // |------------------------------------------------------|
        // |                                total => |      4099  |
        // |------------------------------------------------------|

        expect(await postageStamp.currentTotalOutPayment()).to.be.eq(outPayment1);

        await mineNBlocks(25);

        const price2 = 1026;
        await priceOracle.setPrice(price2);
        const price2SetBlock = await getBlockNumber();

        await mineNBlocks(52);

        const blocksElapsed2Price0 = price1SetBlock - price0SetBlock;
        const blocksElapsed2Price1 = price2SetBlock - price1SetBlock;
        const blocksElapsed2Price2 = (await getBlockNumber()) - price2SetBlock;

        const outPayment2 =
          price0 * blocksElapsed2Price0 + price1 * blocksElapsed2Price1 + price2 * blocksElapsed2Price2;

        // elapsed total based on current block 96
        // |------------------------------------------------------|
        // | price | price set | block set | elapsed | outPayment |
        // |------------------------------------------------------|
        // |     0 |      1024 |        14 |      14 |         0  |
        // |  1024 |      1025 |        15 |       1 |      1024  |
        // |  1025 |      1026 |        44 |      29 |     29725  |
        // |  1026 |           |           |      52 |     53352  |
        // |------------------------------------------------------|
        // |                                total => |     84101  |
        // |------------------------------------------------------|

        expect(await postageStamp.currentTotalOutPayment()).to.be.eq(outPayment2);
      });
    });

    describe('automatic update', function () {
      let minPriceString: string;
      let priceOracle: Contract, postageStamp: Contract;

      beforeEach(async function () {
        priceOracle = await ethers.getContract('PriceOracle', deployer);
        postageStamp = await ethers.getContract('PostageStamp');

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

        const newPrice1 = (increaseRate[1] * parseInt(currentPrice)) / parseInt(minPriceString);

        expect(await priceOracle.currentPrice()).to.be.eq(newPrice1);
        expect(await postageStamp.lastPrice()).to.be.eq(newPrice1);

        await priceOracleU.adjustPrice(1);

        const newPrice2 = Math.floor((increaseRate[1] * newPrice1) / parseInt(minPriceString));

        expect(await priceOracle.currentPrice()).to.be.eq(newPrice2);
        expect(await postageStamp.lastPrice()).to.be.eq(newPrice2);
      });

      it('if redundany factor modulates', async function () {
        let priceOracleU = await ethers.getContract('PriceOracle', updater);

        const currentPrice = await priceOracle.currentPrice();
        expect(currentPrice).to.be.eq(minPriceString);
        expect(await postageStamp.lastPrice()).to.be.eq(minPriceString);

        const redundancySignal1 = 1;
        const newPrice1 = (increaseRate[redundancySignal1] * parseInt(currentPrice)) / parseInt(minPriceString);

        await expect(priceOracleU.adjustPrice(redundancySignal1))
          .to.emit(priceOracle, 'PriceUpdate')
          .withArgs(newPrice1);

        expect(await priceOracle.currentPrice()).to.be.eq(newPrice1);
        expect(await postageStamp.lastPrice()).to.be.eq(newPrice1);

        const redundancySignal2 = 2;
        const newPrice2 = Math.floor((increaseRate[redundancySignal2] * newPrice1) / parseInt(minPriceString));
        await expect(priceOracleU.adjustPrice(redundancySignal2))
          .to.emit(priceOracle, 'PriceUpdate')
          .withArgs(newPrice2);

        expect(await priceOracle.currentPrice()).to.be.eq(newPrice2);
        expect(await postageStamp.lastPrice()).to.be.eq(newPrice2);

        const redundancySignal3 = 3;
        const newPrice3 = Math.floor((increaseRate[redundancySignal3] * newPrice2) / parseInt(minPriceString));
        await expect(priceOracleU.adjustPrice(redundancySignal3))
          .to.emit(priceOracle, 'PriceUpdate')
          .withArgs(newPrice3);

        expect(await priceOracle.currentPrice()).to.be.eq(newPrice3);
        expect(await postageStamp.lastPrice()).to.be.eq(newPrice3);

        const redundancySignal4 = 3;
        const newPrice4 = Math.floor((increaseRate[redundancySignal4] * newPrice3) / parseInt(minPriceString));
        await expect(priceOracleU.adjustPrice(redundancySignal4))
          .to.emit(priceOracle, 'PriceUpdate')
          .withArgs(newPrice4);

        expect(await priceOracle.currentPrice()).to.be.eq(newPrice4);
        expect(await postageStamp.lastPrice()).to.be.eq(newPrice4);
      });
    });
  });
});
