import { expect } from 'chai';
import { ethers, deployments } from 'hardhat';

const TEST_BEE_VERSION = '1.13.0';

describe('EnvOracle', function () {
  beforeEach(async function () {
    await deployments.fixture();
  });

  it('should deploy the contract with the right version', async () => {
    const EnvOracle = await ethers.getContractFactory('EnvOracle');
    const envOracle = await EnvOracle.deploy(TEST_BEE_VERSION);
    expect(await envOracle.minimumBeeVersion()).to.equal(TEST_BEE_VERSION);
  });
});
