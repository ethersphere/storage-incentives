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

async function setPrice(price: number) {
  return await (await ethers.getContract('PostageStamp', oracle)).setPrice(price);
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

    it('should assign the pauser role', async function () {
      const postageStamp = await ethers.getContract('PostageStamp');
      const pauserRole = await postageStamp.PAUSER_ROLE();
      expect(await postageStamp.hasRole(pauserRole, deployer)).to.be.true;
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
          immutable: false,
          bucketDepth: 4,
        };

        this.batchSize = 2 ** this.batch.depth;
        this.transferAmount = this.batch.initialPaymentPerChunk * this.batchSize;
        this.expectedNormalisedBalance = this.batch.initialPaymentPerChunk;

        this.batch.id = computeBatchId(stamper, this.batch.nonce);

        await this.token.mint(stamper, this.transferAmount);
        (await ethers.getContract('TestToken', stamper)).approve(this.postageStamp.address, this.transferAmount);
      });

      it('should fire the BatchCreated event', async function () {
        await expect(
          this.postageStamp.createBatch(
            stamper,
            this.batch.initialPaymentPerChunk,
            this.batch.depth,
            this.batch.bucketDepth,
            this.batch.nonce,
            this.batch.immutable
          )
        )
          .to.emit(this.postageStamp, 'BatchCreated')
          .withArgs(
            this.batch.id,
            this.transferAmount,
            this.expectedNormalisedBalance,
            stamper,
            this.batch.depth,
            this.batch.bucketDepth,
            this.batch.immutable
          );
      });

      it('should store the batch', async function () {
        await this.postageStamp.createBatch(
          stamper,
          this.batch.initialPaymentPerChunk,
          this.batch.depth,
          this.batch.bucketDepth,
          this.batch.nonce,
          this.batch.immutable
        );
        const stamp = await this.postageStamp.batches(this.batch.id);
        expect(stamp[0]).to.equal(stamper);
        expect(stamp[1]).to.equal(this.batch.depth);
        expect(stamp[2]).to.equal(this.batch.immutable);
        expect(stamp[3]).to.equal(this.expectedNormalisedBalance);
      });

      it('should transfer the token', async function () {
        await this.postageStamp.createBatch(
          stamper,
          this.batch.initialPaymentPerChunk,
          this.batch.depth,
          this.batch.bucketDepth,
          this.batch.nonce,
          this.batch.immutable
        );
        expect(await this.token.balanceOf(stamper)).to.equal(0);
      });

      it('should not create batch if insufficient funds', async function () {
        await expect(
          this.postageStamp.createBatch(
            stamper,
            this.batch.initialPaymentPerChunk + 1,
            this.batch.depth,
            this.batch.bucketDepth,
            this.batch.nonce,
            this.batch.immutable
          )
        ).to.be.revertedWith('ERC20: transfer amount exceeds balance');
      });

      it('should not allow zero address as owner', async function () {
        await expect(
          this.postageStamp.createBatch(
            zeroAddress,
            this.batch.initialPaymentPerChunk,
            this.batch.depth,
            this.batch.bucketDepth,
            this.batch.nonce,
            this.batch.immutable
          )
        ).to.be.revertedWith('owner cannot be the zero address');
      });

      it('should not allow zero as bucket depth', async function () {
        await expect(
          this.postageStamp.createBatch(
            stamper,
            this.batch.initialPaymentPerChunk,
            this.batch.depth,
            0,
            this.batch.nonce,
            this.batch.immutable
          )
        ).to.be.revertedWith('invalid bucket depth');
      });

      it('should not allow bucket depth larger than depth', async function () {
        await expect(
          this.postageStamp.createBatch(
            stamper,
            this.batch.initialPaymentPerChunk,
            this.batch.depth,
            this.batch.depth + 1,
            this.batch.nonce,
            this.batch.immutable
          )
        ).to.be.revertedWith('invalid bucket depth');
      });

      it('should not allow bucket depth equal to depth', async function () {
        await expect(
          this.postageStamp.createBatch(
            stamper,
            this.batch.initialPaymentPerChunk,
            this.batch.depth,
            this.batch.depth,
            this.batch.nonce,
            this.batch.immutable
          )
        ).to.be.revertedWith('invalid bucket depth');
      });

      it('should not allow duplicate batch', async function () {
        await this.postageStamp.createBatch(
          stamper,
          0,
          this.batch.depth,
          this.batch.bucketDepth,
          this.batch.nonce,
          this.batch.immutable
        );
        await expect(
          this.postageStamp.createBatch(
            stamper,
            0,
            this.batch.depth,
            this.batch.bucketDepth,
            this.batch.nonce,
            this.batch.immutable
          )
        ).to.be.revertedWith('batch already exists');
      });

      it('should not allow batch creation when paused', async function () {
        const postageStamp = await ethers.getContract('PostageStamp', deployer);
        await postageStamp.pause();
        await expect(
          this.postageStamp.createBatch(
            stamper,
            0,
            this.batch.depth,
            this.batch.bucketDepth,
            this.batch.nonce,
            this.batch.immutable
          )
        ).to.be.revertedWith('Pausable: paused');
      });

      it('should include totalOutpayment in the normalised balance', async function () {
        const price = 100;
        await setPrice(price);

        await expect(
          this.postageStamp.createBatch(
            stamper,
            this.batch.initialPaymentPerChunk,
            this.batch.depth,
            this.batch.bucketDepth,
            this.batch.nonce,
            this.batch.immutable
          )
        )
          .to.emit(this.postageStamp, 'BatchCreated')
          .withArgs(
            this.batch.id,
            this.transferAmount,
            price + this.expectedNormalisedBalance,
            stamper,
            this.batch.depth,
            this.batch.bucketDepth,
            this.batch.immutable
          );
        const stamp = await this.postageStamp.batches(this.batch.id);
        expect(stamp[3]).to.equal(price + this.expectedNormalisedBalance);
      });

      it('should include pending totalOutpayment in the normalised balance', async function () {
        const price = 100;
        await setPrice(price);

        // mine two blocks, therefore when the next createBatch happens the totalOutpayment increased 3 times
        await ethers.provider.send('evm_mine', []);
        await ethers.provider.send('evm_mine', []);

        await expect(
          this.postageStamp.createBatch(
            stamper,
            this.batch.initialPaymentPerChunk,
            this.batch.depth,
            this.batch.bucketDepth,
            this.batch.nonce,
            this.batch.immutable
          )
        )
          .to.emit(this.postageStamp, 'BatchCreated')
          .withArgs(
            this.batch.id,
            this.transferAmount,
            3 * price + this.expectedNormalisedBalance,
            stamper,
            this.batch.depth,
            this.batch.bucketDepth,
            this.batch.immutable
          );
        const stamp = await this.postageStamp.batches(this.batch.id);
        expect(stamp[3]).to.equal(3 * price + this.expectedNormalisedBalance);
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
          bucketDepth: 4,
          immutable: false,
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
          this.batch.bucketDepth,
          this.batch.nonce,
          this.batch.immutable
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
        expect(stamp[3]).to.equal(this.expectedNormalisedBalance);
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
        await setPrice(this.batch.initialPaymentPerChunk);
        await expect(this.postageStamp.topUp(this.batch.id, this.topupAmountPerChunk)).to.be.revertedWith(
          'batch already expired'
        );
      });
      it('should not top up when paused', async function () {
        const postageStamp = await ethers.getContract('PostageStamp', deployer);
        await postageStamp.pause();
        await expect(this.postageStamp.topUp(this.batch.id, this.topupAmountPerChunk)).to.be.revertedWith(
          'Pausable: paused'
        );
      });
    });

    describe('when increasing the depth', function () {
      beforeEach(async function () {
        this.postageStamp = await ethers.getContract('PostageStamp', stamper);
        this.token = await ethers.getContract('TestToken', deployer);

        this.price = 100;
        this.totalOutPayment = this.price;

        this.batch = {
          nonce: '0x000000000000000000000000000000000000000000000000000000000000abcd',
          initialPaymentPerChunk: 200000,
          depth: 5,
          bucketDepth: 4,
          immutable: false,
        };

        this.batch.id = computeBatchId(stamper, this.batch.nonce);
        this.newDepth = 10;

        this.batchSize = 2 ** this.batch.depth;
        this.newBatchSize = 2 ** this.newDepth;
        this.increaseFactor = this.newBatchSize / this.batchSize;
        this.initialNormalisedBalance = this.totalOutPayment + this.batch.initialPaymentPerChunk;
        const transferAmount = this.batch.initialPaymentPerChunk * this.batchSize;

        await this.token.mint(stamper, transferAmount);
        (await ethers.getContract('TestToken', stamper)).approve(this.postageStamp.address, transferAmount);

        await setPrice(this.price);
        // totalOutpayment: 0, pending: price
        await this.postageStamp.createBatch(
          stamper,
          this.batch.initialPaymentPerChunk,
          this.batch.depth,
          this.batch.bucketDepth,
          this.batch.nonce,
          this.batch.immutable
        );

        // at the moment of the depth increase the currentTotalOutpayment is already 2*price
        // 1 * price of the batch value was already used up
        this.expectedNormalisedBalance =
          2 * this.price + Math.floor((this.batch.initialPaymentPerChunk - this.price) / this.increaseFactor);
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
        expect(stamp[2]).to.equal(this.batch.immutable);
        expect(stamp[3]).to.equal(this.expectedNormalisedBalance);
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
        // one price applied so far, this ensures the currentTotalOutpayment will be exactly the batch value when increaseDepth is called
        await setPrice(this.batch.initialPaymentPerChunk - this.price);
        await expect(this.postageStamp.increaseDepth(this.batch.id, this.newDepth)).to.be.revertedWith(
          'batch already expired'
        );
      });

      it('should not increasing the detph when paused', async function () {
        const postageStamp = await ethers.getContract('PostageStamp', deployer);
        await postageStamp.pause();
        await expect(this.postageStamp.increaseDepth(this.batch.id, this.newDepth)).to.be.revertedWith(
          'Pausable: paused'
        );
      });

      it('should compute correct balance if outpayments changed since creation', async function () {
        const newPrice = 64;
        await setPrice(newPrice);

        // at the moment of the depth increase the currentTotalOutpayment is already 2*price + 1*newPrice
        // 1 * price and 1 * newPrice of the batch value was already used up
        const expectedNormalisedBalance =
          2 * this.price +
          newPrice +
          Math.floor((this.batch.initialPaymentPerChunk - this.price - newPrice) / this.increaseFactor);

        await expect(this.postageStamp.increaseDepth(this.batch.id, this.newDepth))
          .to.emit(this.postageStamp, 'BatchDepthIncrease')
          .withArgs(this.batch.id, this.newDepth, expectedNormalisedBalance);
      });
    });

    describe('when increasing the depth of immutable batches', function () {
      beforeEach(async function () {
        this.postageStamp = await ethers.getContract('PostageStamp', stamper);
        this.token = await ethers.getContract('TestToken', deployer);

        this.price = 100;
        this.totalOutPayment = this.price;

        this.batch = {
          nonce: '0x000000000000000000000000000000000000000000000000000000000000abcd',
          initialPaymentPerChunk: 200000,
          depth: 5,
          bucketDepth: 4,
          immutable: true,
        };

        this.batch.id = computeBatchId(stamper, this.batch.nonce);
        this.newDepth = 10;

        this.batchSize = 2 ** this.batch.depth;
        const transferAmount = this.batch.initialPaymentPerChunk * this.batchSize;

        await this.token.mint(stamper, transferAmount);
        (await ethers.getContract('TestToken', stamper)).approve(this.postageStamp.address, transferAmount);

        await setPrice(this.price);
        // totalOutpayment: 0, pending: price
        await this.postageStamp.createBatch(
          stamper,
          this.batch.initialPaymentPerChunk,
          this.batch.depth,
          this.batch.bucketDepth,
          this.batch.nonce,
          this.batch.immutable
        );
      });

      it('should revert', async function () {
        await expect(this.postageStamp.increaseDepth(this.batch.id, this.newDepth)).to.be.revertedWith(
          'batch is immutable'
        );
      });
    });

    describe('when setting the price', function () {
      it('should increase the outpayment if called by oracle', async function () {
        const postageStamp = await ethers.getContract('PostageStamp', oracle);

        const price1 = 100;
        await postageStamp.setPrice(price1);

        await ethers.provider.send('evm_mine', []);
        expect(await postageStamp.currentTotalOutPayment()).to.be.eq(price1);
        expect(await postageStamp.totalOutPayment()).to.be.eq(0);

        await ethers.provider.send('evm_mine', []);
        expect(await postageStamp.currentTotalOutPayment()).to.be.eq(2 * price1);
        expect(await postageStamp.totalOutPayment()).to.be.eq(0);

        const price2 = 200;
        await postageStamp.setPrice(price2);
        expect(await postageStamp.currentTotalOutPayment()).to.be.eq(3 * price1);
        expect(await postageStamp.totalOutPayment()).to.be.eq(3 * price1);

        await ethers.provider.send('evm_mine', []);
        expect(await postageStamp.currentTotalOutPayment()).to.be.eq(3 * price1 + 1 * price2);
        expect(await postageStamp.totalOutPayment()).to.be.eq(3 * price1);

        await ethers.provider.send('evm_mine', []);
        expect(await postageStamp.currentTotalOutPayment()).to.be.eq(3 * price1 + 2 * price2);
        expect(await postageStamp.totalOutPayment()).to.be.eq(3 * price1);
      });

      it('should emit event if called by oracle', async function () {
        const postageStamp = await ethers.getContract('PostageStamp', oracle);
        const price = 100;
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
        await expect(postageStamp.pause()).to.be.revertedWith('only pauser can pause the contract');
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
        await expect(postageStamp2.unPause()).to.be.revertedWith('only pauser can unpause the contract');
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
  });
});
