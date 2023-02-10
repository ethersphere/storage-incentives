import { expect } from './util/chai';
import { ethers, deployments, getNamedAccounts, getUnnamedAccounts } from 'hardhat';
import { Contract } from 'ethers';
const { upgrades } = require("hardhat");
import { zeroAddress, mineNBlocks, computeBatchId, mintAndApprove, getBlockNumber } from './util/tools';

interface Batch {
  id?: string;
  nonce: string;
  initialPaymentPerChunk: number;
  depth: number;
  immutable: boolean;
  bucketDepth: number;
}

let stamper: string;
let deployer: string;
let oracle: string;
let others: string[];

before(async function () {
  const namedAccounts = await getNamedAccounts();
  deployer = namedAccounts.deployer;
  stamper = namedAccounts.stamper;
  oracle = namedAccounts.oracle;
  others = await getUnnamedAccounts();
});

async function setPrice(price: number) {
  return await (await ethers.getContract('PostageStamp', oracle)).setPrice(price);
}

const maxInt256 = 0xffff; //js can't handle the full maxInt256 value

const errors = {
  remainingBalance: {
    doesNotExist: 'batch does not exist or expired',
  },
  erc20: {
    exceedsBalance: 'ERC20: transfer amount exceeds balance',
  },
  createBatch: {
    invalidDepth: 'invalid bucket depth',
    alreadyExists: 'batch already exists',
    paused: 'Pausable: paused',
  },
  firstBatchId: {
    noneExist: 'no batches exist',
  },
};

describe('PostageStamp', function () {
  let postageStamp: any;
  describe('when deploying contract', function () {
    beforeEach(async function () {
      const { deployer, oracle, redistributor } = await getNamedAccounts();

      const Token = await ethers.getContractFactory('TestToken');
      const token = await Token.deploy();
      await token.deployed();

      const PostageStamp = await ethers.getContractFactory('PostageStamp');
      postageStamp = await upgrades.deployProxy(PostageStamp, [token.address, 16], {
        initializer: "initialize",
        kind: "uups",
      });

      await postageStamp.deployed();

      const priceOracleRole = await postageStamp.PRICE_ORACLE_ROLE();
      await postageStamp.grantRole(priceOracleRole, oracle);

      const redistributorRole = await postageStamp.REDISTRIBUTOR_ROLE();
      await postageStamp.grantRole(redistributorRole, redistributor);
    });

    it('should have minimum bucket depth set to 16', async function () {
      //   const postageStamp = await ethers.getContract('PostageStamp');
      expect(await postageStamp.minimumBucketDepth()).to.be.eq(16);
    });

    it('should deploy PostageStamp', async function () {
      const postageStamp = await ethers.getContract('PostageStamp');
      expect(postageStamp.address).to.be.properAddress;
    });

    it('should set the correct token', async function () {
      const postageStamp = await ethers.getContract('PostageStamp');
      const token = await ethers.getContract('TestToken');
      expect(await postageStamp.bzzToken()).to.be.eq(token.address);
    });

    it('should assign the admin role', async function () {
      const postageStamp = await ethers.getContract('PostageStamp');
      const adminRole = await postageStamp.DEFAULT_ADMIN_ROLE();
      expect(await postageStamp.hasRole(adminRole, deployer)).to.be.true;
    });

    it('should assign the pauser role', async function () {
      const postageStamp = await ethers.getContract('PostageStamp');
      const pauserRole = await postageStamp.PAUSER_ROLE();
      expect(await postageStamp.hasRole(pauserRole, deployer)).to.be.true;
    });
  });

  describe('with deployed contract', async function () {
    let postageStampStamper: Contract, token: Contract, priceOracle: Contract;
    let batch: Batch;
    let batchSize: number, transferAmount: number;
    const price0 = 1024;
    let setPrice0Block: number;

    beforeEach(async function () {
      await deployments.fixture();
    });

    describe('when creating a batch', function () {
      beforeEach(async function () {
        postageStampStamper = await ethers.getContract('PostageStamp', stamper);
        token = await ethers.getContract('TestToken', deployer);
        priceOracle = await ethers.getContract('PriceOracle', deployer);

        setPrice0Block = await getBlockNumber();
        await priceOracle.setPrice(price0);

        batch = {
          nonce: '0x000000000000000000000000000000000000000000000000000000000000abcd',
          initialPaymentPerChunk: price0 * 10, //good for ten blocks at minimum price
          depth: 17,
          immutable: false,
          bucketDepth: 16,
        };

        batchSize = 2 ** batch.depth;
        transferAmount = batch.initialPaymentPerChunk * batchSize;

        batch.id = computeBatchId(stamper, batch.nonce);

        await mintAndApprove(deployer, stamper, postageStampStamper.address, transferAmount.toString());
      });

      it('should fire the BatchCreated event', async function () {
        const blocksElapsed = (await getBlockNumber()) - setPrice0Block;
        const expectedNormalisedBalance = batch.initialPaymentPerChunk + blocksElapsed * price0;
        await expect(
          postageStampStamper.createBatch(
            stamper,
            batch.initialPaymentPerChunk,
            batch.depth,
            batch.bucketDepth,
            batch.nonce,
            batch.immutable
          )
        )
          .to.emit(postageStampStamper, 'BatchCreated')
          .withArgs(
            batch.id,
            transferAmount,
            expectedNormalisedBalance,
            stamper,
            batch.depth,
            batch.bucketDepth,
            batch.immutable
          );
      });

      it('should store the batch', async function () {
        const blocksElapsed = (await getBlockNumber()) - setPrice0Block;
        const expectedNormalisedBalance = batch.initialPaymentPerChunk + blocksElapsed * price0;
        await postageStampStamper.createBatch(
          stamper,
          batch.initialPaymentPerChunk,
          batch.depth,
          batch.bucketDepth,
          batch.nonce,
          batch.immutable
        );
        const stamp = await postageStampStamper.batches(batch.id);
        expect(stamp[0]).to.equal(stamper);
        expect(stamp[1]).to.equal(batch.depth);
        expect(stamp[2]).to.equal(batch.immutable);
        expect(stamp[3]).to.equal(expectedNormalisedBalance);
      });

      it('should report the correct remaining balance', async function () {
        await postageStampStamper.createBatch(
          stamper,
          batch.initialPaymentPerChunk,
          batch.depth,
          batch.bucketDepth,
          batch.nonce,
          batch.immutable
        );
        const buyStampBlock = await getBlockNumber();

        const normalisedBalance0 = parseInt(await postageStampStamper.remainingBalance(batch.id));
        const expectedNormalisedBalance0 =
          batch.initialPaymentPerChunk - ((await getBlockNumber()) - buyStampBlock) * price0;

        expect(normalisedBalance0).to.be.equal(expectedNormalisedBalance0);

        await mineNBlocks(1);

        const normalisedBalance1 = parseInt(await postageStampStamper.remainingBalance(batch.id));
        const expectedNormalisedBalance1 =
          batch.initialPaymentPerChunk - ((await getBlockNumber()) - buyStampBlock) * price0;

        expect(normalisedBalance1).to.be.equal(expectedNormalisedBalance1);
        await mineNBlocks(12);

        const expectedNormalisedBalance2 =
          batch.initialPaymentPerChunk - ((await getBlockNumber()) - buyStampBlock) * price0;
        const normalisedBalance2 = await postageStampStamper.remainingBalance(batch.id);

        expect(expectedNormalisedBalance2).to.be.lessThan(0);
        expect(normalisedBalance2).to.be.equal(0);

        await postageStampStamper.expireLimited(maxInt256);

        await expect(postageStampStamper.remainingBalance(batch.id)).to.be.revertedWith(
          errors.remainingBalance.doesNotExist
        );
      });

      it('should keep batches ordered by normalisedBalance', async function () {
        const initialPaymentPerChunk0 = 3300;
        const initialPaymentPerChunk1 = 1100;
        const initialPaymentPerChunk2 = 2200;

        const nonce0 = '0x0000000000000000000000000000000000000000000000000000000000001234';
        await postageStampStamper.createBatch(
          stamper,
          initialPaymentPerChunk0,
          batch.depth,
          batch.bucketDepth,
          nonce0,
          batch.immutable
        );
        const batch0 = computeBatchId(stamper, nonce0);
        expect(batch0).equal(await postageStampStamper.firstBatchId());

        const blocksElapsed = (await getBlockNumber()) - setPrice0Block;
        const expectedNormalisedBalance1 = initialPaymentPerChunk1 + blocksElapsed * price0;

        const nonce1 = '0x0000000000000000000000000000000000000000000000000000000000001235';
        await postageStampStamper.createBatch(
          stamper,
          initialPaymentPerChunk1,
          batch.depth,
          batch.bucketDepth,
          nonce1,
          batch.immutable
        );
        const batch1 = computeBatchId(stamper, nonce1);
        expect(batch1).equal(await postageStampStamper.firstBatchId());

        const nonce2 = '0x0000000000000000000000000000000000000000000000000000000000001236';
        await postageStampStamper.createBatch(
          stamper,
          initialPaymentPerChunk2,
          batch.depth,
          batch.bucketDepth,
          nonce2,
          batch.immutable
        );

        const batch2 = computeBatchId(stamper, nonce2);
        expect(batch1).equal(await postageStampStamper.firstBatchId());
        expect(batch2).not.equal(await postageStampStamper.firstBatchId());

        const stamp = await postageStampStamper.batches(batch1);
        expect(stamp[0]).to.equal(stamper);
        expect(stamp[1]).to.equal(batch.depth);
        expect(stamp[2]).to.equal(batch.immutable);
        expect(stamp[3]).to.equal(expectedNormalisedBalance1);
      });

      it('should transfer the token', async function () {
        await postageStampStamper.createBatch(
          stamper,
          batch.initialPaymentPerChunk,
          batch.depth,
          batch.bucketDepth,
          batch.nonce,
          batch.immutable
        );
        expect(await token.balanceOf(stamper)).to.equal(0);
        expect(await token.balanceOf(postageStampStamper.address)).to.equal(transferAmount);
      });

      it('should not create batch if insufficient funds', async function () {
        await expect(
          postageStampStamper.createBatch(
            stamper,
            batch.initialPaymentPerChunk + 1,
            batch.depth,
            batch.bucketDepth,
            batch.nonce,
            batch.immutable
          )
        ).to.be.revertedWith(errors.erc20.exceedsBalance);
      });

      it('should not allow zero as bucket depth', async function () {
        await expect(
          postageStampStamper.createBatch(
            stamper,
            batch.initialPaymentPerChunk,
            batch.depth,
            0,
            batch.nonce,
            batch.immutable
          )
        ).to.be.revertedWith(errors.createBatch.invalidDepth);
      });

      it('should not allow bucket depth larger than depth', async function () {
        await expect(
          postageStampStamper.createBatch(
            stamper,
            batch.initialPaymentPerChunk,
            batch.depth,
            batch.depth + 1,
            batch.nonce,
            batch.immutable
          )
        ).to.be.revertedWith(errors.createBatch.invalidDepth);
      });

      it('should not allow bucket depth equal to depth', async function () {
        await expect(
          postageStampStamper.createBatch(
            stamper,
            batch.initialPaymentPerChunk,
            batch.depth,
            batch.depth,
            batch.nonce,
            batch.immutable
          )
        ).to.be.revertedWith(errors.createBatch.invalidDepth);
      });

      it('should not allow duplicate batch', async function () {
        await postageStampStamper.createBatch(
          stamper,
          batch.initialPaymentPerChunk,
          batch.depth,
          batch.bucketDepth,
          batch.nonce,
          batch.immutable
        );
        await expect(
          postageStampStamper.createBatch(
            stamper,
            batch.initialPaymentPerChunk,
            batch.depth,
            batch.bucketDepth,
            batch.nonce,
            batch.immutable
          )
        ).to.be.revertedWith(errors.createBatch.alreadyExists);
      });

      it('should correctly return if batches are empty', async function () {
        const initialPaymentPerChunk0 = 2048;
        const blocksElapsed = (await getBlockNumber()) - setPrice0Block;
        const expectedNormalisedBalance = initialPaymentPerChunk0 + blocksElapsed * price0;

        await postageStampStamper.createBatch(
          stamper,
          initialPaymentPerChunk0,
          batch.depth,
          batch.bucketDepth,
          batch.nonce,
          batch.immutable
        );

        const stamp = await postageStampStamper.batches(batch.id);
        expect(stamp[0]).to.equal(stamper);
        expect(stamp[1]).to.equal(batch.depth);
        expect(stamp[2]).to.equal(batch.immutable);
        expect(stamp[3]).to.equal(expectedNormalisedBalance);
        expect(await postageStampStamper.empty()).equal(false);

        mineNBlocks(10);
        await postageStampStamper.expireLimited(maxInt256);

        expect(await postageStampStamper.empty()).equal(true);
      });

      it('should not allow batch creation when paused', async function () {
        const postageStamp = await ethers.getContract('PostageStamp', deployer);
        await postageStamp.pause();
        await expect(
          postageStamp.createBatch(stamper, 0, batch.depth, batch.bucketDepth, batch.nonce, batch.immutable)
        ).to.be.revertedWith(errors.createBatch.paused);
      });

      it('should allow batch creation when unpaused', async function () {
        const postage_p = await ethers.getContract('PostageStamp', deployer);
        await postage_p.pause();
        await expect(
          postageStampStamper.createBatch(
            stamper,
            batch.initialPaymentPerChunk,
            batch.depth,
            batch.bucketDepth,
            batch.nonce,
            batch.immutable
          )
        ).to.be.revertedWith(errors.createBatch.paused);
        await postage_p.unPause();

        const blocksElapsed = (await getBlockNumber()) - setPrice0Block;
        const expectedNormalisedBalance = batch.initialPaymentPerChunk + blocksElapsed * price0;
        await postageStampStamper.createBatch(
          stamper,
          batch.initialPaymentPerChunk,
          batch.depth,
          batch.bucketDepth,
          batch.nonce,
          batch.immutable
        );

        const stamp = await postageStampStamper.batches(batch.id);
        expect(stamp[0]).to.equal(stamper);
        expect(stamp[1]).to.equal(batch.depth);
        expect(stamp[2]).to.equal(batch.immutable);
        expect(stamp[3]).to.equal(expectedNormalisedBalance);
      });

      it('should delete expired batches', async function () {
        const initialPaymentPerChunk0 = price0 * 8;
        const initialPaymentPerChunk1 = price0 * 4;
        const initialPaymentPerChunk2 = price0 * 16;

        const transferAmount0 = initialPaymentPerChunk0 * 2 ** batch.depth;
        await mintAndApprove(deployer, stamper, postageStampStamper.address, transferAmount0.toString());

        const nonce0 = '0x0000000000000000000000000000000000000000000000000000000000001234';
        await postageStampStamper.createBatch(
          stamper,
          initialPaymentPerChunk0,
          batch.depth,
          batch.bucketDepth,
          nonce0,
          batch.immutable
        );

        const batch0 = computeBatchId(stamper, nonce0);
        expect(await postageStampStamper.firstBatchId()).to.equal(batch0);

        const transferAmount1 = initialPaymentPerChunk1 * 2 ** batch.depth;
        await mintAndApprove(deployer, stamper, postageStampStamper.address, transferAmount1.toString());

        const nonce1 = '0x0000000000000000000000000000000000000000000000000000000000001235';
        await postageStampStamper.createBatch(
          stamper,
          initialPaymentPerChunk1,
          batch.depth,
          batch.bucketDepth,
          nonce1,
          batch.immutable
        );

        const batch1 = computeBatchId(stamper, nonce1);
        expect(await postageStampStamper.firstBatchId()).to.equal(batch1);

        const transferAmount2 = initialPaymentPerChunk2 * 2 ** batch.depth;
        await mintAndApprove(deployer, stamper, postageStampStamper.address, transferAmount2.toString());

        const nonce2 = '0x0000000000000000000000000000000000000000000000000000000000001236';
        await postageStampStamper.createBatch(
          stamper,
          initialPaymentPerChunk2,
          batch.depth,
          batch.bucketDepth,
          nonce2,
          batch.immutable
        );

        const batch2 = computeBatchId(stamper, nonce2);
        expect(await postageStampStamper.firstBatchId()).to.equal(batch1);
        expect(await postageStampStamper.firstBatchId()).not.to.equal(batch2);

        await mineNBlocks(1);

        expect(await postageStampStamper.firstBatchId()).to.equal(batch1);
        expect(await postageStampStamper.firstBatchId()).not.to.equal(batch2);

        await postageStampStamper.expireLimited(maxInt256);

        expect(batch0).not.equal(await postageStampStamper.firstBatchId());
        expect(batch1).not.equal(await postageStampStamper.firstBatchId());
        expect(batch2).equal(await postageStampStamper.firstBatchId());
      });

      it('should calculate the correct remaining balances and update the pot', async function () {
        const blocksBeforeExpired0 = 8;
        const initialPaymentPerChunk0 = price0 * blocksBeforeExpired0;

        const blocksBeforeExpired1 = 4;
        const initialPaymentPerChunk1 = price0 * blocksBeforeExpired1;

        const blocksBeforeExpired2 = 16;
        const initialPaymentPerChunk2 = price0 * blocksBeforeExpired2;

        const transferAmount0 = initialPaymentPerChunk0 * 2 ** batch.depth;
        await mintAndApprove(deployer, stamper, postageStampStamper.address, transferAmount0.toString());

        const nonce0 = '0x0000000000000000000000000000000000000000000000000000000000001234';
        await postageStampStamper.createBatch(
          stamper,
          initialPaymentPerChunk0,
          batch.depth,
          batch.bucketDepth,
          nonce0,
          batch.immutable
        );

        const buyStamp0Block = await getBlockNumber();

        expect(await postageStampStamper.pot()).equal(0);

        await postageStampStamper.expireLimited(maxInt256);

        const blocksElapsed0Stamp0 = (await getBlockNumber()) - buyStamp0Block;

        const blocksCharged0Stamp0 =
          blocksBeforeExpired0 - blocksElapsed0Stamp0 < 0 ? blocksBeforeExpired0 : blocksElapsed0Stamp0;
        const outpayment0Stamp0 = price0 * blocksCharged0Stamp0 * 2 ** batch.depth;

        expect(await postageStampStamper.pot()).equal(outpayment0Stamp0);

        const transferAmount1 = initialPaymentPerChunk1 * 2 ** batch.depth;
        await mintAndApprove(deployer, stamper, postageStampStamper.address, transferAmount1.toString());

        const nonce1 = '0x0000000000000000000000000000000000000000000000000000000000001235';
        await postageStampStamper.createBatch(
          stamper,
          initialPaymentPerChunk1,
          batch.depth,
          batch.bucketDepth,
          nonce1,
          batch.immutable
        );

        const buyStamp1Block = await getBlockNumber();

        await postageStampStamper.expireLimited(maxInt256);

        const blocksElapsed1Stamp0 = (await getBlockNumber()) - buyStamp0Block;

        const blocksCharged1Stamp0 =
          blocksBeforeExpired0 - blocksElapsed1Stamp0 < 0 ? blocksBeforeExpired0 : blocksElapsed1Stamp0;

        const outpayment1Stamp0 = price0 * blocksCharged1Stamp0 * 2 ** batch.depth;

        const blocksElapsed1Stamp1 = (await getBlockNumber()) - buyStamp1Block;

        const blocksCharged1Stamp1 =
          blocksBeforeExpired1 - blocksElapsed1Stamp1 < 0 ? blocksBeforeExpired1 : blocksElapsed1Stamp1;

        const outpayment1Stamp1 = price0 * blocksCharged1Stamp1 * 2 ** batch.depth;

        const expectedPot1 = outpayment1Stamp0 + outpayment1Stamp1;

        expect(await postageStampStamper.pot()).equal(expectedPot1);

        const transferAmount2 = initialPaymentPerChunk2 * 2 ** batch.depth;
        await mintAndApprove(deployer, stamper, postageStampStamper.address, transferAmount2.toString());

        const nonce2 = '0x0000000000000000000000000000000000000000000000000000000000001236';
        await postageStampStamper.createBatch(
          stamper,
          initialPaymentPerChunk2,
          batch.depth,
          batch.bucketDepth,
          nonce2,
          batch.immutable
        );

        const buyStamp2Block = await getBlockNumber();

        await postageStampStamper.expireLimited(maxInt256);

        const blocksElapsed2Stamp0 = (await getBlockNumber()) - buyStamp0Block;
        const blocksCharged2Stamp0 =
          blocksBeforeExpired0 - blocksElapsed2Stamp0 < 0 ? blocksBeforeExpired0 : blocksElapsed2Stamp0;
        const outpayment2Stamp0 = price0 * blocksCharged2Stamp0 * 2 ** batch.depth;

        const blocksElapsed2Stamp1 = (await getBlockNumber()) - buyStamp1Block;
        const blocksCharged2Stamp1 =
          blocksBeforeExpired1 - blocksElapsed2Stamp1 < 0 ? blocksBeforeExpired1 : blocksElapsed2Stamp1;
        const outpayment2Stamp1 = price0 * blocksCharged2Stamp1 * 2 ** batch.depth;

        const blocksElapsed2Stamp2 = (await getBlockNumber()) - buyStamp2Block;
        const blocksCharged2Stamp2 =
          blocksBeforeExpired2 - blocksElapsed2Stamp2 < 0 ? blocksBeforeExpired2 : blocksElapsed2Stamp2;
        const outpayment2Stamp2 = price0 * blocksCharged2Stamp2 * 2 ** batch.depth;

        const expectedPot2 = outpayment2Stamp0 + outpayment2Stamp1 + outpayment2Stamp2;

        expect(await postageStampStamper.pot()).equal(expectedPot2);

        await mineNBlocks(1);

        await postageStampStamper.expireLimited(maxInt256);

        const blocksElapsed3Stamp0 = (await getBlockNumber()) - buyStamp0Block;
        const blocksCharged3Stamp0 =
          blocksBeforeExpired0 - blocksElapsed3Stamp0 < 0 ? blocksBeforeExpired0 : blocksElapsed3Stamp0;
        const outpayment3Stamp0 = price0 * blocksCharged3Stamp0 * 2 ** batch.depth;

        const blocksElapsed3Stamp1 = (await getBlockNumber()) - buyStamp1Block;
        const blocksCharged3Stamp1 =
          blocksBeforeExpired1 - blocksElapsed3Stamp1 < 0 ? blocksBeforeExpired1 : blocksElapsed3Stamp1;
        const outpayment3Stamp1 = price0 * blocksCharged3Stamp1 * 2 ** batch.depth;

        const blocksElapsed3Stamp2 = (await getBlockNumber()) - buyStamp2Block;
        const blocksCharged3Stamp2 =
          blocksBeforeExpired2 - blocksElapsed3Stamp2 < 0 ? blocksBeforeExpired2 : blocksElapsed3Stamp2;
        const outpayment3Stamp2 = price0 * blocksCharged3Stamp2 * 2 ** batch.depth;

        const expectedPot3 = outpayment3Stamp0 + outpayment3Stamp1 + outpayment3Stamp2;

        expect(await postageStampStamper.pot()).equal(expectedPot3);
      });
    });

    describe('when topping up a batch', function () {
      let postageStamp: Contract, token: Contract, priceOracle: Contract;
      let batch: Batch;
      let batchSize: number, transferAmount: number;
      const price0 = 1024;
      let setPrice0Block: number, buyStampBlock: number;
      const initialBatchBlocks = 10;
      const topupAmountPerChunk = 1024;

      beforeEach(async function () {
        postageStamp = await ethers.getContract('PostageStamp', stamper);
        token = await ethers.getContract('TestToken', deployer);
        priceOracle = await ethers.getContract('PriceOracle', deployer);

        setPrice0Block = await getBlockNumber();
        await priceOracle.setPrice(price0);

        batch = {
          nonce: '0x000000000000000000000000000000000000000000000000000000000000abce',
          initialPaymentPerChunk: price0 * initialBatchBlocks,
          depth: 17,
          immutable: false,
          bucketDepth: 16,
        };

        batchSize = 2 ** batch.depth;
        transferAmount = batch.initialPaymentPerChunk * batchSize;
        transferAmount += topupAmountPerChunk * batchSize;

        batch.id = computeBatchId(stamper, batch.nonce);

        await mintAndApprove(deployer, stamper, postageStamp.address, transferAmount.toString());

        buyStampBlock = await getBlockNumber();
        await postageStamp.createBatch(
          stamper,
          batch.initialPaymentPerChunk,
          batch.depth,
          batch.bucketDepth,
          batch.nonce,
          batch.immutable
        );
      });

      it('should fire the BatchTopUp event', async function () {
        const expectedNormalisedBalance =
          price0 * (buyStampBlock - setPrice0Block) + price0 * initialBatchBlocks + topupAmountPerChunk;
        await expect(postageStamp.topUp(batch.id, topupAmountPerChunk))
          .to.emit(postageStamp, 'BatchTopUp')
          .withArgs(batch.id, topupAmountPerChunk * batchSize, expectedNormalisedBalance);
      });

      it('should update the normalised balance', async function () {
        const expectedNormalisedBalance =
          price0 * (buyStampBlock - setPrice0Block) + price0 * initialBatchBlocks + topupAmountPerChunk;
        await postageStamp.topUp(batch.id, topupAmountPerChunk);
        const stamp = await postageStamp.batches(batch.id);
        expect(stamp.normalisedBalance).to.equal(expectedNormalisedBalance);
      });

      it('should transfer the token', async function () {
        await postageStamp.topUp(batch.id, topupAmountPerChunk);
        expect(await token.balanceOf(stamper)).to.equal(0);
        expect(await token.balanceOf(postageStamp.address)).to.equal(
          (batch.initialPaymentPerChunk + topupAmountPerChunk) * batchSize
        );
      });

      it('should not top up non-existing batches', async function () {
        const nonExistingBatchId = computeBatchId(deployer, batch.nonce);
        await expect(postageStamp.topUp(nonExistingBatchId, topupAmountPerChunk)).to.be.revertedWith(
          'batch does not exist'
        );
      });

      it('should not top up with insufficient funds', async function () {
        await expect(postageStamp.topUp(batch.id, topupAmountPerChunk + 1)).to.be.revertedWith(
          'ERC20: transfer amount exceeds balance'
        );
      });

      it('should not top up expired batches', async function () {
        await mineNBlocks(initialBatchBlocks + 10);
        await expect(postageStamp.topUp(batch.id, topupAmountPerChunk)).to.be.revertedWith('batch already expired');
      });

      it('should not top up when paused', async function () {
        const postageStamp = await ethers.getContract('PostageStamp', deployer);
        await postageStamp.pause();
        await expect(postageStamp.topUp(batch.id, topupAmountPerChunk)).to.be.revertedWith('Pausable: paused');
      });

      it('should keep batches ordered by normalisedBalance', async function () {
        const batch2Blocks = 20;
        const batch2 = {
          nonce: '0x000000000000000000000000000000000000000000000000000000000000abc1',
          initialPaymentPerChunk: price0 * batch2Blocks,
          depth: 17,
          immutable: false,
          bucketDepth: 16,
        };
        const batch2TransferAmount = price0 * batch2Blocks * 2 ** batch2.depth;

        await mintAndApprove(deployer, stamper, postageStamp.address, batch2TransferAmount.toString());

        await postageStamp.createBatch(
          stamper,
          batch2.initialPaymentPerChunk,
          batch2.depth,
          batch2.bucketDepth,
          batch2.nonce,
          batch2.immutable
        );

        const batch2Id = computeBatchId(stamper, batch2.nonce);

        expect(await postageStamp.firstBatchId()).equal(batch.id);

        const batch0TopUpBlocks = 40;
        const topUpAmountBatch0 = price0 * batch0TopUpBlocks;
        const batch2TopUpTransferAmount = price0 * topUpAmountBatch0 * 2 ** batch2.depth;

        await mintAndApprove(deployer, stamper, postageStamp.address, batch2TopUpTransferAmount.toString());

        await postageStamp.topUp(batch.id, topUpAmountBatch0);

        expect(await postageStamp.firstBatchId()).equal(batch2Id);
      });
    });

    describe('when increasing the depth', function () {
      let postageStamp: Contract, priceOracle: Contract;
      let batch: Batch;
      let batchSize: number, transferAmount: number;
      const price0 = 1024;
      let setPrice0Block: number, buyStampBlock: number;
      const initialBatchBlocks = 100;
      const newDepth = 18;
      let depthChange: number;

      beforeEach(async function () {
        postageStamp = await ethers.getContract('PostageStamp', stamper);
        priceOracle = await ethers.getContract('PriceOracle', deployer);

        setPrice0Block = await getBlockNumber();
        await priceOracle.setPrice(price0);

        batch = {
          nonce: '0x000000000000000000000000000000000000000000000000000000000000abce',
          initialPaymentPerChunk: price0 * initialBatchBlocks,
          depth: 17,
          immutable: false,
          bucketDepth: 16,
        };

        depthChange = newDepth - batch.depth;

        batchSize = 2 ** batch.depth;
        transferAmount = batch.initialPaymentPerChunk * batchSize;

        batch.id = computeBatchId(stamper, batch.nonce);

        await mintAndApprove(deployer, stamper, postageStamp.address, transferAmount.toString());

        buyStampBlock = await getBlockNumber();
        await postageStamp.createBatch(
          stamper,
          batch.initialPaymentPerChunk,
          batch.depth,
          batch.bucketDepth,
          batch.nonce,
          batch.immutable
        );
      });

      it('should fire the BatchDepthIncrease event', async function () {
        const depthChange = newDepth - batch.depth;
        // the expected normalised balance should be changed - the total amount remaining should be multiplied by the new batch size over the old batch size
        // so the total expected normalised balance should be the normalised balance up to that point, plus the future normalised balance adjusted by this factor
        const expectedNormalisedBalance = batch.initialPaymentPerChunk + (buyStampBlock - setPrice0Block) * price0;

        const stamp = await postageStamp.batches(batch.id);
        expect(stamp.normalisedBalance.toString()).to.be.equal(expectedNormalisedBalance.toString());

        const remainingBalanceNextBlock = parseInt(await postageStamp.remainingBalance(batch.id)) - price0 * 1;
        const currentTotalOutPaymentNextBlock = parseInt(await postageStamp.currentTotalOutPayment()) + price0 * 1;
        const expectedNormalisedBalanceAfter =
          currentTotalOutPaymentNextBlock + remainingBalanceNextBlock / 2 ** depthChange;

        await expect(postageStamp.increaseDepth(batch.id, newDepth))
          .to.emit(postageStamp, 'BatchDepthIncrease')
          .withArgs(batch.id, newDepth, expectedNormalisedBalanceAfter.toString());
      });

      it('should update the stamp data', async function () {
        const depthChange = newDepth - batch.depth;
        const remainingBalanceNextBlock = parseInt(await postageStamp.remainingBalance(batch.id)) - price0 * 1;
        const currentTotalOutPaymentNextBlock = parseInt(await postageStamp.currentTotalOutPayment()) + price0 * 1;
        const expectedNormalisedBalanceAfter =
          currentTotalOutPaymentNextBlock + remainingBalanceNextBlock / 2 ** depthChange;

        await postageStamp.increaseDepth(batch.id, newDepth);
        const stamp = await postageStamp.batches(batch.id);
        expect(stamp.owner).to.equal(stamper);
        expect(stamp.depth).to.equal(newDepth);
        expect(stamp.immutableFlag).to.equal(batch.immutable);
        expect(stamp.normalisedBalance).to.equal(expectedNormalisedBalanceAfter);
      });

      it('should not allow other accounts to increase depth', async function () {
        const postageStamp = await ethers.getContract('PostageStamp', others[0]);
        await expect(postageStamp.increaseDepth(batch.id, newDepth)).to.be.revertedWith('not batch owner');
      });

      it('should not allow decreasing the depth', async function () {
        await expect(postageStamp.increaseDepth(batch.id, batch.depth - 1)).to.be.revertedWith('depth not increasing');
      });

      it('should not allow the same depth', async function () {
        await expect(postageStamp.increaseDepth(batch.id, batch.depth)).to.be.revertedWith('depth not increasing');
      });

      it('should not increase depth of expired batches', async function () {
        // one price applied so far, this ensures the currentTotalOutpayment will be exactly the batch value when increaseDepth is called
        await mineNBlocks(100);
        await expect(postageStamp.increaseDepth(batch.id, newDepth)).to.be.revertedWith('batch already expired');
      });

      it('should not increase depth when paused', async function () {
        const postageStamp = await ethers.getContract('PostageStamp', deployer);
        await postageStamp.pause();
        await expect(postageStamp.increaseDepth(batch.id, newDepth)).to.be.revertedWith('Pausable: paused');
      });

      it('should compute correct balance if outpayments changed since creation', async function () {
        const newPrice = 2048;
        await priceOracle.setPrice(newPrice);

        const remainingBalanceNextBlock = parseInt(await postageStamp.remainingBalance(batch.id)) - newPrice * 1;
        const currentTotalOutPaymentNextBlock = parseInt(await postageStamp.currentTotalOutPayment()) + newPrice * 1;
        const expectedNormalisedBalanceAfter =
          currentTotalOutPaymentNextBlock + remainingBalanceNextBlock / 2 ** depthChange;

        await expect(postageStamp.increaseDepth(batch.id, newDepth))
          .to.emit(postageStamp, 'BatchDepthIncrease')
          .withArgs(batch.id, newDepth, expectedNormalisedBalanceAfter);
      });

      it('should keep batches ordered by normalisedBalance', async function () {
        const batch2NewDepth = 20;
        const batch2Blocks = 200;
        const batch2 = {
          nonce: '0x000000000000000000000000000000000000000000000000000000000000abc1',
          initialPaymentPerChunk: price0 * batch2Blocks,
          depth: 17,
          immutable: false,
          bucketDepth: 16,
        };
        const batch2TransferAmount = price0 * batch2Blocks * 2 ** batch2.depth;

        await mintAndApprove(deployer, stamper, postageStamp.address, batch2TransferAmount.toString());

        await postageStamp.createBatch(
          stamper,
          batch2.initialPaymentPerChunk,
          batch2.depth,
          batch2.bucketDepth,
          batch2.nonce,
          batch2.immutable
        );

        const batch2Id = computeBatchId(stamper, batch2.nonce);

        expect(await postageStamp.firstBatchId()).equal(batch.id);

        await postageStamp.increaseDepth(batch2Id, batch2NewDepth);

        expect(await postageStamp.firstBatchId()).equal(batch2Id);
      });

      it('should delete expired batches', async function () {
        const batch2NewDepth = 24;
        const batch2NewDepth2 = 36;
        const batch2Blocks = 200;
        const batch2 = {
          nonce: '0x000000000000000000000000000000000000000000000000000000000000abc1',
          initialPaymentPerChunk: price0 * batch2Blocks,
          depth: 17,
          immutable: false,
          bucketDepth: 16,
        };
        const batch2TransferAmount = price0 * batch2Blocks * 2 ** batch2.depth;

        await mintAndApprove(deployer, stamper, postageStamp.address, batch2TransferAmount.toString());

        await postageStamp.createBatch(
          stamper,
          batch2.initialPaymentPerChunk,
          batch2.depth,
          batch2.bucketDepth,
          batch2.nonce,
          batch2.immutable
        );

        const batch2Id = computeBatchId(stamper, batch2.nonce);

        expect(await postageStamp.firstBatchId()).equal(batch.id);

        await postageStamp.increaseDepth(batch2Id, batch2NewDepth);

        expect(await postageStamp.firstBatchId()).equal(batch2Id);

        await postageStamp.increaseDepth(batch2Id, batch2NewDepth2);

        await postageStamp.expireLimited(maxInt256);

        expect(await postageStamp.firstBatchId()).equal(batch.id);
      });
    });

    describe('when setting the price', function () {
      it('should increase the outpayment if called by oracle', async function () {
        const postageStamp_o = await ethers.getContract('PostageStamp', oracle);

        const price1 = 2048;
        await postageStamp_o.setPrice(price1);

        await mineNBlocks(1);
        expect(await postageStamp_o.currentTotalOutPayment()).to.be.eq(price1);

        await mineNBlocks(1);
        expect(await postageStamp_o.currentTotalOutPayment()).to.be.eq(2 * price1);

        const price2 = 4096;
        await postageStamp_o.setPrice(price2);
        expect(await postageStamp_o.currentTotalOutPayment()).to.be.eq(3 * price1);

        await mineNBlocks(1);
        expect(await postageStamp_o.currentTotalOutPayment()).to.be.eq(3 * price1 + 1 * price2);

        await mineNBlocks(1);
        expect(await postageStamp_o.currentTotalOutPayment()).to.be.eq(3 * price1 + 2 * price2);
      });

      it('should emit event if called by oracle', async function () {
        const postageStamp = await ethers.getContract('PostageStamp', oracle);
        const price = 2048;
        await expect(postageStamp.setPrice(price)).to.emit(postageStamp, 'PriceUpdate').withArgs(price);
      });

      it('should revert if not called by oracle', async function () {
        const postageStamp = await ethers.getContract('PostageStamp', deployer);
        await expect(postageStamp.setPrice(100)).to.be.revertedWith('only price oracle can set the price');
      });
    });

    describe('when pausing', function () {
      it('should not allow anybody but the pauser to pause', async function () {
        const postageStamp = await ethers.getContract('PostageStamp', stamper);
        await expect(postageStamp.pause()).to.be.revertedWith('only pauser can pause');
      });
    });

    describe('when unpausing', function () {
      it('should unpause when pause and then unpause', async function () {
        const postageStamp = await ethers.getContract('PostageStamp', deployer);
        await postageStamp.pause();
        await postageStamp.unPause();
        expect(await postageStamp.paused()).to.be.false;
      });

      it('should not allow anybody but the pauser to unpause', async function () {
        const postageStamp = await ethers.getContract('PostageStamp', deployer);
        await postageStamp.pause();
        const postageStamp2 = await ethers.getContract('PostageStamp', stamper);
        await expect(postageStamp2.unPause()).to.be.revertedWith('only pauser can unpause');
      });

      it('should not allow unpausing when not paused', async function () {
        const postageStamp = await ethers.getContract('PostageStamp', deployer);
        await expect(postageStamp.unPause()).to.be.revertedWith('Pausable: not paused');
      });
    });

    describe('when getting remaining balance', function () {
      it('should revert if the batch does not exist', async function () {
        const postageStamp = await ethers.getContract('PostageStamp', deployer);
        await expect(
          postageStamp.remainingBalance('0x000000000000000000000000000000000000000000000000000000000000abcd')
        ).to.be.revertedWith('batch does not exist');
      });
    });

    describe('expiring batches', function () {
      let postageStamp: Contract, priceOracle: Contract;
      let batch0: Batch;
      let batch1: Batch;
      let batch2: Batch;
      let batch0Size: number, transferAmount0: number;
      let batch1Size: number, transferAmount1: number;
      let batch2Size: number, transferAmount2: number;
      const price0 = 1024;
      const initialBatch0Blocks = 10;
      const initialBatch1Blocks = 10;
      const initialBatch2Blocks = 200;
      let batch1Id: string, batch2Id: string;

      beforeEach(async function () {
        postageStamp = await ethers.getContract('PostageStamp', stamper);
        priceOracle = await ethers.getContract('PriceOracle', deployer);

        await priceOracle.setPrice(price0);

        batch0 = {
          nonce: '0x000000000000000000000000000000000000000000000000000000000000abce',
          initialPaymentPerChunk: price0 * initialBatch0Blocks,
          depth: 17,
          immutable: false,
          bucketDepth: 16,
        };

        batch0Size = 2 ** batch0.depth;
        transferAmount0 = batch0.initialPaymentPerChunk * batch0Size;

        await mintAndApprove(deployer, stamper, postageStamp.address, transferAmount0.toString());

        await postageStamp.createBatch(
          stamper,
          batch0.initialPaymentPerChunk,
          batch0.depth,
          batch0.bucketDepth,
          batch0.nonce,
          batch0.immutable
        );

        batch1 = {
          nonce: '0x000000000000000000000000000000000000000000000000000000000000abcf',
          initialPaymentPerChunk: price0 * initialBatch1Blocks,
          depth: 17,
          immutable: false,
          bucketDepth: 16,
        };

        batch1Size = 2 ** batch1.depth;
        transferAmount1 = batch1.initialPaymentPerChunk * batch1Size;

        batch1Id = computeBatchId(stamper, batch1.nonce);

        await mintAndApprove(deployer, stamper, postageStamp.address, transferAmount1.toString());

        await postageStamp.createBatch(
          stamper,
          batch1.initialPaymentPerChunk,
          batch1.depth,
          batch1.bucketDepth,
          batch1.nonce,
          batch1.immutable
        );

        batch2 = {
          nonce: '0x000000000000000000000000000000000000000000000000000000000000abc1',
          initialPaymentPerChunk: price0 * initialBatch2Blocks,
          depth: 17,
          immutable: false,
          bucketDepth: 16,
        };

        batch2Size = 2 ** batch2.depth;
        transferAmount2 = batch2.initialPaymentPerChunk * batch2Size;

        batch2Id = computeBatchId(stamper, batch2.nonce);

        await mintAndApprove(deployer, stamper, postageStamp.address, transferAmount2.toString());

        await postageStamp.createBatch(
          stamper,
          batch2.initialPaymentPerChunk,
          batch2.depth,
          batch2.bucketDepth,
          batch2.nonce,
          batch2.immutable
        );
      });

      it('expire should update the pot and delete expired batches', async function () {
        await mineNBlocks(20);

        expect(await postageStamp.expiredBatchesExist()).equal(true);

        await postageStamp.expireLimited(maxInt256);

        expect(await postageStamp.expiredBatchesExist()).equal(false);

        expect(await postageStamp.firstBatchId()).to.be.equal(batch2Id);

        await postageStamp.expireLimited(maxInt256);

        expect(await postageStamp.firstBatchId()).to.be.equal(batch2Id);

        await mineNBlocks(200);

        await postageStamp.expireLimited(maxInt256);

        await expect(postageStamp.firstBatchId()).to.be.revertedWith(errors.firstBatchId.noneExist);
      });

      it('expireLimited should update the pot and delete expired batches', async function () {
        await mineNBlocks(20);
        await postageStamp.expireLimited(1);

        expect(await postageStamp.firstBatchId()).to.be.equal(batch1Id);

        await postageStamp.expireLimited(1);

        expect(await postageStamp.firstBatchId()).to.be.equal(batch2Id);

        await postageStamp.expireLimited(maxInt256);

        expect(await postageStamp.firstBatchId()).to.be.equal(batch2Id);

        await postageStamp.expireLimited(1);

        expect(await postageStamp.firstBatchId()).to.be.equal(batch2Id);

        await mineNBlocks(200);

        await postageStamp.expireLimited(1);

        await expect(postageStamp.firstBatchId()).to.be.revertedWith(errors.firstBatchId.noneExist);
      });
    });

    describe('when topupPot is called', function () {
      beforeEach(async function () {
        transferAmount = 2 ** 20;

        await mintAndApprove(deployer, stamper, postageStampStamper.address, transferAmount.toString());
      });
      it('should add to pot', async function () {
        const expectedAmount = transferAmount;

        expect(await postageStampStamper.pot()).equal(0);
        expect(await postageStampStamper.topupPot(transferAmount));
        expect(await postageStampStamper.pot()).equal(expectedAmount);
      });
    });

    describe('when copyBatch creates a batch', function () {
      beforeEach(async function () {
        const postageStampDeployer = await ethers.getContract('PostageStamp', deployer);
        const admin = await postageStampStamper.DEFAULT_ADMIN_ROLE();
        await postageStampDeployer.grantRole(admin, stamper);

        batch = {
          id: '0x000000000000000000000000000000000000000000000000000000000000abcd',
          nonce: '0x000000000000000000000000000000000000000000000000000000000000abcd',
          initialPaymentPerChunk: 10240,
          depth: 17,
          immutable: false,
          bucketDepth: 16,
        };

        batchSize = 2 ** batch.depth;
        transferAmount = batch.initialPaymentPerChunk * batchSize;

        await token.mint(stamper, transferAmount);
        (await ethers.getContract('TestToken', stamper)).approve(postageStampStamper.address, transferAmount);
      });

      it('should fire the BatchCreated event', async function () {
        await expect(
          postageStampStamper.copyBatch(
            stamper,
            batch.initialPaymentPerChunk,
            batch.depth,
            batch.bucketDepth,
            batch.nonce,
            batch.immutable
          )
        )
          .to.emit(postageStampStamper, 'BatchCreated')
          .withArgs(
            batch.nonce,
            transferAmount,
            batch.initialPaymentPerChunk,
            stamper,
            batch.depth,
            batch.bucketDepth,
            batch.immutable
          );
      });

      it('should store the batch', async function () {
        await postageStampStamper.copyBatch(
          stamper,
          batch.initialPaymentPerChunk,
          batch.depth,
          batch.bucketDepth,
          batch.nonce,
          batch.immutable
        );
        const stamp = await postageStampStamper.batches(batch.id);
        expect(stamp[0]).to.equal(stamper);
        expect(stamp[1]).to.equal(batch.depth);
        expect(stamp[2]).to.equal(batch.immutable);
        expect(stamp[3]).to.equal(batch.initialPaymentPerChunk);
      });

      it('should keep batches ordered by normalisedBalance', async function () {
        const nonce0 = '0x0000000000000000000000000000000000000000000000000000000000001234';
        const batch0 = computeBatchId(stamper, nonce0);

        await postageStampStamper.copyBatch(stamper, 3300, batch.depth, batch.bucketDepth, batch0, batch.immutable);
        expect(batch0).equal(await postageStampStamper.firstBatchId());

        const nonce1 = '0x0000000000000000000000000000000000000000000000000000000000001235';
        const batch1 = computeBatchId(stamper, nonce1);

        await postageStampStamper.copyBatch(stamper, 11, batch.depth, batch.bucketDepth, batch1, batch.immutable);
        expect(batch1).equal(await postageStampStamper.firstBatchId());

        const nonce2 = '0x0000000000000000000000000000000000000000000000000000000000001236';
        const batch2 = computeBatchId(stamper, nonce2);
        await postageStampStamper.copyBatch(stamper, 2200, batch.depth, batch.bucketDepth, batch2, batch.immutable);
        expect(batch1).equal(await postageStampStamper.firstBatchId());
        expect(batch2).not.equal(await postageStampStamper.firstBatchId());

        const stamp = await postageStampStamper.batches(batch1);
        expect(stamp[0]).to.equal(stamper);
        expect(stamp[1]).to.equal(batch.depth);
        expect(stamp[2]).to.equal(batch.immutable);
        expect(stamp[3]).to.equal(11);
      });

      it('should transfer the token', async function () {
        await postageStampStamper.copyBatch(
          stamper,
          batch.initialPaymentPerChunk,
          batch.depth,
          batch.bucketDepth,
          batch.nonce,
          batch.immutable
        );
        expect(await token.balanceOf(stamper)).to.equal(0);
      });

      it('should not create batch if insufficient funds', async function () {
        await expect(
          postageStampStamper.copyBatch(
            stamper,
            batch.initialPaymentPerChunk + 1,
            batch.depth,
            batch.bucketDepth,
            batch.nonce,
            batch.immutable
          )
        ).to.be.revertedWith('ERC20: transfer amount exceeds balance');
      });

      it('should not allow zero address as owner', async function () {
        await expect(
          postageStampStamper.copyBatch(
            zeroAddress,
            batch.initialPaymentPerChunk,
            batch.depth,
            batch.bucketDepth,
            batch.nonce,
            batch.immutable
          )
        ).to.be.revertedWith('owner cannot be the zero address');
      });

      it('should not allow zero as bucket depth', async function () {
        await expect(
          postageStampStamper.copyBatch(
            stamper,
            batch.initialPaymentPerChunk,
            batch.depth,
            0,
            batch.nonce,
            batch.immutable
          )
        ).to.be.revertedWith('invalid bucket depth');
      });

      it('should not allow bucket depth larger than depth', async function () {
        await expect(
          postageStampStamper.copyBatch(
            stamper,
            batch.initialPaymentPerChunk,
            batch.depth,
            batch.depth + 1,
            batch.nonce,
            batch.immutable
          )
        ).to.be.revertedWith('invalid bucket depth');
      });

      it('should not allow bucket depth equal to depth', async function () {
        await expect(
          postageStampStamper.copyBatch(
            stamper,
            batch.initialPaymentPerChunk,
            batch.depth,
            batch.depth,
            batch.nonce,
            batch.immutable
          )
        ).to.be.revertedWith('invalid bucket depth');
      });

      it('should not allow duplicate batch', async function () {
        await postageStampStamper.copyBatch(
          stamper,
          1000,
          batch.depth,
          batch.bucketDepth,
          batch.nonce,
          batch.immutable
        );
        await expect(
          postageStampStamper.copyBatch(stamper, 1000, batch.depth, batch.bucketDepth, batch.nonce, batch.immutable)
        ).to.be.revertedWith('batch already exists');
      });

      it('should not allow normalized balance to be zero', async function () {
        await expect(
          postageStampStamper.copyBatch(stamper, 0, batch.depth, batch.bucketDepth, batch.nonce, batch.immutable)
        ).to.be.revertedWith('normalisedBalance cannot be zero');
      });

      it('should not return empty batches', async function () {
        await postageStampStamper.copyBatch(
          stamper,
          batch.initialPaymentPerChunk,
          batch.depth,
          batch.bucketDepth,
          batch.nonce,
          batch.immutable
        );
        const stamp = await postageStampStamper.batches(batch.id);
        expect(stamp[0]).to.equal(stamper);
        expect(stamp[1]).to.equal(batch.depth);
        expect(stamp[2]).to.equal(batch.immutable);
        expect(stamp[3]).to.equal(batch.initialPaymentPerChunk);
        const isEmpty = await postageStampStamper.empty();
        expect(isEmpty).equal(false);
      });

      it('should not allow batch creation when paused', async function () {
        const postageStamp = await ethers.getContract('PostageStamp', deployer);
        await postageStamp.pause();
        await expect(
          postageStamp.copyBatch(stamper, 0, batch.depth, batch.bucketDepth, batch.nonce, batch.immutable)
        ).to.be.revertedWith('Pausable: paused');
      });

      it('should include totalOutpayment in the normalised balance', async function () {
        const price = 100;
        await setPrice(price);

        await expect(
          postageStampStamper.copyBatch(
            stamper,
            batch.initialPaymentPerChunk,
            batch.depth,
            batch.bucketDepth,
            batch.nonce,
            batch.immutable
          )
        )
          .to.emit(postageStampStamper, 'BatchCreated')
          .withArgs(
            batch.id,
            transferAmount,
            price + batch.initialPaymentPerChunk,
            stamper,
            batch.depth,
            batch.bucketDepth,
            batch.immutable
          );
        const stamp = await postageStampStamper.batches(batch.id);
        expect(stamp[3]).to.equal(price + batch.initialPaymentPerChunk);
      });

      it('should include pending totalOutpayment in the normalised balance', async function () {
        const price = 100;
        await setPrice(price);

        const expectedNormalisedBalance = 3 * price + batch.initialPaymentPerChunk;

        await mineNBlocks(2);

        await expect(
          postageStampStamper.copyBatch(
            stamper,
            batch.initialPaymentPerChunk,
            batch.depth,
            batch.bucketDepth,
            batch.nonce,
            batch.immutable
          )
        )
          .to.emit(postageStampStamper, 'BatchCreated')
          .withArgs(
            batch.id,
            transferAmount,
            expectedNormalisedBalance,
            stamper,
            batch.depth,
            batch.bucketDepth,
            batch.immutable
          );
        const stamp = await postageStampStamper.batches(batch.id);
        expect(stamp[3]).to.equal(expectedNormalisedBalance);
      });
    });
  });
});
