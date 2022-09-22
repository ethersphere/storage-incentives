import { expect } from './util/chai';
import { ethers, deployments, getNamedAccounts, getUnnamedAccounts } from 'hardhat';
import { Contract } from 'ethers';

// Named accounts used by tests.
let deployer: string;
let redistributor: string;
let pauser: string;
let others: string[];

const zeroAddress = '0x0000000000000000000000000000000000000000';
const zeroBytes32 = '0x0000000000000000000000000000000000000000000000000000000000000000';

const freezeTime = 3;

const errors = {
  deposit: {
    noBalance: 'ERC20: transfer amount exceeds balance',
    noZeroAddress: 'owner cannot be the zero address',
    belowMinimum: 'cannot be below the minimum stake value',
  },
  slash: {
    noRole: 'only redistributor can slash stake',
  },
  freeze: {
    noRole: 'only redistributor can freeze stake',
    currentlyFrozen: 'overlay currently frozen',
  },
  pause: {
    noRole: 'only pauser can pause the contract',
    currentlyPaused: 'Pausable: paused',
    onlyPauseCanUnPause: 'only pauser can unpause the contract',
  },
};

//todo DRY this
async function mineNBlocks(n: number) {
  for (let index = 0; index < n; index++) {
    await ethers.provider.send('evm_mine', []);
  }
}

async function getBlockNumber() {
  const blockNumber = await ethers.provider.send('eth_blockNumber', []);
  return parseInt(blockNumber);
}

let staker_0: string;
const overlay_0 = '0xd665e1fdc559f0987e10d70f0d3e6c877f64620f58d79c60b4742a3806555c48';
const stakeAmount_0 = "10000000000000000";
const updateStakeAmount = "633633"
const updatedStakeAmount = "10000000000633633"
const twice_stakeAmount_0 = "20000000000000000";
const nonce_0 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';

let staker_1: string;
const overlay_1 = '0x531b0865a82da516c606e5349b1477811d26ca2257bf09e40ec47eaa0b6c706c'; //check calc?
const stakeAmount_1 = "10000000000000000";
const nonce_1 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';

// Before the tests, set named accounts and read deployments.
before(async function () {
  const namedAccounts = await getNamedAccounts();
  deployer = namedAccounts.deployer;
  redistributor = namedAccounts.redistributor;
  pauser = namedAccounts.pauser;

  others = await getUnnamedAccounts();
  staker_0 = others[0];
  staker_1 = others[1];
});

let stakeRegistry: Contract;
let token: Contract;

// let networkID = 0; //test network

//todo DRY this
async function mintAndApprove(payee: string, beneficiary: string, transferAmount: string) {
  const minterTokenInstance = await ethers.getContract('TestToken', deployer);
  await minterTokenInstance.mint(payee, transferAmount);
  const payeeTokenInstance = await ethers.getContract('TestToken', payee);
  await payeeTokenInstance.approve(beneficiary, transferAmount);
}

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
      expect(await stakeRegistry.hasRole(pauserRole, pauser)).to.be.true;
    });

    it('should set the redistributor role', async function () {
      const redistributorRole = await stakeRegistry.REDISTRIBUTOR_ROLE();
      const redistribution = await ethers.getContract('Redistribution');
      expect(await stakeRegistry.hasRole(redistributorRole, redistribution.address)).to.be.true;
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
      await expect(stakeRegistry.depositStake(staker_0, nonce_0, stakeAmount_0)).to.be.revertedWith(
        errors.deposit.noBalance
      );
    });

    it('should not deposit stake to the zero address', async function () {
      const owner = zeroAddress;
      const nonce = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';

      await mintAndApprove(staker_0, stakeRegistry.address, stakeAmount_0);

      await expect(stakeRegistry.depositStake(owner, nonce, stakeAmount_0)).to.be.revertedWith(
        errors.deposit.noZeroAddress
      );
    });

    it('should deposit stake correctly if funds are available', async function () {
      const sr_staker_0 = await ethers.getContract('StakeRegistry', staker_0);

      const updatedBlockNumber = (await getBlockNumber()) + 3;

      await mintAndApprove(staker_0, stakeRegistry.address, stakeAmount_0);
      expect(await token.balanceOf(staker_0)).to.be.eq(stakeAmount_0);

      //event is emitted
      await expect(sr_staker_0.depositStake(staker_0, nonce_0, stakeAmount_0))
        .to.emit(stakeRegistry, 'StakeUpdated')
        .withArgs(overlay_0, stakeAmount_0, staker_0, updatedBlockNumber);

      //the staker's balance has been decremented by the stake amount
      expect(await token.balanceOf(staker_0)).to.be.eq(0);

      //correct values are persisted
      const staked = await sr_staker_0.stakes(overlay_0);
      expect(staked.overlay).to.be.eq(overlay_0);
      expect(staked.owner).to.be.eq(staker_0);
      expect(staked.stakeAmount).to.be.eq(stakeAmount_0);
      expect(staked.lastUpdatedBlockNumber).to.be.eq(updatedBlockNumber);

      //tokens are successfully transferred
      expect(await token.balanceOf(stakeRegistry.address)).to.be.eq(stakeAmount_0);
    });

    // add this?
    // it('should not deposit zero stake', async function () {
    //   let sr_staker_0 = await ethers.getContract('StakeRegistry', staker_0);

    //   let updatedBlockNumber = (await getBlockNumber())+1;

    //   await expect(sr_staker_0.depositStake(staker_0, nonce_0, zeroStake)).to.be.revertedWith(errors.deposit.belowMinimum);
    // });

    it('should update stake correctly if funds are available', async function () {
      const sr_staker_0 = await ethers.getContract('StakeRegistry', staker_0);

      await mintAndApprove(staker_0, stakeRegistry.address, stakeAmount_0);
      expect(await token.balanceOf(staker_0)).to.be.eq(stakeAmount_0);

      sr_staker_0.depositStake(staker_0, nonce_0, stakeAmount_0);

      const lastUpdatedBlockNumber = (await getBlockNumber()) + 3;

      await mintAndApprove(staker_0, stakeRegistry.address, updateStakeAmount);
      expect(await token.balanceOf(staker_0)).to.be.eq(updateStakeAmount);

      //event is emitted
      await expect(sr_staker_0.depositStake(staker_0, nonce_0, updateStakeAmount))
        .to.emit(stakeRegistry, 'StakeUpdated')
        .withArgs(overlay_0, updatedStakeAmount, staker_0, lastUpdatedBlockNumber + 1);

      //correct values are persisted
      const staked = await stakeRegistry.stakes(overlay_0);
      expect(staked.overlay).to.be.eq(overlay_0);
      expect(staked.owner).to.be.eq(staker_0);
      expect(staked.stakeAmount).to.be.eq(updatedStakeAmount);
      expect(staked.lastUpdatedBlockNumber).to.be.eq(lastUpdatedBlockNumber + 1);

      // //tokens are successfully transferred
      expect(await token.balanceOf(stakeRegistry.address)).to.be.eq(updatedStakeAmount);
    });

    it('should correctly deposit stake from another user if funds are available', async function () {
      const sr_staker_0 = await ethers.getContract('StakeRegistry', staker_0);

      const lastUpdatedBlockNumber = (await getBlockNumber()) + 3;

      await mintAndApprove(staker_0, stakeRegistry.address, stakeAmount_1);
      expect(await token.balanceOf(staker_0)).to.be.eq(stakeAmount_1);

      await expect(sr_staker_0.depositStake(staker_1, nonce_1, stakeAmount_1))
        .to.emit(stakeRegistry, 'StakeUpdated')
        .withArgs(overlay_1, stakeAmount_1, staker_1, lastUpdatedBlockNumber);

      const staked = await stakeRegistry.stakes(overlay_1);
      expect(staked.overlay).to.be.eq(overlay_1);
      expect(staked.owner).to.be.eq(staker_1);
      expect(staked.stakeAmount).to.be.eq(stakeAmount_1);
      expect(staked.lastUpdatedBlockNumber).to.be.eq(lastUpdatedBlockNumber);
    });

    // should update a stake correctlly if funds are available a second time
    // should not allow non overlay owner to update stake?
    // other sequences of staking, updating...
    // more?
  });

  describe('slashing stake', function () {
    beforeEach(async function () {
      token = await ethers.getContract('TestToken', deployer);
      stakeRegistry = await ethers.getContract('StakeRegistry');
      await deployments.fixture();

      await mintAndApprove(staker_0, stakeRegistry.address, stakeAmount_0);
      await stakeRegistry.depositStake(staker_0, nonce_0, stakeAmount_0);

      const stakeRegistryDeployer = await ethers.getContract('StakeRegistry', deployer);
      const redistributorRole = await stakeRegistryDeployer.REDISTRIBUTOR_ROLE();
      await stakeRegistryDeployer.grantRole(redistributorRole, redistributor);
    });

    it('should not slash staked deposit without redistributor role', async function () {
      const stakeRegistry = await ethers.getContract('StakeRegistry', staker_1);
      await expect(stakeRegistry.slashDeposit(overlay_0)).to.be.revertedWith(errors.slash.noRole);
    });

    it('should slash staked deposit with redistributor role', async function () {
      const stakeRegistryRedistributor = await ethers.getContract('StakeRegistry', redistributor);

      await stakeRegistryRedistributor.slashDeposit(overlay_0);

      //is this what is expected?
      const staked = await stakeRegistry.stakes(overlay_0);
      expect(staked.overlay).to.be.eq(zeroBytes32);
      expect(staked.owner).to.be.eq(zeroAddress);
      expect(staked.stakeAmount).to.be.eq(0);
      expect(staked.lastUpdatedBlockNumber).to.be.eq(0);
    });

    // it('should restake deposit for same address after slashing', async function () {});

    // it('should not slash other nodes stakes when slashing', async function () {});

    // other sequences of staking/slashing..?
  });

  //tbc consensus will we include it?
  describe('freezing stake', function () {
    beforeEach(async function () {
      token = await ethers.getContract('TestToken', deployer);
      stakeRegistry = await ethers.getContract('StakeRegistry');
      await deployments.fixture();

      await mintAndApprove(staker_0, stakeRegistry.address, stakeAmount_0);
      await stakeRegistry.depositStake(staker_0, nonce_0, stakeAmount_0);

      const stakeRegistryDeployer = await ethers.getContract('StakeRegistry', deployer);
      const redistributorRole = await stakeRegistryDeployer.REDISTRIBUTOR_ROLE();
      await stakeRegistryDeployer.grantRole(redistributorRole, redistributor);
    });

    it('should not freeze staked deposit without redistributor role', async function () {
      const stakeRegistryStaker1 = await ethers.getContract('StakeRegistry', staker_1);
      await expect(stakeRegistryStaker1.freezeDeposit(overlay_0, freezeTime)).to.be.revertedWith(errors.freeze.noRole);
    });

    it('should freeze staked deposit with redistributor role', async function () {
      const stakeRegistryRedistributor = await ethers.getContract('StakeRegistry', redistributor);
      await stakeRegistryRedistributor.freezeDeposit(overlay_0, freezeTime);

      const staked = await stakeRegistryRedistributor.stakes(overlay_0);
      const updatedBlockNumber = (await getBlockNumber()) + 3;

      expect(staked.lastUpdatedBlockNumber).to.be.eq(updatedBlockNumber);
    });

    it('should not allow update of a frozen staked deposit', async function () {
      const stakeRegistryRedistributor = await ethers.getContract('StakeRegistry', redistributor);
      await stakeRegistryRedistributor.freezeDeposit(overlay_0, freezeTime);

      const staked = await stakeRegistryRedistributor.stakes(overlay_0);
      const updatedBlockNumber = (await getBlockNumber()) + 3;

      expect(staked.lastUpdatedBlockNumber).to.be.eq(updatedBlockNumber);

      await mintAndApprove(staker_0, stakeRegistry.address, stakeAmount_0);
      await expect(stakeRegistry.depositStake(staker_0, nonce_0, stakeAmount_0)).to.be.revertedWith(
        errors.freeze.currentlyFrozen
      );

      mineNBlocks(3);

      // should this be +2 ?!
      const newUpdatedBlockNumber = (await getBlockNumber()) + 2;
      await expect(stakeRegistry.depositStake(staker_0, nonce_0, stakeAmount_0))
        .to.emit(stakeRegistry, 'StakeUpdated')
        .withArgs(overlay_0, twice_stakeAmount_0, staker_0, newUpdatedBlockNumber);
    });

    // should we emit an event here?
    // ...
  });

  describe('pause contract', function () {
    beforeEach(async function () {
      token = await ethers.getContract('TestToken', deployer);
      stakeRegistry = await ethers.getContract('StakeRegistry');
      await deployments.fixture();

      await mintAndApprove(staker_0, stakeRegistry.address, stakeAmount_0);
      await stakeRegistry.depositStake(staker_0, nonce_0, stakeAmount_0);

      const stakeRegistryDeployer = await ethers.getContract('StakeRegistry', deployer);
      const pauserRole = await stakeRegistryDeployer.PAUSER_ROLE();
      await stakeRegistryDeployer.grantRole(pauserRole, pauser);
    });

    it('should not pause contract without pauser role', async function () {
      const stakeRegistryStaker1 = await ethers.getContract('StakeRegistry', staker_1);
      await expect(stakeRegistryStaker1.pause()).to.be.revertedWith(errors.pause.noRole);
    });

    it('should pause contract with pauser role', async function () {
      const stakeRegistryPauser = await ethers.getContract('StakeRegistry', pauser);
      await stakeRegistryPauser.pause();

      await mintAndApprove(staker_0, stakeRegistry.address, stakeAmount_0);
      await expect(stakeRegistry.depositStake(staker_0, nonce_0, stakeAmount_0)).to.be.revertedWith(
        errors.pause.currentlyPaused
      );
    });

    it('should not unpause contract without pauser role', async function () {
      const stakeRegistryPauser = await ethers.getContract('StakeRegistry', pauser);
      await stakeRegistryPauser.pause();

      const stakeRegistryStaker1 = await ethers.getContract('StakeRegistry', staker_1);
      await expect(stakeRegistryStaker1.unPause()).to.be.revertedWith(errors.pause.onlyPauseCanUnPause);
    });

    it('should not allow staking while paused', async function () {
      const stakeRegistryPauser = await ethers.getContract('StakeRegistry', pauser);
      await stakeRegistryPauser.pause();

      await mintAndApprove(staker_0, stakeRegistry.address, stakeAmount_0);
      await expect(stakeRegistry.depositStake(staker_0, nonce_0, stakeAmount_0)).to.be.revertedWith(
        errors.pause.currentlyPaused
      );
    });

    it('should allow staking once unpaused', async function () {
      const stakeRegistryPauser = await ethers.getContract('StakeRegistry', pauser);
      await stakeRegistryPauser.pause();

      await mintAndApprove(staker_0, stakeRegistry.address, stakeAmount_0);
      await expect(stakeRegistry.depositStake(staker_0, nonce_0, stakeAmount_0)).to.be.revertedWith(
        errors.pause.currentlyPaused
      );

      await stakeRegistryPauser.unPause();

      const newUpdatedBlockNumber = (await getBlockNumber()) + 3;
      await mintAndApprove(staker_0, stakeRegistry.address, updateStakeAmount);
      await expect(stakeRegistry.depositStake(staker_0, nonce_0, updateStakeAmount))
        .to.emit(stakeRegistry, 'StakeUpdated')
        .withArgs(overlay_0, updatedStakeAmount, staker_0, newUpdatedBlockNumber);
    });

    // it('should allow stake withdrawal while paused', async function () {});

    // it('should not allow stake withdrawal while unpaused', async function () {});
  });
});
