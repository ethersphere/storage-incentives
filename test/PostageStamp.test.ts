import { expect } from './util/chai';
import { ethers, deployments, getNamedAccounts, getUnnamedAccounts } from 'hardhat';

// Named accounts used by tests.
let stamper: string;
let deployer: string;
let oracle: string;
let others: string[];

// Before the tests, set named accounts and read deployments.
before(async function () {
  const namedAccounts = await getNamedAccounts();
  deployer = namedAccounts.deployer;
  stamper = namedAccounts.stamper;
  oracle = namedAccounts.oracle;
  others = await getUnnamedAccounts();
});

function computeBatchId(sender: string, nonce: string): string {
  const abi = new ethers.utils.AbiCoder();
  const encoded = abi.encode(['address', 'bytes32'], [sender, nonce]);
  return ethers.utils.keccak256(encoded);
}

async function increaseTotalOutPayment(outPayment: number) {
  return await (await ethers.getContract('PostageStamp', oracle)).increaseTotalOutPayment(outPayment);
}

const zeroAddress = '0x0000000000000000000000000000000000000000';

describe('PostageStamp', function () {
  describe('when deploying contract', function () {
    beforeEach(async function () {
      await deployments.fixture();
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
  });

  describe('with deployed contract', async function () {
    beforeEach(async function () {
      await deployments.fixture();
    });
    describe('when creating a batch', function () {
      beforeEach(async function () {
        this.postageStamp = await ethers.getContract('PostageStamp', stamper);
        this.token = await ethers.getContract('TestToken', deployer);

        this.batch = {
          nonce: '0x000000000000000000000000000000000000000000000000000000000000abcd',
          initialPaymentPerChunk: 200,
          depth: 5,
        };

        this.batchSize = 2 ** this.batch.depth;
        this.transferAmount = this.batch.initialPaymentPerChunk * this.batchSize;
        this.expectedNormalisedBalance = this.batch.initialPaymentPerChunk;

        this.batch.id = computeBatchId(stamper, this.batch.nonce);

        await this.token.mint(stamper, this.transferAmount);
        (await ethers.getContract('TestToken', stamper)).approve(
          this.postageStamp.address,
          this.transferAmount
        );
      });

      it('should fire the BatchCreated event', async function () {
        await expect(
          this.postageStamp.createBatch(stamper, this.batch.initialPaymentPerChunk, this.batch.depth, this.batch.nonce)
        )
          .to.emit(this.postageStamp, 'BatchCreated')
          .withArgs(this.batch.id, this.transferAmount, this.expectedNormalisedBalance, stamper, this.batch.depth);
      });

      it('should store the batch', async function () {
        await this.postageStamp.createBatch(
          stamper,
          this.batch.initialPaymentPerChunk,
          this.batch.depth,
          this.batch.nonce
        );
        const stamp = await this.postageStamp.batches(this.batch.id);
        expect(stamp[0]).to.equal(stamper);
        expect(stamp[1]).to.equal(this.batch.depth);
        expect(stamp[2]).to.equal(this.expectedNormalisedBalance);
      });

      it('should transfer the token', async function () {
        await this.postageStamp.createBatch(
          stamper,
          this.batch.initialPaymentPerChunk,
          this.batch.depth,
          this.batch.nonce
        );
        expect(await this.token.balanceOf(stamper)).to.equal(0);
      });

      it('should not create batch if insufficient funds', async function () {
        await expect(
          this.postageStamp.createBatch(
            stamper,
            this.batch.initialPaymentPerChunk + 1,
            this.batch.depth,
            this.batch.nonce
          )
        ).to.be.revertedWith('ERC20: transfer amount exceeds balance');
      });

      it('should not allow zero address as owner', async function () {
        await expect(
          this.postageStamp.createBatch(
            zeroAddress,
            this.batch.initialPaymentPerChunk,
            this.batch.depth,
            this.batch.nonce
          )
        ).to.be.revertedWith('owner cannot be the zero address');
      });

      it('should not allow duplicate batch', async function () {
        await this.postageStamp.createBatch(stamper, 0, this.batch.depth, this.batch.nonce);
        await expect(this.postageStamp.createBatch(stamper, 0, this.batch.depth, this.batch.nonce)).to.be.revertedWith(
          'batch already exists'
        );
      });

      it('should include totalOutpayment in the normalised balance', async function () {
        const outPayment = 100;
        await increaseTotalOutPayment(100);

        await expect(
          this.postageStamp.createBatch(stamper, this.batch.initialPaymentPerChunk, this.batch.depth, this.batch.nonce)
        )
          .to.emit(this.postageStamp, 'BatchCreated')
          .withArgs(
            this.batch.id,
            this.transferAmount,
            outPayment + this.expectedNormalisedBalance,
            stamper,
            this.batch.depth
          );
        const stamp = await this.postageStamp.batches(this.batch.id);
        expect(stamp[2]).to.equal(outPayment + this.expectedNormalisedBalance);
      });
    });

    describe('when topping up a batch', function () {
      beforeEach(async function () {
        this.postageStamp = await ethers.getContract('PostageStamp', stamper);
        this.token = await ethers.getContract('TestToken', deployer);

        this.batch = {
          nonce: '0x000000000000000000000000000000000000000000000000000000000000abcd',
          initialPaymentPerChunk: 200,
          depth: 5,
        };

        this.batch.id = computeBatchId(stamper, this.batch.nonce);
        this.topupAmountPerChunk = 100;

        this.batchSize = 2 ** this.batch.depth;
        this.initialNormalisedBalance = this.batch.initialPaymentPerChunk;
        this.expectedNormalisedBalance = this.initialNormalisedBalance + this.topupAmountPerChunk;

        await this.token.mint(stamper, (this.batch.initialPaymentPerChunk + this.topupAmountPerChunk) * this.batchSize);
        (await ethers.getContract('TestToken', stamper)).approve(
          this.postageStamp.address,
          (this.batch.initialPaymentPerChunk + this.topupAmountPerChunk) * this.batchSize
        );
        await this.postageStamp.createBatch(
          stamper,
          this.batch.initialPaymentPerChunk,
          this.batch.depth,
          this.batch.nonce
        );
      });

      it('should fire the BatchTopUp event', async function () {
        await expect(this.postageStamp.topUp(this.batch.id, this.topupAmountPerChunk))
          .to.emit(this.postageStamp, 'BatchTopUp')
          .withArgs(this.batch.id, this.topupAmountPerChunk * this.batchSize, this.expectedNormalisedBalance);
      });

      it('should update the normalised balance', async function () {
        await this.postageStamp.topUp(this.batch.id, this.topupAmountPerChunk);
        const stamp = await this.postageStamp.batches(this.batch.id);
        expect(stamp[2]).to.equal(this.expectedNormalisedBalance);
      });

      it('should transfer the token', async function () {
        await this.postageStamp.topUp(this.batch.id, this.topupAmountPerChunk);
        expect(await this.token.balanceOf(stamper)).to.equal(0);
        expect(await this.token.balanceOf(this.postageStamp.address)).to.equal(
          (this.batch.initialPaymentPerChunk + this.topupAmountPerChunk) * this.batchSize
        );
      });

      it('should not top up non-existing batches', async function () {
        const nonExistingBatchId = computeBatchId(deployer, this.batch.nonce);
        await expect(this.postageStamp.topUp(nonExistingBatchId, this.topupAmountPerChunk)).to.be.revertedWith(
          'batch does not exist'
        );
      });

      it('should not top up with insufficient funds', async function () {
        await expect(this.postageStamp.topUp(this.batch.id, this.topupAmountPerChunk + 1)).to.be.revertedWith(
          'ERC20: transfer amount exceeds balance'
        );
      });

      it('should not top up expired batches', async function () {
        await increaseTotalOutPayment(this.initialNormalisedBalance + 1);
        await expect(this.postageStamp.topUp(this.batch.id, this.topupAmountPerChunk)).to.be.revertedWith(
          'batch already expired'
        );
      });
    });

    describe('when increasing the depth', function () {
      beforeEach(async function () {
        this.postageStamp = await ethers.getContract('PostageStamp', stamper);
        this.token = await ethers.getContract('TestToken', deployer);

        this.totalOutPayment = 100;
        await increaseTotalOutPayment(this.totalOutPayment);

        this.batch = {
          nonce: '0x000000000000000000000000000000000000000000000000000000000000abcd',
          initialPaymentPerChunk: 200000,
          depth: 5,
        };

        this.batch.id = computeBatchId(stamper, this.batch.nonce);
        this.newDepth = 10;

        this.batchSize = 2 ** this.batch.depth;
        this.newBatchSize = 2 ** this.newDepth;
        this.initialNormalisedBalance = this.totalOutPayment + this.batch.initialPaymentPerChunk;
        const transferAmount = this.batch.initialPaymentPerChunk * this.batchSize;
        this.expectedNormalisedBalance = this.totalOutPayment + Math.floor(transferAmount / this.newBatchSize);

        await this.token.mint(stamper, transferAmount);
        (await ethers.getContract('TestToken', stamper)).approve(
          this.postageStamp.address,
          transferAmount
        );
        await this.postageStamp.createBatch(
          stamper,
          this.batch.initialPaymentPerChunk,
          this.batch.depth,
          this.batch.nonce
        );
      });

      it('should fire the BatchDepthIncrease event', async function () {
        await expect(this.postageStamp.increaseDepth(this.batch.id, this.newDepth))
          .to.emit(this.postageStamp, 'BatchDepthIncrease')
          .withArgs(this.batch.id, this.newDepth, this.expectedNormalisedBalance);
      });

      it('should update the stamp data', async function () {
        await this.postageStamp.increaseDepth(this.batch.id, this.newDepth);
        const stamp = await this.postageStamp.batches(this.batch.id);
        expect(stamp[0]).to.equal(stamper);
        expect(stamp[1]).to.equal(this.newDepth);
        expect(stamp[2]).to.equal(this.expectedNormalisedBalance);
      });

      it('should not allow other accounts to increase depth', async function () {
        const postageStamp = await ethers.getContract('PostageStamp', others[0]);
        await expect(postageStamp.increaseDepth(this.batch.id, this.newDepth)).to.be.revertedWith('not batch owner');
      });

      it('should not allow decreasing the depth', async function () {
        await expect(this.postageStamp.increaseDepth(this.batch.id, this.batch.depth - 1)).to.be.revertedWith(
          'depth not increasing'
        );
      });

      it('should not allow the same depth', async function () {
        await expect(this.postageStamp.increaseDepth(this.batch.id, this.batch.depth)).to.be.revertedWith(
          'depth not increasing'
        );
      });

      it('should not increase depth of expired batches', async function () {
        await increaseTotalOutPayment(this.batch.initialPaymentPerChunk + 1);
        await expect(this.postageStamp.increaseDepth(this.batch.id, this.newDepth)).to.be.revertedWith(
          'batch already expired'
        );
      });

      it('should compute correct balance if outpayments changed since creation', async function () {
        const outPaymentIncrease = 64;
        await increaseTotalOutPayment(outPaymentIncrease);

        const unusedPart = this.batch.initialPaymentPerChunk - outPaymentIncrease;
        const currentOutPayment = this.totalOutPayment + outPaymentIncrease;

        const expectedNormalisedBalance =
          currentOutPayment + Math.floor((unusedPart * this.batchSize) / this.newBatchSize);

        await expect(this.postageStamp.increaseDepth(this.batch.id, this.newDepth))
          .to.emit(this.postageStamp, 'BatchDepthIncrease')
          .withArgs(this.batch.id, this.newDepth, expectedNormalisedBalance);
      });
    });

    describe('when increasing outpayment', function () {
      it('should increase the outpayment if called by oracle', async function () {
        const postageStamp = await ethers.getContract('PostageStamp', oracle);

        const increase1 = 100;
        await postageStamp.increaseTotalOutPayment(increase1);
        expect(await postageStamp.totalOutPayment()).to.be.eq(increase1);

        const increase2 = 200;
        await postageStamp.increaseTotalOutPayment(increase2);
        expect(await postageStamp.totalOutPayment()).to.be.eq(increase1 + increase2);
      });

      it('should revert if not called by oracle', async function () {
        const postageStamp = await ethers.getContract('PostageStamp', deployer);
        await expect(postageStamp.increaseTotalOutPayment(100)).to.be.revertedWith(
          'only price oracle can increase totalOutpayment'
        );
      });
    });
  });
});
