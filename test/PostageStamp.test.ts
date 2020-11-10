import { expect } from './util/chai';
import { ethers, deployments, getNamedAccounts, getUnnamedAccounts } from 'hardhat';

// Named accounts used by tests.
let stamper: string;
let deployer: string;
let others: string[];

// Before the tests, set named accounts and read deployments.
before(async function () {
  const namedAccounts = await getNamedAccounts();
  deployer = namedAccounts.deployer;
  stamper = namedAccounts.stamper;
  others = await getUnnamedAccounts();
});

function computeBatchId(sender: string, nonce: string): string {
  const abi = new ethers.utils.AbiCoder();
  const encoded = abi.encode(['address', 'bytes32'], [sender, nonce]);
  return ethers.utils.keccak256(encoded);
}

const zeroAddress = '0x0000000000000000000000000000000000000000';

describe('PostageStamp', function () {
  describe('when deploying contract', function () {
    beforeEach(async function () {
      await deployments.fixture();
    });

    it('should deploy PostageStamp', async function () {
      const postageStamp = await ethers.getContract('PostageStamp');
      expect(postageStamp.address).to.be.a('string');
    });

    it('should set the correct token', async function () {
      const postageStamp = await ethers.getContract('PostageStamp');
      const token = await ethers.getContract('ERC20PresetMinterPauser');
      expect(await postageStamp.bzzToken()).to.be.eq(token.address);
    });
  });

  describe('with deployed contract', async function () {
    beforeEach(async function () {
      await deployments.fixture();
    });

    describe('when creating a batch', function () {
      beforeEach(async function () {
        this.postageStamp = await ethers.getContract('PostageStamp', stamper);
        this.token = await ethers.getContract('ERC20PresetMinterPauser', deployer);

        this.batch = {
          nonce: '0x000000000000000000000000000000000000000000000000000000000000abcd',
          initialPayment: 20,
          depth: 5,
        };

        this.batch.id = computeBatchId(stamper, this.batch.nonce);

        await this.token.mint(stamper, this.batch.initialPayment);
        (await ethers.getContract('ERC20PresetMinterPauser', stamper)).approve(
          this.postageStamp.address,
          this.batch.initialPayment
        );
      });

      it('should fire the BatchCreated event', async function () {
        await expect(
          this.postageStamp.createBatch(stamper, this.batch.initialPayment, this.batch.depth, this.batch.nonce)
        )
          .to.emit(this.postageStamp, 'BatchCreated')
          .withArgs(this.batch.id, this.batch.initialPayment, stamper, this.batch.depth);
      });

      it('should store the batch', async function () {
        await this.postageStamp.createBatch(stamper, this.batch.initialPayment, this.batch.depth, this.batch.nonce);
        expect(await this.postageStamp.batches(this.batch.id)).to.deep.equal([stamper, this.batch.depth]);
      });

      it('should transfer the token', async function () {
        await this.postageStamp.createBatch(stamper, this.batch.initialPayment, this.batch.depth, this.batch.nonce);
        expect(await this.token.balanceOf(stamper)).to.equal(0);
      });

      it('should not create batch if insufficient funds', async function () {
        expect(
          this.postageStamp.createBatch(stamper, this.batch.initialPayment + 100, this.batch.depth, this.batch.nonce)
        ).to.be.revertedWith('ERC20: transfer amount exceeds balance');
      });

      it('should not allow zero address as owner', async function () {
        expect(
          this.postageStamp.createBatch(zeroAddress, this.batch.initialPayment, this.batch.depth, this.batch.nonce)
        ).to.be.revertedWith('owner cannot be the zero address');
      });

      it('should not allow duplicate batch', async function () {
        await this.postageStamp.createBatch(stamper, 0, this.batch.depth, this.batch.nonce);
        await expect(this.postageStamp.createBatch(stamper, 0, this.batch.depth, this.batch.nonce)).to.be.revertedWith(
          'batch already exists'
        );
      });
    });

    describe('when topping up a batch', function () {
      beforeEach(async function () {
        this.postageStamp = await ethers.getContract('PostageStamp', stamper);
        this.token = await ethers.getContract('ERC20PresetMinterPauser', deployer);

        this.batch = {
          nonce: '0x000000000000000000000000000000000000000000000000000000000000abcd',
          initialPayment: 20,
          depth: 5,
        };

        this.batch.id = computeBatchId(stamper, this.batch.nonce);
        this.topupAmount = 100;

        await this.token.mint(stamper, this.batch.initialPayment + this.topupAmount);
        (await ethers.getContract('ERC20PresetMinterPauser', stamper)).approve(
          this.postageStamp.address,
          this.batch.initialPayment + this.topupAmount
        );
        await this.postageStamp.createBatch(stamper, this.batch.initialPayment, this.batch.depth, this.batch.nonce);
      });

      it('should fire the BatchTopUp event', async function () {
        await expect(this.postageStamp.topUp(this.batch.id, this.topupAmount))
          .to.emit(this.postageStamp, 'BatchTopUp')
          .withArgs(this.batch.id, this.topupAmount);
      });

      it('should transfer the token', async function () {
        await this.postageStamp.topUp(this.batch.id, this.topupAmount);
        expect(await this.token.balanceOf(stamper)).to.equal(0);
        expect(await this.token.balanceOf(this.postageStamp.address)).to.equal(
          this.batch.initialPayment + this.topupAmount
        );
      });

      it('should not top up non-existing batches', async function () {
        await expect(
          this.postageStamp.topUp(computeBatchId(deployer, this.batch.nonce), this.topupAmount)
        ).to.be.revertedWith('batch does not exist');
      });

      it('should not top up with insufficient funds', async function () {
        await expect(this.postageStamp.topUp(this.batch.id, this.topupAmount + 100)).to.be.revertedWith(
          'ERC20: transfer amount exceeds balance'
        );
      });
    });

    describe('when inceasing the depth', function () {
      beforeEach(async function () {
        this.postageStamp = await ethers.getContract('PostageStamp', stamper);
        this.token = await ethers.getContract('ERC20PresetMinterPauser', deployer);

        this.batch = {
          nonce: '0x000000000000000000000000000000000000000000000000000000000000abcd',
          initialPayment: 20,
          depth: 5,
        };

        this.batch.id = computeBatchId(stamper, this.batch.nonce);
        this.newDepth = 100;

        await this.token.mint(stamper, this.batch.initialPayment);
        (await ethers.getContract('ERC20PresetMinterPauser', stamper)).approve(
          this.postageStamp.address,
          this.batch.initialPayment
        );
        await this.postageStamp.createBatch(stamper, this.batch.initialPayment, this.batch.depth, this.batch.nonce);
      });

      it('should fire the BatchDepthIncrease event', async function () {
        await expect(this.postageStamp.increaseDepth(this.batch.id, this.newDepth))
          .to.emit(this.postageStamp, 'BatchDepthIncrease')
          .withArgs(this.batch.id, this.newDepth);
      });

      it('should update the stamp data', async function () {
        await this.postageStamp.increaseDepth(this.batch.id, this.newDepth);
        expect(await this.postageStamp.batches(this.batch.id)).to.deep.equal([stamper, this.newDepth]);
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
    });
  });
});
