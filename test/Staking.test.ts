import { expect } from './util/chai';
import { ethers, deployments, getNamedAccounts } from 'hardhat';
import { Contract } from 'ethers';
import { mineNBlocks } from './util/tools';

const { read, execute } = deployments;

let deployer: string;
let redistributor: string;
let pauser: string;
let staker_0: string;
let staker_1: string;

const roundLength = 152;
const zeroBytes32 = '0x0000000000000000000000000000000000000000000000000000000000000000';
const freezeTime = 3;

const errors = {
  deposit: {
    noBalance: 'ERC20: insufficient allowance',
    belowMinimum: 'BelowMinimumStake()',
    heightDecrease: 'HeightDecreaseNotAllowed()',
  },
  withdraw: {
    invalid: 'InvalidWithdrawalAmount()',
    notStaked: 'NotStaked()',
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

const overlay_0 = '0xa602fa47b3e8ce39ffc2017ad9069ff95eb58c051b1cfa2b0d86bc44a5433733';
const overlay_1 = '0xa6f955c72d7053f96b91b5470491a0c732b0175af56dcfb7a604b82b16719406';
const overlay_1_n_25 = '0x676766bbae530fd0483e4734e800569c95929b707b9c50f8717dc99f9f91e915';
const nonce_0 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';
const nonce_1 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';
const nonce_1_n_25 = '0x00000000000000000000000000000000000000000000000000000000000325dd';
const stakeAmount_0 = '100000000000000000';
const doubleStakeAmount_0 = '200000000000000000';
const stakeAmount_1 = '100000000000000000';
const updateStakeAmount_0 = '633633';
const updatedStakeAmount_0 = '100000000000633633';
const withdrawAmount = '100000000000000000';
const slashAmount = '50000000000000000';
const partialSlashBalance = '50000000000000000';
const height_0 = 0;
const height_0_n_1 = 1;
const height_1 = 0;
const height_1_n_1 = 1;

before(async function () {
  const namedAccounts = await getNamedAccounts();
  deployer = namedAccounts.deployer;
  redistributor = namedAccounts.redistributor;
  pauser = namedAccounts.pauser;
  staker_0 = namedAccounts.node_0;
  staker_1 = namedAccounts.node_1;
});

let stakeRegistry: Contract;
let token: Contract;

async function mintAndApprove(payee: string, beneficiary: string, transferAmount: string) {
  const minterTokenInstance = await ethers.getContract('TestToken', deployer);
  await minterTokenInstance.mint(payee, transferAmount);
  const payeeTokenInstance = await ethers.getContract('TestToken', payee);
  await payeeTokenInstance.approve(beneficiary, transferAmount);
}

async function advanceRounds(rounds = 2) {
  await mineNBlocks(roundLength * rounds);
}

async function activateStake(contract: Contract, owner: string, nonce: string, amount: string, height: number) {
  await mintAndApprove(owner, contract.address, amount);
  await contract.manageStake(nonce, amount, height);
  await advanceRounds();
  await contract.applyUpdates(owner);
}

describe('Staking', function () {
  beforeEach(async function () {
    await deployments.fixture();
    token = await ethers.getContract('TestToken', deployer);
    stakeRegistry = await ethers.getContract('StakeRegistry');

    const pauserRole = await read('StakeRegistry', 'DEFAULT_ADMIN_ROLE');
    await execute('StakeRegistry', { from: deployer }, 'grantRole', pauserRole, pauser);
  });

  it('should deploy StakeRegistry with queue wait parameters', async function () {
    expect(stakeRegistry.address).to.be.properAddress;
    expect(await stakeRegistry.WAIT_BASE()).to.be.eq(2);
    expect(await stakeRegistry.WAIT_OVERLAY_CHANGE()).to.be.eq(2);
    expect(await stakeRegistry.WAIT_WITHDRAWAL()).to.be.eq(2);
  });

  it('should schedule a new deposit and activate it after the base delay', async function () {
    const srStaker0 = await ethers.getContract('StakeRegistry', staker_0);
    const currentRound = await srStaker0.currentRound();

    await mintAndApprove(staker_0, srStaker0.address, stakeAmount_0);
    await expect(srStaker0.manageStake(nonce_0, stakeAmount_0, height_0))
      .to.emit(srStaker0, 'Deposit')
      .withArgs(staker_0, currentRound.add(2), stakeAmount_0);

    await advanceRounds();
    expect(await srStaker0.nodeEffectiveStake(staker_0)).to.be.eq(stakeAmount_0);
  });

  it('should keep a scheduled deposit inactive until the delay elapses', async function () {
    const srStaker0 = await ethers.getContract('StakeRegistry', staker_0);
    const currentRound = await srStaker0.currentRound();

    await mintAndApprove(staker_0, srStaker0.address, stakeAmount_0);
    await expect(srStaker0.manageStake(nonce_0, stakeAmount_0, height_0))
      .to.emit(srStaker0, 'ServiceCommitmentUpdate')
      .withArgs(staker_0, currentRound.add(2), overlay_0, height_0);

    expect(await srStaker0.nodeEffectiveStake(staker_0)).to.be.eq(0);
    expect(await srStaker0.overlayOfAddress(staker_0)).to.be.eq(zeroBytes32);

    await advanceRounds();

    expect(await srStaker0.nodeEffectiveStake(staker_0)).to.be.eq(stakeAmount_0);
    expect(await srStaker0.overlayOfAddress(staker_0)).to.be.eq(overlay_0);
    expect((await srStaker0.stakes(staker_0)).balance).to.be.eq(stakeAmount_0);
    expect(await srStaker0.lastUpdatedBlockNumberOfAddress(staker_0)).to.be.eq(0);

    await srStaker0.applyUpdates(staker_0);
    expect(await srStaker0.lastUpdatedBlockNumberOfAddress(staker_0)).to.not.be.eq(0);
  });

  it('should not allow first stake below minimum for the requested height', async function () {
    const srStaker1 = await ethers.getContract('StakeRegistry', staker_1);
    await mintAndApprove(staker_1, srStaker1.address, stakeAmount_1);

    await expect(srStaker1.manageStake(nonce_1, stakeAmount_1, height_1_n_1)).to.be.revertedWith(
      errors.deposit.belowMinimum
    );
  });

  it('should schedule top ups and height increases without changing the active stake immediately', async function () {
    const srStaker0 = await ethers.getContract('StakeRegistry', staker_0);
    await activateStake(srStaker0, staker_0, nonce_0, stakeAmount_0, height_0);

    await mintAndApprove(staker_0, srStaker0.address, updateStakeAmount_0);
    await srStaker0.manageStake(nonce_0, updateStakeAmount_0, height_0_n_1);

    expect((await srStaker0.stakes(staker_0)).balance).to.be.eq(stakeAmount_0);
    expect(await srStaker0.heightOfAddress(staker_0)).to.be.eq(height_0);

    await advanceRounds();

    expect((await srStaker0.stakes(staker_0)).balance).to.be.eq(updatedStakeAmount_0);
    expect(await srStaker0.heightOfAddress(staker_0)).to.be.eq(height_0_n_1);
  });

  it('should schedule overlay changes and expose them after the overlay delay', async function () {
    const srStaker1 = await ethers.getContract('StakeRegistry', staker_1);
    await activateStake(srStaker1, staker_1, nonce_1, stakeAmount_1, height_1);

    await srStaker1.manageStake(nonce_1_n_25, 0, height_1);
    expect(await srStaker1.overlayOfAddress(staker_1)).to.be.eq(overlay_1);

    await advanceRounds();
    expect(await srStaker1.overlayOfAddress(staker_1)).to.be.eq(overlay_1_n_25);
  });

  it('should reject height decreases on active stake', async function () {
    const srStaker0 = await ethers.getContract('StakeRegistry', staker_0);
    await activateStake(srStaker0, staker_0, nonce_0, doubleStakeAmount_0, height_0_n_1);

    await expect(srStaker0.manageStake(nonce_0, 0, height_0)).to.be.revertedWith(errors.deposit.heightDecrease);
  });

  it('should keep effective stake equal to balance after oracle price changes', async function () {
    const srStaker0 = await ethers.getContract('StakeRegistry', staker_0);
    await activateStake(srStaker0, staker_0, nonce_0, stakeAmount_0, height_0);

    const priceOracle = await ethers.getContract('PriceOracle', deployer);
    await priceOracle.setPrice(24000);
    await mineNBlocks(1);

    expect(await srStaker0.nodeEffectiveStake(staker_0)).to.be.eq(stakeAmount_0);
  });

  it('should schedule withdrawals and transfer tokens on applyUpdates', async function () {
    const srStaker0 = await ethers.getContract('StakeRegistry', staker_0);
    await activateStake(srStaker0, staker_0, nonce_0, doubleStakeAmount_0, height_0);

    await expect(srStaker0.withdraw(withdrawAmount)).to.emit(srStaker0, 'Withdrawal');
    expect(await token.balanceOf(staker_0)).to.be.eq(0);
    expect(await srStaker0.nodeEffectiveStake(staker_0)).to.be.eq(doubleStakeAmount_0);

    await advanceRounds();

    expect(await srStaker0.nodeEffectiveStake(staker_0)).to.be.eq(stakeAmount_0);
    expect(await token.balanceOf(staker_0)).to.be.eq(0);

    await srStaker0.applyUpdates(staker_0);
    expect(await token.balanceOf(staker_0)).to.be.eq(withdrawAmount);
    expect((await srStaker0.stakes(staker_0)).balance).to.be.eq(stakeAmount_0);
  });

  it('should schedule exits and clear the stake on applyUpdates', async function () {
    const srStaker0 = await ethers.getContract('StakeRegistry', staker_0);
    await activateStake(srStaker0, staker_0, nonce_0, stakeAmount_0, height_0);

    await expect(srStaker0.exit()).to.emit(srStaker0, 'Withdrawal');

    await advanceRounds();
    expect(await srStaker0.nodeEffectiveStake(staker_0)).to.be.eq(0);
    expect(await token.balanceOf(staker_0)).to.be.eq(0);

    await srStaker0.applyUpdates(staker_0);
    const stakedAfter = await srStaker0.stakes(staker_0);
    expect(await token.balanceOf(staker_0)).to.be.eq(stakeAmount_0);
    expect(stakedAfter.overlay).to.be.eq(zeroBytes32);
    expect(stakedAfter.balance).to.be.eq(0);
    expect(await srStaker0.lastUpdatedBlockNumberOfAddress(staker_0)).to.be.eq(0);
  });

  it('should not allow invalid withdrawals', async function () {
    const srStaker0 = await ethers.getContract('StakeRegistry', staker_0);
    await expect(srStaker0.withdraw(0)).to.be.revertedWith(errors.withdraw.invalid);
    await expect(srStaker0.exit()).to.be.revertedWith(errors.withdraw.notStaked);
  });

  it('should freeze active stake and block mutations until the freeze expires', async function () {
    const srStaker0 = await ethers.getContract('StakeRegistry', staker_0);
    await activateStake(srStaker0, staker_0, nonce_0, stakeAmount_0, height_0);

    const stakeRegistryDeployer = await ethers.getContract('StakeRegistry', deployer);
    const redistributorRole = await stakeRegistryDeployer.REDISTRIBUTOR_ROLE();
    await stakeRegistryDeployer.grantRole(redistributorRole, redistributor);

    const stakeRegistryRedistributor = await ethers.getContract('StakeRegistry', redistributor);
    await expect(stakeRegistryRedistributor.freezeDeposit(staker_0, freezeTime))
      .to.emit(srStaker0, 'StakeFrozen')
      .withArgs(staker_0, overlay_0, freezeTime);

    expect(await srStaker0.nodeEffectiveStake(staker_0)).to.be.eq(0);

    await mintAndApprove(staker_0, srStaker0.address, updateStakeAmount_0);
    await expect(srStaker0.manageStake(nonce_0, updateStakeAmount_0, height_0)).to.be.revertedWith(
      errors.freeze.currentlyFrozen
    );

    await mineNBlocks(freezeTime + 1);
    await expect(srStaker0.manageStake(nonce_0, updateStakeAmount_0, height_0)).to.not.be.reverted;
  });

  it('should slash active stake balances', async function () {
    const srStaker0 = await ethers.getContract('StakeRegistry', staker_0);
    await activateStake(srStaker0, staker_0, nonce_0, stakeAmount_0, height_0);

    const stakeRegistryDeployer = await ethers.getContract('StakeRegistry', deployer);
    const redistributorRole = await stakeRegistryDeployer.REDISTRIBUTOR_ROLE();
    await stakeRegistryDeployer.grantRole(redistributorRole, redistributor);

    const stakeRegistryRedistributor = await ethers.getContract('StakeRegistry', redistributor);
    await expect(stakeRegistryRedistributor.slashDeposit(staker_0, slashAmount))
      .to.emit(srStaker0, 'StakeSlashed')
      .withArgs(staker_0, overlay_0, slashAmount);

    expect((await srStaker0.stakes(staker_0)).balance).to.be.eq(partialSlashBalance);

    await stakeRegistryRedistributor.slashDeposit(staker_0, partialSlashBalance);
    expect((await srStaker0.stakes(staker_0)).balance).to.be.eq(0);
    expect(await srStaker0.lastUpdatedBlockNumberOfAddress(staker_0)).to.be.eq(0);
  });

  it('should not allow stake migration while unpaused and should include queued deposits when paused', async function () {
    const srStaker0 = await ethers.getContract('StakeRegistry', staker_0);
    await mintAndApprove(staker_0, srStaker0.address, stakeAmount_0);
    await srStaker0.manageStake(nonce_0, stakeAmount_0, height_0);

    await expect(srStaker0.migrateStake()).to.be.revertedWith(errors.pause.notCurrentlyPaused);

    const stakeRegistryPauser = await ethers.getContract('StakeRegistry', pauser);
    await stakeRegistryPauser.pause();
    await srStaker0.migrateStake();

    expect(await token.balanceOf(staker_0)).to.be.eq(stakeAmount_0);
    expect((await srStaker0.stakes(staker_0)).balance).to.be.eq(0);
  });

  it('should not allow staking while paused and should allow it again after unpause', async function () {
    const srStaker0 = await ethers.getContract('StakeRegistry', staker_0);
    const stakeRegistryPauser = await ethers.getContract('StakeRegistry', pauser);

    await stakeRegistryPauser.pause();
    await mintAndApprove(staker_0, srStaker0.address, stakeAmount_0);
    await expect(srStaker0.manageStake(nonce_0, stakeAmount_0, height_0)).to.be.revertedWith(
      errors.pause.currentlyPaused
    );

    await stakeRegistryPauser.unPause();
    await expect(srStaker0.manageStake(nonce_0, stakeAmount_0, height_0)).to.not.be.reverted;
  });
});
