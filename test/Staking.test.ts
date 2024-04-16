import { expect } from './util/chai';
import { ethers, deployments, getNamedAccounts } from 'hardhat';
import { Contract } from 'ethers';
import { mineNBlocks, getBlockNumber } from './util/tools';

const { read, execute } = deployments;
let deployer: string;
let redistributor: string;
let pauser: string;

const zeroAddress = '0x0000000000000000000000000000000000000000';
const zeroBytes32 = '0x0000000000000000000000000000000000000000000000000000000000000000';

const freezeTime = 3;

const errors = {
  deposit: {
    noBalance: 'ERC20: insufficient allowance',
    noZeroAddress: 'owner cannot be the zero address',
    belowMinimum: 'cannot be below the minimum stake value',
    onlyOwner: 'Unauthorized()',
  },
  slash: {
    noRole: 'OnlyRedistributor()',
  },
  freeze: {
    noRole: 'OnlyRedistributor()',
    currentlyFrozen: 'Frozen()',
  },
  pause: {
    noRole: 'OnlyPauser()',
    currentlyPaused: 'Pausable: paused',
    notCurrentlyPaused: 'Pausable: not paused',
    onlyPauseCanUnPause: 'OnlyPauser()',
  },
};

let staker_0: string;
const overlay_0 = '0xa602fa47b3e8ce39ffc2017ad9069ff95eb58c051b1cfa2b0d86bc44a5433733';
const stakeAmount_0 = '10000000000000000';
const updateStakeAmount = '633633';
const updatedStakeAmount = '10000000000633633';
const twice_stakeAmount_0 = '20000000000000000';
const nonce_0 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';

const zeroStake = '0';
const zeroAmount = '0';

// Before the tests, set named accounts and read deployments.
before(async function () {
  const namedAccounts = await getNamedAccounts();
  deployer = namedAccounts.deployer;
  redistributor = namedAccounts.redistributor;
  pauser = namedAccounts.pauser;
  staker_0 = namedAccounts.node_0;
});

let stakeRegistry: Contract;
let token: Contract;

async function mintAndApprove(payee: string, beneficiary: string, transferAmount: string) {
  const minterTokenInstance = await ethers.getContract('TestToken', deployer);
  await minterTokenInstance.mint(payee, transferAmount);
  const payeeTokenInstance = await ethers.getContract('TestToken', payee);
  await payeeTokenInstance.approve(beneficiary, transferAmount);
}

describe('Staking', function () {
  describe('when deploying contract', function () {
    beforeEach(async function () {
      await deployments.fixture();
      stakeRegistry = await ethers.getContract('StakeRegistry');

      const pauserRole = await read('StakeRegistry', 'PAUSER_ROLE');
      await execute('StakeRegistry', { from: deployer }, 'grantRole', pauserRole, pauser);
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
  });

  describe('depositing stake', function () {
    beforeEach(async function () {
      await deployments.fixture();
      token = await ethers.getContract('TestToken', deployer);
      stakeRegistry = await ethers.getContract('StakeRegistry', staker_0);
    });

    it('should not deposit stake if funds are unavailable', async function () {
      await expect(stakeRegistry.depositStake(staker_0, nonce_0, stakeAmount_0)).to.be.revertedWith(
        errors.deposit.noBalance
      );
    });

    it('only owner can deposit stake', async function () {
      const owner = zeroAddress;

      await mintAndApprove(staker_0, stakeRegistry.address, stakeAmount_0);

      await expect(stakeRegistry.depositStake(owner, nonce_0, stakeAmount_0)).to.be.revertedWith(
        errors.deposit.onlyOwner
      );
    });

    it('should deposit stake correctly if funds are available', async function () {
      const sr_staker_0 = await ethers.getContract('StakeRegistry', staker_0);

      const updatedBlockNumber = (await getBlockNumber()) + 3;

      await mintAndApprove(staker_0, stakeRegistry.address, stakeAmount_0);
      expect(await token.balanceOf(staker_0)).to.be.eq(stakeAmount_0);

      await expect(sr_staker_0.depositStake(staker_0, nonce_0, stakeAmount_0))
        .to.emit(stakeRegistry, 'StakeUpdated')
        .withArgs(staker_0, stakeAmount_0, overlay_0, updatedBlockNumber);

      expect(await token.balanceOf(staker_0)).to.be.eq(0);

      const staked = await sr_staker_0.stakes(staker_0);
      expect(staked.overlay).to.be.eq(overlay_0);
      expect(staked.owner).to.be.eq(staker_0);
      expect(staked.stakeAmount).to.be.eq(stakeAmount_0);
      expect(staked.lastUpdatedBlockNumber).to.be.eq(updatedBlockNumber);

      expect(await token.balanceOf(stakeRegistry.address)).to.be.eq(stakeAmount_0);
    });

    it('should update stake correctly if funds are available', async function () {
      const sr_staker_0 = await ethers.getContract('StakeRegistry', staker_0);

      await mintAndApprove(staker_0, stakeRegistry.address, stakeAmount_0);
      expect(await token.balanceOf(staker_0)).to.be.eq(stakeAmount_0);

      sr_staker_0.depositStake(staker_0, nonce_0, stakeAmount_0);

      const lastUpdatedBlockNumber = (await getBlockNumber()) + 3;

      await mintAndApprove(staker_0, stakeRegistry.address, updateStakeAmount);
      expect(await token.balanceOf(staker_0)).to.be.eq(updateStakeAmount);

      await expect(sr_staker_0.depositStake(staker_0, nonce_0, updateStakeAmount))
        .to.emit(stakeRegistry, 'StakeUpdated')
        .withArgs(staker_0, updatedStakeAmount, overlay_0, lastUpdatedBlockNumber + 1);

      const staked = await stakeRegistry.stakes(staker_0);
      expect(staked.overlay).to.be.eq(overlay_0);
      expect(staked.owner).to.be.eq(staker_0);
      expect(staked.stakeAmount).to.be.eq(updatedStakeAmount);
      expect(staked.lastUpdatedBlockNumber).to.be.eq(lastUpdatedBlockNumber + 1);

      expect(await token.balanceOf(stakeRegistry.address)).to.be.eq(updatedStakeAmount);
    });
  });

  describe('slashing stake', function () {
    beforeEach(async function () {
      await deployments.fixture();
      token = await ethers.getContract('TestToken', deployer);
      stakeRegistry = await ethers.getContract('StakeRegistry');

      const sr_staker_0 = await ethers.getContract('StakeRegistry', staker_0);

      await mintAndApprove(staker_0, stakeRegistry.address, stakeAmount_0);
      await sr_staker_0.depositStake(staker_0, nonce_0, stakeAmount_0);

      const stakeRegistryDeployer = await ethers.getContract('StakeRegistry', deployer);
      const redistributorRole = await stakeRegistryDeployer.REDISTRIBUTOR_ROLE();
      await stakeRegistryDeployer.grantRole(redistributorRole, redistributor);
    });

    it('should not slash staked deposit without redistributor role', async function () {
      const stakeRegistry = await ethers.getContract('StakeRegistry', staker_0);
      await expect(stakeRegistry.slashDeposit(staker_0, stakeAmount_0)).to.be.revertedWith(errors.slash.noRole);
    });

    it('should slash staked deposit with redistributor role', async function () {
      const stakeRegistryRedistributor = await ethers.getContract('StakeRegistry', redistributor);

      await stakeRegistryRedistributor.slashDeposit(staker_0, stakeAmount_0);

      const staked = await stakeRegistry.stakes(staker_0);
      expect(staked.overlay).to.be.eq(zeroBytes32);
      expect(staked.owner).to.be.eq(zeroAddress);
      expect(staked.stakeAmount).to.be.eq(0);
      expect(staked.lastUpdatedBlockNumber).to.be.eq(0);
    });

    it('should restake slashed deposit', async function () {
      const stakeRegistryRedistributor = await ethers.getContract('StakeRegistry', redistributor);

      await stakeRegistryRedistributor.slashDeposit(staker_0, stakeAmount_0);

      const sr_staker_0 = await ethers.getContract('StakeRegistry', staker_0);

      await mintAndApprove(staker_0, stakeRegistry.address, stakeAmount_0);
      await sr_staker_0.depositStake(staker_0, nonce_0, stakeAmount_0);

      const lastUpdatedBlockNumber = await getBlockNumber();
      const staked = await stakeRegistry.stakes(staker_0);
      expect(staked.overlay).to.be.eq(overlay_0);
      expect(staked.owner).to.be.eq(staker_0);
      expect(staked.stakeAmount).to.be.eq(stakeAmount_0);
      expect(staked.lastUpdatedBlockNumber).to.be.eq(lastUpdatedBlockNumber);
    });
  });

  describe('freezing stake', function () {
    let sr_staker_0: Contract;

    beforeEach(async function () {
      await deployments.fixture();
      token = await ethers.getContract('TestToken', deployer);
      stakeRegistry = await ethers.getContract('StakeRegistry');

      sr_staker_0 = await ethers.getContract('StakeRegistry', staker_0);

      await mintAndApprove(staker_0, stakeRegistry.address, stakeAmount_0);
      await sr_staker_0.depositStake(staker_0, nonce_0, stakeAmount_0);

      const stakeRegistryDeployer = await ethers.getContract('StakeRegistry', deployer);
      const redistributorRole = await stakeRegistryDeployer.REDISTRIBUTOR_ROLE();
      await stakeRegistryDeployer.grantRole(redistributorRole, redistributor);
    });

    it('should not freeze staked deposit without redistributor role', async function () {
      const stakeRegistryStaker1 = await ethers.getContract('StakeRegistry', staker_0);
      await expect(stakeRegistryStaker1.freezeDeposit(staker_0, freezeTime)).to.be.revertedWith(errors.freeze.noRole);
    });

    it('should freeze staked deposit with redistributor role', async function () {
      const stakeRegistryRedistributor = await ethers.getContract('StakeRegistry', redistributor);

      await expect(stakeRegistryRedistributor.freezeDeposit(staker_0, freezeTime))
        .to.emit(stakeRegistry, 'StakeFrozen')
        .withArgs(staker_0, overlay_0, freezeTime);

      const staked = await stakeRegistryRedistributor.stakes(staker_0);
      const updatedBlockNumber = (await getBlockNumber()) + 3;

      expect(staked.lastUpdatedBlockNumber).to.be.eq(updatedBlockNumber);
    });

    it('should not allow update of a frozen staked deposit', async function () {
      const stakeRegistryRedistributor = await ethers.getContract('StakeRegistry', redistributor);
      await stakeRegistryRedistributor.freezeDeposit(staker_0, freezeTime);

      const staked = await stakeRegistryRedistributor.stakes(staker_0);
      const updatedBlockNumber = (await getBlockNumber()) + 3;

      expect(staked.lastUpdatedBlockNumber).to.be.eq(updatedBlockNumber);

      await mintAndApprove(staker_0, stakeRegistry.address, stakeAmount_0);
      await expect(sr_staker_0.depositStake(staker_0, nonce_0, stakeAmount_0)).to.be.revertedWith(
        errors.freeze.currentlyFrozen
      );

      mineNBlocks(3);

      const newUpdatedBlockNumber = (await getBlockNumber()) + 2;
      await expect(sr_staker_0.depositStake(staker_0, nonce_0, stakeAmount_0))
        .to.emit(stakeRegistry, 'StakeUpdated')
        .withArgs(staker_0, twice_stakeAmount_0, overlay_0, newUpdatedBlockNumber);
    });
  });

  describe('pause contract', function () {
    let sr_staker_0: Contract;

    beforeEach(async function () {
      await deployments.fixture();
      token = await ethers.getContract('TestToken', deployer);
      stakeRegistry = await ethers.getContract('StakeRegistry');

      sr_staker_0 = await ethers.getContract('StakeRegistry', staker_0);

      await mintAndApprove(staker_0, stakeRegistry.address, stakeAmount_0);
      await sr_staker_0.depositStake(staker_0, nonce_0, stakeAmount_0);

      const stakeRegistryDeployer = await ethers.getContract('StakeRegistry', deployer);
      const pauserRole = await stakeRegistryDeployer.PAUSER_ROLE();
      await stakeRegistryDeployer.grantRole(pauserRole, pauser);
    });

    it('should not pause contract without pauser role', async function () {
      const stakeRegistryStaker1 = await ethers.getContract('StakeRegistry', staker_0);
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

      const stakeRegistryStaker1 = await ethers.getContract('StakeRegistry', staker_0);
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

      await expect(sr_staker_0.depositStake(staker_0, nonce_0, stakeAmount_0)).to.be.revertedWith(
        errors.pause.currentlyPaused
      );

      await stakeRegistryPauser.unPause();

      const newUpdatedBlockNumber = (await getBlockNumber()) + 3;
      await mintAndApprove(staker_0, stakeRegistry.address, updateStakeAmount);
      await expect(sr_staker_0.depositStake(staker_0, nonce_0, updateStakeAmount))
        .to.emit(stakeRegistry, 'StakeUpdated')
        .withArgs(staker_0, updatedStakeAmount, overlay_0, newUpdatedBlockNumber);
    });
  });

  describe('withdraw from contract', function () {
    let sr_staker_0: Contract;
    let updatedBlockNumber: number;

    beforeEach(async function () {
      await deployments.fixture();
      token = await ethers.getContract('TestToken', deployer);
      stakeRegistry = await ethers.getContract('StakeRegistry');

      sr_staker_0 = await ethers.getContract('StakeRegistry', staker_0);

      await mintAndApprove(staker_0, stakeRegistry.address, stakeAmount_0);
      await sr_staker_0.depositStake(staker_0, nonce_0, stakeAmount_0);

      updatedBlockNumber = await getBlockNumber();

      const stakeRegistryDeployer = await ethers.getContract('StakeRegistry', deployer);
      const pauserRole = await stakeRegistryDeployer.PAUSER_ROLE();
      await stakeRegistryDeployer.grantRole(pauserRole, pauser);
    });

    it('should not allow stake withdrawal while unpaused', async function () {
      await mintAndApprove(staker_0, stakeRegistry.address, stakeAmount_0);
      await sr_staker_0.depositStake(staker_0, nonce_0, stakeAmount_0);

      await expect(sr_staker_0.withdrawFromStake(staker_0, stakeAmount_0)).to.be.revertedWith(
        errors.pause.notCurrentlyPaused
      );
    });

    it('should allow stake withdrawal while paused', async function () {
      const staked_before = await sr_staker_0.stakes(staker_0);

      expect(staked_before.overlay).to.be.eq(overlay_0);
      expect(staked_before.owner).to.be.eq(staker_0);
      expect(staked_before.stakeAmount).to.be.eq(stakeAmount_0);
      expect(staked_before.lastUpdatedBlockNumber).to.be.eq(updatedBlockNumber);

      const stakeRegistryPauser = await ethers.getContract('StakeRegistry', pauser);
      await stakeRegistryPauser.pause();

      expect(await token.balanceOf(staker_0)).to.be.eq(zeroAmount);

      await sr_staker_0.withdrawFromStake(staker_0, stakeAmount_0);

      const staked_after = await sr_staker_0.stakes(staker_0);

      expect(await token.balanceOf(staker_0)).to.be.eq(stakeAmount_0);

      expect(staked_after.overlay).to.be.eq(zeroBytes32);
      expect(staked_after.owner).to.be.eq(zeroAddress);
      expect(staked_after.stakeAmount).to.be.eq(zeroStake);
      expect(staked_after.lastUpdatedBlockNumber).to.be.eq(0);

      await stakeRegistryPauser.unPause();
    });
  });
});
