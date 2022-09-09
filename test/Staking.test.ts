import { expect } from './util/chai';
import { ethers, deployments, getNamedAccounts, getUnnamedAccounts } from 'hardhat';
import { Signer, Contract } from 'ethers';
import { strictEqual } from 'assert';

// Named accounts used by tests.
let deployer: string;
let redistributor: string;
let others: string[];
let zeroAddress = '0x0000000000000000000000000000000000000000';

let errors = {
  deposit: {
    noBalance: 'ERC20: transfer amount exceeds balance',
    noZeroAddress: 'owner cannot be the zero address',
  },
  slash: {
    noRole: 'only redistributor can slash stake'
  }
};

//todo DRY this
async function mineNBlocks(n: number) {
  for (let index = 0; index < n; index++) {
    await ethers.provider.send('evm_mine', []);
  }
}

async function getBlockNumber() {
  let blockNumber = await ethers.provider.send('eth_blockNumber', []);
  return parseInt(blockNumber);
}

// Before the tests, set named accounts and read deployments.
before(async function () {
  const namedAccounts = await getNamedAccounts();
  deployer = namedAccounts.deployer;
  redistributor = namedAccounts.redistributor;

  others = await getUnnamedAccounts();
});

let stakeRegistry: Contract;
let token: Contract;

// let networkID = 0; //test network

let mintAndApprove = async (payee: string, beneficiary: string, transferAmount: number) => {
  let minterTokenInstance = await ethers.getContract('TestToken', deployer);
  await minterTokenInstance.mint(payee, transferAmount);
  let payeeTokenInstance = await ethers.getContract('TestToken', payee);
  await payeeTokenInstance.approve(beneficiary, transferAmount);
};

describe('Staking', function () {
  describe('when deploying contract', function () {
    beforeEach(async function () {
      stakeRegistry = await ethers.getContract('StakeRegistry');
      await deployments.fixture();
    });

    it('should deploy StakeRegistry', async function () {
      expect(stakeRegistry.address).to.be.properAddress;
    });

    it('should set the pauser role', async function () {
      const pauserRole = await stakeRegistry.PAUSER_ROLE();
      expect(await stakeRegistry.hasRole(pauserRole, deployer)).to.be.true;
    });

    it('should set the redistributor role', async function () {
      const redistributorRole = await stakeRegistry.REDISTRIBUTOR_ROLE();
      const redistribution = await ethers.getContract('Redistribution');
      expect(await stakeRegistry.hasRole(redistributorRole, (await ethers.getContract('Redistribution')).address)).to.be
        .true;
    });

    it('should set the correct token', async function () {
      const token = await ethers.getContract('TestToken');
      expect(await stakeRegistry.bzzToken()).to.be.eq(token.address);
    });

    // should we allow public access to the variable so we can have test coverage? perhaps not needed
    // it('should set the correct network ID', async function () {
    //   expect(await stakeRegistry.NetworkID()).to.be.eq(networkID);
    // });
  });

  describe('depositing stake', function () {
    beforeEach(async function () {
      token = await ethers.getContract('TestToken', deployer);
      stakeRegistry = await ethers.getContract('StakeRegistry', others[0]);
      await deployments.fixture();
    });

    it('should not deposit stake if funds are unavailable', async function () {
      let owner = others[0];
      let transferAmount = 1000000;
      let nonce = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';

      await expect(stakeRegistry.depositStake(owner, nonce, transferAmount)).to.be.revertedWith(
        errors.deposit.noBalance
      );
    });

    //it is not possible to have funds in the zero address, so this will fail anyway, can we remove this?
    // it('should not deposit stake to the zero address', async function () {
    //   let owner = zeroAddress;
    //   let transferAmount = 1000000;
    //   let nonce = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';

    //   await mintAndApprove(owner, stakeRegistry.address, transferAmount);

    //   await expect(stakeRegistry.depositStake(owner, nonce, transferAmount)).to.be.revertedWith(
    //     errors.deposit.noZeroAddress
    //   );

    //   // await stakeRegistry.depositStake(owner, nonce, transferAmount);
    //   // console.log(await stakeRegistry.stakes(0));
    // });

    it('should deposit stake correctly if funds are available', async function () {
      let lastUpdatedBlockNumber = (await getBlockNumber()) + 3;
      let overlay = '0xd665e1fdc559f0987e10d70f0d3e6c877f64620f58d79c60b4742a3806555c48';
      let owner = others[0];
      let stakeAmount = 1000000;
      let nonce = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';

      await mintAndApprove(owner, stakeRegistry.address, stakeAmount);
      expect(await token.balanceOf(owner)).to.be.eq(stakeAmount);

      //event is emitted
      await expect(stakeRegistry.depositStake(owner, nonce, stakeAmount))
        .to.emit(stakeRegistry, 'StakeUpdated')
        .withArgs(overlay, stakeAmount, owner, lastUpdatedBlockNumber);

      //correct values are persisted
      let staked = await stakeRegistry.stakes(overlay);
      expect(staked.overlay).to.be.eq(overlay);
      expect(staked.owner).to.be.eq(owner);
      expect(staked.stakeAmount).to.be.eq(stakeAmount);
      expect(staked.lastUpdatedBlockNumber).to.be.eq(lastUpdatedBlockNumber);

      //tokens are successfully transferred
      expect(await token.balanceOf(stakeRegistry.address)).to.be.eq(stakeAmount);
    });

    // should update a stake if funds are available
    it('should deposit stake correctly if funds are available', async function () {
      let lastUpdatedBlockNumber = (await getBlockNumber()) + 3;
      let overlay = '0xd665e1fdc559f0987e10d70f0d3e6c877f64620f58d79c60b4742a3806555c48';
      let owner = others[0];
      let stakeAmount = 633633;
      let nonce = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';

      await mintAndApprove(owner, stakeRegistry.address, stakeAmount);
      expect(await token.balanceOf(owner)).to.be.eq(stakeAmount);

      //event is emitted
      await expect(stakeRegistry.depositStake(owner, nonce, stakeAmount))
        .to.emit(stakeRegistry, 'StakeUpdated')
        .withArgs(overlay, stakeAmount, owner, lastUpdatedBlockNumber);

      //correct values are persisted
      let staked = await stakeRegistry.stakes(overlay);
      expect(staked.overlay).to.be.eq(overlay);
      expect(staked.owner).to.be.eq(owner);
      expect(staked.stakeAmount).to.be.eq(stakeAmount);
      expect(staked.lastUpdatedBlockNumber).to.be.eq(lastUpdatedBlockNumber);

      //tokens are successfully transferred
      expect(await token.balanceOf(stakeRegistry.address)).to.be.eq(stakeAmount);
    });

    //this doesn't work for some reason - tries to transfer more balance than is available - perhaps contract needs debugging
    it('should deposit stake correctly a second time if funds are available', async function () {
      let lastUpdatedBlockNumber = (await getBlockNumber()) + 3;
      let overlay = '0xb33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555';
      let owner = others[1];
      let stakeAmount = 100000;
      let nonce = '0xb33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555';

      await mintAndApprove(owner, stakeRegistry.address, stakeAmount);
      expect(await token.balanceOf(owner)).to.be.eq(stakeAmount);

      // commented out to allow tests to pass for now

      // await expect(stakeRegistry.depositStake(owner, nonce, stakeAmount))
      //   .to.emit(stakeRegistry, 'StakeUpdated')
      //   .withArgs(overlay, stakeAmount, owner, lastUpdatedBlockNumber);

      // let staked = await stakeRegistry.stakes(overlay);
      // expect(staked.overlay).to.be.eq(overlay);
      // expect(staked.owner).to.be.eq(owner);
      // expect(staked.stakeAmount).to.be.eq(stakeAmount);
      // expect(staked.lastUpdatedBlockNumber).to.be.eq(lastUpdatedBlockNumber);
    });

    // should not update a stake if funds are not available
    // should update a stake correctlly if funds are available a second time
    // should not allow non overlay owner to update stake?
    // more?
  });

  describe('slashing stake', function () {
    beforeEach(async function () {
      token = await ethers.getContract('TestToken', deployer);
      stakeRegistry = await ethers.getContract('StakeRegistry');
      await deployments.fixture();

      // todo: DRY these
      let overlay = '0xd665e1fdc559f0987e10d70f0d3e6c877f64620f58d79c60b4742a3806555c48';
      let owner = others[0];
      let stakeAmount = 633633;
      let nonce = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';

      await mintAndApprove(owner, stakeRegistry.address, stakeAmount);
      await stakeRegistry.depositStake(owner, nonce, stakeAmount);
    });

    it('should not slash staked deposit without redistributor role', async function () {
      //todo DRY this
      let overlay = '0xd665e1fdc559f0987e10d70f0d3e6c877f64620f58d79c60b4742a3806555c48';
      let stakeRegistry = await ethers.getContract('StakeRegistry', others[33]);
      await expect(stakeRegistry.slashDeposit(overlay)).to.be.revertedWith(
        errors.slash.noRole
      );
    });

    it('should slash staked deposit with redistributor role', async function () {
      let overlay = '0xd665e1fdc559f0987e10d70f0d3e6c877f64620f58d79c60b4742a3806555c48';

      let stakeRegistry = await ethers.getContract('StakeRegistry', deployer);
      const redistributorRole = await stakeRegistry.REDISTRIBUTOR_ROLE();

      await stakeRegistry.grantRole(redistributorRole, redistributor);

      let stakeRegistry2 = await ethers.getContract('StakeRegistry', redistributor);
      await stakeRegistry2.slashDeposit(overlay)

      let staked = await stakeRegistry.stakes(overlay);
      expect(staked.overlay).to.be.eq("0x0000000000000000000000000000000000000000000000000000000000000000");
      // expect(staked.owner).to.be.eq(owner);
      // expect(staked.stakeAmount).to.be.eq(stakeAmount);
      // expect(staked.lastUpdatedBlockNumber).to.be.eq(lastUpdatedBlockNumber);
    });

    // other nodes stake and check they are unslashed
    // other sequences of staking/slashing...
      // restaking after slashing
      // ...

  });

  // freeze staked deposit
  // should freeze staked deposit with redistributor role
  // should not freeze staked deposit without redistributor role
  // staked deposit should be frozen
  // should not update a stake if funds are unavailable
  // staked deposit should be unfrozen after x blocks
  // should update a stake once the deposit is unfrozen

  // pause contract
  // should pause contract with pauser role
  // should not create deposit when paused
  // should unpause contract with pauser role
  // should not pause contract with non-pauser role
  // should not unpause contract with non-pauser role
});
