import { expect } from './util/chai';
import { ethers, deployments, getNamedAccounts, getUnnamedAccounts } from 'hardhat';
import { Contract } from 'ethers';
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

const changeRate = [1049417, 1049206, 1048996, 1048786, 1048576, 1048366, 1048156, 1047946, 1047736];
const roundLength = 152;

const errors = {
  manual: {
    notAdmin: 'CallerNotAdmin()',
  },
  auto: {
    notZero: 'UnexpectedZero()',
  },
};

describe('PriceOracle', function () {
  let minimumPrice: number;

  describe('when deploying contract', function () {
    beforeEach(async function () {
      await deployments.fixture();
      const priceOracle = await ethers.getContract('PriceOracle');
      minimumPrice = await priceOracle.minimumPrice();
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

    it('current price should be equal to minimum price', async function () {
      const priceOracle = await ethers.getContract('PriceOracle');
      const minimumPrice = await priceOracle.minimumPrice();
      const currentPrice = await priceOracle.currentPrice();
      expect(currentPrice).to.be.gte(minimumPrice);
    });
  });

  describe('with deployed contract', async function () {
    let minimumPrice: number;

    beforeEach(async function () {
      await deployments.fixture();
      const priceOracle = await ethers.getContract('PriceOracle');
      minimumPrice = await priceOracle.minimumPrice();
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

        // Initialise
        minPriceString = minimumPrice.toString();
        await priceOracle.setPrice(minPriceString);
        price0SetBlock = await getBlockNumber();

        // Set price base
        await priceOracle.priceBase();

        //since postage contract was deployed in block 0
        initialPriceSetBlock = await getBlockNumber();
      });

      it('is initialised', async function () {
        expect(await priceOracle.currentPrice()).to.be.eq(minimumPrice);

        expect(await postageStamp.lastPrice()).to.be.eq(minimumPrice);
      });

      it('cannot be updated manually by non admin', async function () {
        const currentPrice = await priceOracle.currentPrice();
        const newPrice = parseInt(currentPrice) + minimumPrice;

        const priceOracleN = await ethers.getContract('PriceOracle', others[0]);
        await expect(priceOracleN.setPrice(newPrice)).to.be.revertedWith(errors.manual.notAdmin);

        const priceOracleU = await ethers.getContract('PriceOracle', updater);
        await expect(priceOracleU.setPrice(newPrice)).to.be.revertedWith(errors.manual.notAdmin);
      });

      it('can be updated manually by admin', async function () {
        const currentPrice = await priceOracle.currentPrice();
        const newPrice = parseInt(currentPrice) + minimumPrice;

        await expect(priceOracle.setPrice(newPrice)).to.emit(priceOracle, 'PriceUpdate').withArgs(newPrice);
        expect(await priceOracle.currentPrice()).to.be.eq(newPrice);

        expect(await postageStamp.lastPrice()).to.be.eq(newPrice);
      });

      it('does not set price less than minimum price', async function () {
        const newPrice = minimumPrice + 1000;
        await expect(priceOracle.setPrice(newPrice)).to.emit(priceOracle, 'PriceUpdate').withArgs(newPrice);

        const tooLowPrice = 100;

        await expect(priceOracle.setPrice(tooLowPrice)).to.emit(priceOracle, 'PriceUpdate').withArgs(minPriceString);

        expect(await priceOracle.currentPrice()).to.be.eq(minimumPrice);
        expect(await postageStamp.lastPrice()).to.be.eq(minimumPrice);
      });

      it('should update the outpayments', async function () {
        const price0 = parseInt(minPriceString);
        //price 0 was set during bootstrapping deploynent of the contract to be the minimum price
        const blocksElapsed0Price0 = (await getBlockNumber()) - initialPriceSetBlock;
        const outPayment0 = price0 * blocksElapsed0Price0;

        expect(await postageStamp.currentTotalOutPayment()).to.be.eq(outPayment0);

        const price1 = minimumPrice + 1;
        await priceOracle.setPrice(price1);
        const price1SetBlock = await getBlockNumber();

        await mineNBlocks(3);

        const blocksElapsed1Price0 = price1SetBlock - price0SetBlock;
        const blocksElapsed1Price1 = (await getBlockNumber()) - price1SetBlock;

        const outPayment1 = outPayment0 + price0 * blocksElapsed1Price0 + price1 * blocksElapsed1Price1;

        expect(await postageStamp.currentTotalOutPayment()).to.be.eq(outPayment1);

        await mineNBlocks(25);

        const price2 = minimumPrice + 2;
        await priceOracle.setPrice(price2);
        const price2SetBlock = await getBlockNumber();

        await mineNBlocks(52);

        const blocksElapsed2Price0 = price1SetBlock - price0SetBlock;
        const blocksElapsed2Price1 = price2SetBlock - price1SetBlock;
        const blocksElapsed2Price2 = (await getBlockNumber()) - price2SetBlock;

        const outPayment2 =
          price0 * blocksElapsed2Price0 + price1 * blocksElapsed2Price1 + price2 * blocksElapsed2Price2;

        expect(await postageStamp.currentTotalOutPayment()).to.be.eq(outPayment2);
      });
    });

    describe('automatic update', function () {
      let minPriceString: string;
      let priceOracle: Contract, postageStamp: Contract;
      let priceBaseString: string;
      let priceBase: number;

      beforeEach(async function () {
        priceOracle = await ethers.getContract('PriceOracle', deployer);
        postageStamp = await ethers.getContract('PostageStamp');

        const updaterRole = await priceOracle.PRICE_UPDATER_ROLE();
        await priceOracle.grantRole(updaterRole, updater);

        //initialise, set minimum price
        minPriceString = minimumPrice.toString();
        await priceOracle.unPause(); // TODO: remove when price oracle is not paused by default.
        await priceOracle.setPrice(minPriceString);

        // Set price base
        priceBase = await priceOracle.priceBase();
        priceBaseString = priceBase.toString();
      });

      it('if redundany factor is 0', async function () {
        const priceOracleU = await ethers.getContract('PriceOracle', updater);
        await mineNBlocks(roundLength);
        await expect(priceOracleU.adjustPrice(0)).to.be.revertedWith(errors.auto.notZero);
      });

      it('if redundany factor is 1 twice', async function () {
        const priceOracleU = await ethers.getContract('PriceOracle', updater);

        const currentPrice = await priceOracle.currentPrice();
        expect(currentPrice).to.be.eq(minimumPrice);
        expect(await postageStamp.lastPrice()).to.be.eq(minimumPrice);

        await mineNBlocks(roundLength);

        await priceOracleU.adjustPrice(1);

        const newPrice1 = Math.floor((changeRate[1] * currentPrice) / priceBase);

        expect(await priceOracle.currentPrice()).to.be.eq(newPrice1);
        expect(await postageStamp.lastPrice()).to.be.eq(newPrice1);

        await mineNBlocks(roundLength);
        await priceOracleU.adjustPrice(1);
        const newPrice2 = Math.floor((changeRate[1] * newPrice1) / priceBase);

        expect(await priceOracle.currentPrice()).to.be.eq(newPrice2);
        expect(await postageStamp.lastPrice()).to.be.eq(newPrice2);
      });

      it('does not adjust price if paused', async function () {
        const priceOracleU = await ethers.getContract('PriceOracle', updater);
        const currentPrice = await priceOracle.currentPrice();
        expect(currentPrice).to.be.eq(minimumPrice);
        expect(await postageStamp.lastPrice()).to.be.eq(minimumPrice);

        await mineNBlocks(roundLength);

        await priceOracleU.adjustPrice(1);

        await priceOracle.pause();

        const newPrice1 = Math.floor((changeRate[1] * currentPrice) / priceBase);

        expect(await priceOracle.currentPrice()).to.be.eq(newPrice1);
        expect(await postageStamp.lastPrice()).to.be.eq(newPrice1);

        await priceOracleU.adjustPrice(1);

        expect(await priceOracle.currentPrice()).to.be.eq(newPrice1);
        expect(await postageStamp.lastPrice()).to.be.eq(newPrice1);
      });

      it('if redundany factor modulates', async function () {
        const priceOracleU = await ethers.getContract('PriceOracle', updater);

        const currentPrice = await priceOracle.currentPrice();
        expect(currentPrice).to.be.eq(minimumPrice);
        expect(await postageStamp.lastPrice()).to.be.eq(minimumPrice);

        // First
        await mineNBlocks(roundLength);
        const redundancySignal1 = 1;
        // we can start from minimum but after need to keep on upscale value
        let currentPriceUpscaled: number = currentPrice << 10;
        currentPriceUpscaled = Math.floor((changeRate[redundancySignal1] * currentPriceUpscaled) / priceBase);
        const newPrice1 = currentPriceUpscaled >> 10;

        await expect(priceOracleU.adjustPrice(redundancySignal1))
          .to.emit(priceOracle, 'PriceUpdate')
          .withArgs(newPrice1);

        expect(await priceOracle.currentPrice()).to.be.eq(newPrice1);
        expect(await postageStamp.lastPrice()).to.be.eq(newPrice1);

        // Second
        await mineNBlocks(roundLength);
        const redundancySignal2 = 2;

        currentPriceUpscaled = Math.floor((changeRate[redundancySignal2] * currentPriceUpscaled) / priceBase);
        const newPrice2 = currentPriceUpscaled >> 10;

        await expect(priceOracleU.adjustPrice(redundancySignal2))
          .to.emit(priceOracle, 'PriceUpdate')
          .withArgs(newPrice2);

        expect(await priceOracle.currentPrice()).to.be.eq(newPrice2);
        expect(await postageStamp.lastPrice()).to.be.eq(newPrice2);

        // Third
        await mineNBlocks(roundLength);
        const redundancySignal3 = 3;

        currentPriceUpscaled = Math.floor((changeRate[redundancySignal3] * currentPriceUpscaled) / priceBase);
        const newPrice3 = currentPriceUpscaled >> 10;

        await expect(priceOracleU.adjustPrice(redundancySignal3))
          .to.emit(priceOracle, 'PriceUpdate')
          .withArgs(newPrice3);

        expect(await priceOracle.currentPrice()).to.be.eq(newPrice3);
        expect(await postageStamp.lastPrice()).to.be.eq(newPrice3);

        // Fourth
        await mineNBlocks(roundLength);
        const redundancySignal4 = 4;

        currentPriceUpscaled = Math.floor((changeRate[redundancySignal4] * currentPriceUpscaled) / priceBase);
        const newPrice4 = currentPriceUpscaled >> 10;

        await expect(priceOracleU.adjustPrice(redundancySignal4))
          .to.emit(priceOracle, 'PriceUpdate')
          .withArgs(newPrice4);

        expect(await priceOracle.currentPrice()).to.be.eq(newPrice4);
        expect(await postageStamp.lastPrice()).to.be.eq(newPrice4);
      });
    });
  });
});
