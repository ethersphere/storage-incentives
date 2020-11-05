import { expect } from './util/chai';
import { ethers, deployments, getNamedAccounts } from 'hardhat';

// Named accounts used by tests.
let stamper: string;
let deployer: string;

// Before the tests, set named accounts and read deployments.
before(async function () {
  const namedAccounts = await getNamedAccounts();
  deployer = namedAccounts.deployer;
  stamper = namedAccounts.stamper;
});

function computeBatchId(sender: string, nonce: string): string {
  const abi = new ethers.utils.AbiCoder();
  const encoded = abi.encode(['address', 'bytes32'], [sender, nonce]);
  return ethers.utils.keccak256(encoded);
}

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
      it('should create the batch', async function () {
        const postageStamp = await ethers.getContract('PostageStamp', stamper);
        const token = await ethers.getContract('ERC20PresetMinterPauser', deployer);
        const nonce = '0x000000000000000000000000000000000000000000000000000000000000abcd';
        const initialPayment = 20;
        const depth = 5;
        const batchId = computeBatchId(stamper, nonce);

        await token.mint(stamper, initialPayment);
        (await ethers.getContract('ERC20PresetMinterPauser', stamper)).approve(postageStamp.address, initialPayment);

        await expect(postageStamp.createBatch(stamper, initialPayment, depth, nonce))
          .to.emit(postageStamp, 'BatchCreated')
          .withArgs(batchId, initialPayment, stamper, depth);

        expect(await postageStamp.batches(batchId)).to.deep.equal([stamper, depth]);
      });
    });
  });
});
