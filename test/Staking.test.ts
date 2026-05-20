import { expect } from './util/chai';
import { ethers, deployments, getNamedAccounts } from 'hardhat';
import { BigNumber, Contract, ContractTransaction, Event } from 'ethers';
import { mineNBlocks } from './util/tools';

const { read, execute } = deployments;

let deployer: string;
let redistributor: string;
let pauser: string;
let staker_0: string;
let staker_1: string;

/** Blocks per staking round; overwritten from `StakeRegistry.ROUND_LENGTH()` after fixture load. */
let roundLength = 152;
const zeroBytes32 = '0x0000000000000000000000000000000000000000000000000000000000000000';
const freezeTime = 3;

const errors = {
  deposit: {
    noBalance: 'ERC20: insufficient allowance',
    belowMinimum: 'BelowMinimumStake',
    heightDecrease: 'HeightDecreaseNotAllowed()',
  },
  withdraw: {
    invalidWithdrawalAmountZero: 'InvalidWithdrawalAmount(0)',
    invalidWithdrawalAmountExceedsBalance: 'InvalidWithdrawalAmount(1)',
    notStaked: 'NotStaked()',
  },
  slash: {
    noRole: 'OnlyRedistributor()',
    invalidAmount: 'InvalidAmount()',
  },
  freeze: {
    noRole: 'OnlyRedistributor()',
  },
  pause: {
    noRole: 'Unauthorized()',
    currentlyPaused: 'Pausable: paused',
    notCurrentlyPaused: 'Pausable: not paused',
    onlyPauseCanUnPause: 'Unauthorized()',
  },
  general: {
    overlayUnchanged: 'OverlayUnchanged()',
    frozenWithdrawal: 'FrozenWithdrawal()',
    queueFull: 'UpdateQueueFull',
    queueClosed: 'QueueClosed()',
    invalidWaitConfig: 'InvalidWaitConfiguration',
  },
};

const overlay_0 = '0xa602fa47b3e8ce39ffc2017ad9069ff95eb58c051b1cfa2b0d86bc44a5433733';
const overlay_1 = '0xa6f955c72d7053f96b91b5470491a0c732b0175af56dcfb7a604b82b16719406';
const overlay_1_n_25 = '0x676766bbae530fd0483e4734e800569c95929b707b9c50f8717dc99f9f91e915';
const nonce_0 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';
const nonce_1_n_25 = '0x00000000000000000000000000000000000000000000000000000000000325dd';
const obfuscatedHash_0 = nonce_0;
const stakeAmount_0 = '100000000000000000';
const doubleStakeAmount_0 = '200000000000000000';
const tripleStakeAmount_0 = '300000000000000000';
const withdrawAmount = stakeAmount_0;
const doubleWithdrawAmount = doubleStakeAmount_0;
const slashAmount = '50000000000000000';
const doubleSlashAmount = doubleStakeAmount_0;
const partialSlashBalance = slashAmount;
const height_0 = 0;
const height_0_n_1 = 1;

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

async function advanceToRoundCommitPhase(redistribution: Contract, targetRound: BigNumber) {
  while (true) {
    const currentRound = await redistribution.currentRound();
    const inCommitPhase = await redistribution.currentPhaseCommit();
    if (currentRound.eq(targetRound) && inCommitPhase) {
      return;
    }
    await mineNBlocks(1);
  }
}

async function activateStake(contract: Contract, owner: string, nonce: string, amount: string, height: number) {
  await mintAndApprove(owner, contract.address, amount);
  await contract.createDeposit(nonce, amount, height);
  await advanceRounds();
  await contract.applyUpdates(owner);
}

async function getSignerFor(address: string) {
  const signers = await ethers.getSigners();
  const signer = signers.find((s) => s.address.toLowerCase() === address.toLowerCase());
  if (!signer) {
    throw new Error(`No unlocked signer for ${address}`);
  }
  return signer;
}

/** Effective staking round from enqueue events (ABI may expose `registeredFromRound`). */
function effectiveRoundFromEvent(ev: Event | undefined): BigNumber {
  if (!ev?.args) {
    throw new Error('expected event with args');
  }
  const args = ev.args as readonly unknown[] & {
    effectiveFromRound?: BigNumber;
    registeredFromRound?: BigNumber;
  };
  const fromNamed = args.effectiveFromRound ?? args.registeredFromRound;
  return fromNamed !== undefined ? fromNamed : (args[1] as BigNumber);
}

/** Custom errors with arguments often fail Chai `revertedWith` exact matching in waffle; match substring instead. */
async function expectRevertReasonSubstring(txPromise: Promise<ContractTransaction>, substring: string) {
  try {
    await txPromise;
    expect.fail(`expected revert containing ${substring}`);
  } catch (e: unknown) {
    const err = e as { message?: string; error?: { message?: string } };
    const combined = `${err.message ?? ''}${err.error?.message ?? ''}`;
    expect(combined).to.include(substring);
  }
}

describe('Staking', function () {
  beforeEach(async function () {
    await deployments.fixture();
    token = await ethers.getContract('TestToken', deployer);
    stakeRegistry = await ethers.getContract('StakeRegistry');
    roundLength = (await stakeRegistry.ROUND_LENGTH()).toNumber();

    const pauserRole = await read('StakeRegistry', 'DEFAULT_ADMIN_ROLE');
    await execute('StakeRegistry', { from: deployer }, 'grantRole', pauserRole, pauser);
  });

  it('should deploy StakeRegistry with queue wait parameters', async function () {
    expect(stakeRegistry.address).to.be.properAddress;
    expect(await stakeRegistry.ROUND_LENGTH()).to.be.eq(roundLength);
    expect(await stakeRegistry.WAIT_BASE()).to.be.eq(2);
    expect(await stakeRegistry.WAIT_OVERLAY_CHANGE()).to.be.eq(2);
    expect(await stakeRegistry.WAIT_WITHDRAWAL()).to.be.eq(2);
  });

  it('should schedule a new deposit and activate it after the base delay', async function () {
    const srStaker0 = await ethers.getContract('StakeRegistry', staker_0);
    const currentRound = await srStaker0.currentRound();

    await mintAndApprove(staker_0, srStaker0.address, stakeAmount_0);
    await expect(srStaker0.createDeposit(nonce_0, stakeAmount_0, height_0))
      .to.emit(srStaker0, 'DepositCreated')
      .withArgs(staker_0, currentRound.add(2), stakeAmount_0, overlay_0, height_0);

    await advanceRounds();
    expect(await srStaker0.nodeEffectiveStake(staker_0)).to.be.eq(stakeAmount_0);
  });

  it('should keep a scheduled deposit inactive until the delay elapses', async function () {
    const srStaker0 = await ethers.getContract('StakeRegistry', staker_0);

    await mintAndApprove(staker_0, srStaker0.address, stakeAmount_0);
    await expect(srStaker0.createDeposit(nonce_0, stakeAmount_0, height_0))
      .to.emit(srStaker0, 'DepositCreated')
      .withArgs(staker_0, (await srStaker0.currentRound()).add(2), stakeAmount_0, overlay_0, height_0);

    expect(await srStaker0.nodeEffectiveStake(staker_0)).to.be.eq(0);
    expect(await srStaker0.overlayOfAddress(staker_0)).to.be.eq(zeroBytes32);

    await advanceRounds();

    expect(await srStaker0.nodeEffectiveStake(staker_0)).to.be.eq(stakeAmount_0);
    expect(await srStaker0.overlayOfAddress(staker_0)).to.be.eq(overlay_0);
    expect((await srStaker0.stakes(staker_0)).balance).to.be.eq(stakeAmount_0);
  });

  it('should not allow first stake below minimum for the requested height', async function () {
    const srStaker1 = await ethers.getContract('StakeRegistry', staker_1);
    await mintAndApprove(staker_1, srStaker1.address, stakeAmount_0);

    await expect(srStaker1.createDeposit(nonce_0, stakeAmount_0, height_0_n_1)).to.be.revertedWith(
      errors.deposit.belowMinimum
    );
  });

  it('should schedule top ups and height increases without changing the active stake immediately', async function () {
    const srStaker0 = await ethers.getContract('StakeRegistry', staker_0);
    await activateStake(srStaker0, staker_0, nonce_0, stakeAmount_0, height_0);

    await mintAndApprove(staker_0, srStaker0.address, stakeAmount_0);
    await expect(srStaker0.addTokens(stakeAmount_0)).to.emit(srStaker0, 'TokensAdded');
    await expect(srStaker0.increaseHeight(height_0_n_1)).to.emit(srStaker0, 'HeightIncreased');

    expect((await srStaker0.stakes(staker_0)).balance).to.be.eq(stakeAmount_0);
    expect(await srStaker0.heightOfAddress(staker_0)).to.be.eq(height_0);

    await advanceRounds();

    expect((await srStaker0.stakes(staker_0)).balance).to.be.eq(doubleStakeAmount_0);
    expect(await srStaker0.heightOfAddress(staker_0)).to.be.eq(height_0_n_1);
  });

  it('should schedule overlay changes and expose them after the overlay delay', async function () {
    const srStaker1 = await ethers.getContract('StakeRegistry', staker_1);
    await activateStake(srStaker1, staker_1, nonce_0, stakeAmount_0, height_0);

    await expect(srStaker1.changeOverlay(nonce_1_n_25)).to.emit(srStaker1, 'OverlayChanged');
    expect(await srStaker1.overlayOfAddress(staker_1)).to.be.eq(overlay_1);

    await advanceRounds();
    expect(await srStaker1.overlayOfAddress(staker_1)).to.be.eq(overlay_1_n_25);
  });

  it('should reject height decreases on active stake', async function () {
    const srStaker0 = await ethers.getContract('StakeRegistry', staker_0);
    await activateStake(srStaker0, staker_0, nonce_0, doubleStakeAmount_0, height_0_n_1);

    await expect(srStaker0.increaseHeight(height_0)).to.be.revertedWith(errors.deposit.heightDecrease);
  });

  it('should preview queued stake state with lookahead', async function () {
    const srStaker1 = await ethers.getContract('StakeRegistry', staker_1);
    await activateStake(srStaker1, staker_1, nonce_0, stakeAmount_0, height_0);

    await mintAndApprove(staker_1, srStaker1.address, stakeAmount_0);
    await srStaker1.addTokens(stakeAmount_0);
    await srStaker1.changeOverlay(nonce_1_n_25);
    await srStaker1.increaseHeight(height_0_n_1);

    expect(await srStaker1.nodeEffectiveStakeLookahead(staker_1, 1)).to.be.eq(stakeAmount_0);
    expect(await srStaker1.overlayOfAddressLookahead(staker_1, 1)).to.be.eq(overlay_1);
    expect(await srStaker1.heightOfAddressLookahead(staker_1, 1)).to.be.eq(height_0);

    expect(await srStaker1.nodeEffectiveStakeLookahead(staker_1, 2)).to.be.eq(doubleStakeAmount_0);
    expect(await srStaker1.overlayOfAddressLookahead(staker_1, 2)).to.be.eq(overlay_1_n_25);
    expect(await srStaker1.heightOfAddressLookahead(staker_1, 2)).to.be.eq(height_0_n_1);
  });

  it('should keep effective stake equal to balance after oracle price changes', async function () {
    const srStaker0 = await ethers.getContract('StakeRegistry', staker_0);
    await activateStake(srStaker0, staker_0, nonce_0, stakeAmount_0, height_0);

    const priceOracle = await ethers.getContract('PriceOracle', deployer);
    await priceOracle.setPrice(24000);
    await mineNBlocks(1);

    expect(await srStaker0.nodeEffectiveStake(staker_0)).to.be.eq(stakeAmount_0);
  });

  it('should return balance as effective stake for an unfrozen node', async function () {
    const srStaker0 = await ethers.getContract('StakeRegistry', staker_0);
    await activateStake(srStaker0, staker_0, nonce_0, stakeAmount_0, height_0);

    await mineNBlocks(1);

    const staked = await srStaker0.stakes(staker_0);
    expect(await srStaker0.nodeEffectiveStake(staker_0)).to.be.eq(staked.balance);
  });

  it('should schedule withdrawals and transfer tokens on applyUpdates', async function () {
    const srStaker0 = await ethers.getContract('StakeRegistry', staker_0);
    await activateStake(srStaker0, staker_0, nonce_0, doubleStakeAmount_0, height_0);

    await expect(srStaker0.withdraw(withdrawAmount)).to.emit(srStaker0, 'WithdrawalQueued');
    expect(await token.balanceOf(staker_0)).to.be.eq(0);
    expect(await srStaker0.nodeEffectiveStake(staker_0)).to.be.eq(doubleStakeAmount_0);

    await advanceRounds();

    expect(await srStaker0.nodeEffectiveStake(staker_0)).to.be.eq(stakeAmount_0);
    expect(await token.balanceOf(staker_0)).to.be.eq(0);

    await srStaker0.applyUpdates(staker_0);
    expect(await token.balanceOf(staker_0)).to.be.eq(withdrawAmount);
    expect((await srStaker0.stakes(staker_0)).balance).to.be.eq(stakeAmount_0);
  });

  it('should apply mature withdrawal during freeze and block future ones', async function () {
    const srStaker0 = await ethers.getContract('StakeRegistry', staker_0);
    await activateStake(srStaker0, staker_0, nonce_0, doubleStakeAmount_0, height_0);

    const stakeRegistryDeployer = await ethers.getContract('StakeRegistry', deployer);
    const redistributorRole = await stakeRegistryDeployer.REDISTRIBUTOR_ROLE();
    await stakeRegistryDeployer.grantRole(redistributorRole, redistributor);

    await srStaker0.withdraw(withdrawAmount);
    await advanceRounds();

    const stakeRegistryRedistributor = await ethers.getContract('StakeRegistry', redistributor);
    await stakeRegistryRedistributor.freezeDeposit(staker_0, freezeTime);

    expect(await token.balanceOf(staker_0)).to.be.eq(withdrawAmount);
    expect((await srStaker0.stakes(staker_0)).balance).to.be.eq(stakeAmount_0);
    expect(await srStaker0.nodeEffectiveStake(staker_0)).to.be.eq(0);

    await mineNBlocks(freezeTime + 1);

    expect(await srStaker0.nodeEffectiveStake(staker_0)).to.be.eq(stakeAmount_0);
  });

  it('should execute queued withdrawal while the node is active in the current round', async function () {
    const srStaker0 = await ethers.getContract('StakeRegistry', staker_0);
    const redistribution = await ethers.getContract('Redistribution', staker_0);
    await activateStake(srStaker0, staker_0, nonce_0, doubleStakeAmount_0, height_0);

    const withdrawalReceipt = await (await srStaker0.withdraw(withdrawAmount)).wait();
    const withdrawalEvent = withdrawalReceipt.events?.find((event: Event) => event.event === 'WithdrawalQueued');
    const effectiveRound = withdrawalEvent?.args?.effectiveFromRound ?? withdrawalEvent?.args?.[1];
    await advanceToRoundCommitPhase(redistribution, effectiveRound);

    const currentRound = await redistribution.currentRound();
    await redistribution.commit(obfuscatedHash_0, currentRound);

    await srStaker0.applyUpdates(staker_0);
    expect(await token.balanceOf(staker_0)).to.be.eq(withdrawAmount);
    expect(await srStaker0.nodeEffectiveStake(staker_0)).to.be.eq(stakeAmount_0);

    await mineNBlocks(roundLength);

    expect(await srStaker0.nodeEffectiveStake(staker_0)).to.be.eq(stakeAmount_0);
    expect(await token.balanceOf(staker_0)).to.be.eq(withdrawAmount);
  });

  it('should execute queued exit as soon as it becomes effective in the current round', async function () {
    const srStaker0 = await ethers.getContract('StakeRegistry', staker_0);
    const redistribution = await ethers.getContract('Redistribution', staker_0);
    await activateStake(srStaker0, staker_0, nonce_0, stakeAmount_0, height_0);

    const exitReceipt = await (await srStaker0.exit()).wait();
    const exitEvent = exitReceipt.events?.find((event: Event) => event.event === 'WithdrawalQueued');
    const effectiveRound = exitEvent?.args?.effectiveFromRound ?? exitEvent?.args?.[1];
    await advanceToRoundCommitPhase(redistribution, effectiveRound);

    const currentRound = await redistribution.currentRound();
    await expect(redistribution.commit(obfuscatedHash_0, currentRound)).to.be.revertedWith(errors.withdraw.notStaked);

    await srStaker0.applyUpdates(staker_0);

    const stakedAfter = await srStaker0.stakes(staker_0);
    expect(await token.balanceOf(staker_0)).to.be.eq(stakeAmount_0);
    expect(stakedAfter.overlay).to.be.eq(zeroBytes32);
    expect(stakedAfter.balance).to.be.eq(0);
  });

  it('should schedule exits and clear the stake on applyUpdates', async function () {
    const srStaker0 = await ethers.getContract('StakeRegistry', staker_0);
    await activateStake(srStaker0, staker_0, nonce_0, stakeAmount_0, height_0);

    await expect(srStaker0.exit()).to.emit(srStaker0, 'WithdrawalQueued');

    await advanceRounds();
    expect(await srStaker0.nodeEffectiveStake(staker_0)).to.be.eq(0);
    expect(await token.balanceOf(staker_0)).to.be.eq(0);

    await srStaker0.applyUpdates(staker_0);
    const stakedAfter = await srStaker0.stakes(staker_0);
    expect(await token.balanceOf(staker_0)).to.be.eq(stakeAmount_0);
    expect(stakedAfter.overlay).to.be.eq(zeroBytes32);
    expect(stakedAfter.balance).to.be.eq(0);
  });

  it('should not allow new updates to be queued after exit is scheduled', async function () {
    const srStaker0 = await ethers.getContract('StakeRegistry', staker_0);
    await activateStake(srStaker0, staker_0, nonce_0, stakeAmount_0, height_0);

    await srStaker0.exit();

    await mintAndApprove(staker_0, srStaker0.address, stakeAmount_0);
    await expect(srStaker0.createDeposit(nonce_1_n_25, stakeAmount_0, height_0)).to.be.revertedWith(
      errors.general.queueClosed
    );
  });

  it('should allow redeposit after exit is fully applied', async function () {
    const srStaker0 = await ethers.getContract('StakeRegistry', staker_0);
    await activateStake(srStaker0, staker_0, nonce_0, stakeAmount_0, height_0);

    await srStaker0.exit();
    await advanceRounds();
    await srStaker0.applyUpdates(staker_0);
    expect((await srStaker0.stakes(staker_0)).overlay).to.be.eq(zeroBytes32);

    await mintAndApprove(staker_0, srStaker0.address, stakeAmount_0);
    await expect(srStaker0.createDeposit(nonce_1_n_25, stakeAmount_0, height_0)).to.emit(srStaker0, 'DepositCreated');

    await advanceRounds();
    await srStaker0.applyUpdates(staker_0);
    expect(await srStaker0.nodeEffectiveStake(staker_0)).to.be.eq(stakeAmount_0);
    const redeposit = await srStaker0.stakes(staker_0);
    expect(redeposit.overlay).to.not.be.eq(zeroBytes32);
    expect(redeposit.overlay).to.not.be.eq(overlay_0);
  });

  it('should keep account freeze across full exit and block effective stake until it expires', async function () {
    const srStaker0 = await ethers.getContract('StakeRegistry', staker_0);
    const longFreezeTime = roundLength * 3;
    await activateStake(srStaker0, staker_0, nonce_0, stakeAmount_0, height_0);

    await srStaker0.exit();
    await advanceRounds();

    const stakeRegistryDeployer = await ethers.getContract('StakeRegistry', deployer);
    await stakeRegistryDeployer.grantRole(await stakeRegistryDeployer.REDISTRIBUTOR_ROLE(), redistributor);
    const srRedis = await ethers.getContract('StakeRegistry', redistributor);
    // Applies the mature exit first, then starts the penalty window (same tx as existing tests expect).
    await srRedis.freezeDeposit(staker_0, longFreezeTime);

    expect((await srStaker0.stakes(staker_0)).overlay).to.be.eq(zeroBytes32);
    expect(await token.balanceOf(staker_0)).to.be.eq(stakeAmount_0);
    expect(await srStaker0.freezeUntilBlock(staker_0)).to.be.gt(0);

    await mintAndApprove(staker_0, srStaker0.address, stakeAmount_0);
    await srStaker0.createDeposit(nonce_1_n_25, stakeAmount_0, height_0);
    await advanceRounds();
    await srStaker0.applyUpdates(staker_0);

    expect((await srStaker0.stakes(staker_0)).balance).to.be.eq(stakeAmount_0);
    expect(await srStaker0.nodeEffectiveStake(staker_0)).to.be.eq(0);

    await mineNBlocks(longFreezeTime + 1);
    expect(await srStaker0.nodeEffectiveStake(staker_0)).to.be.eq(stakeAmount_0);
  });

  it('should keep account freeze across migrateStake and block effective stake until it expires', async function () {
    const srStaker0 = await ethers.getContract('StakeRegistry', staker_0);
    const longFreezeTime = roundLength * 3;
    await activateStake(srStaker0, staker_0, nonce_0, stakeAmount_0, height_0);

    const stakeRegistryDeployer = await ethers.getContract('StakeRegistry', deployer);
    await stakeRegistryDeployer.grantRole(await stakeRegistryDeployer.REDISTRIBUTOR_ROLE(), redistributor);
    const srRedis = await ethers.getContract('StakeRegistry', redistributor);
    await srRedis.freezeDeposit(staker_0, longFreezeTime);
    expect(await srStaker0.freezeUntilBlock(staker_0)).to.be.gt(0);

    const stakeRegistryPauser = await ethers.getContract('StakeRegistry', pauser);
    await stakeRegistryPauser.pause();
    await expect(srStaker0.migrateStake()).to.emit(srStaker0, 'StakeMigrated').withArgs(staker_0, stakeAmount_0);
    expect(await token.balanceOf(staker_0)).to.be.eq(stakeAmount_0);
    expect((await srStaker0.stakes(staker_0)).overlay).to.be.eq(zeroBytes32);
    expect(await srStaker0.freezeUntilBlock(staker_0)).to.be.gt(0);

    await stakeRegistryPauser.unpause();
    await mintAndApprove(staker_0, srStaker0.address, stakeAmount_0);
    await srStaker0.createDeposit(nonce_1_n_25, stakeAmount_0, height_0);
    await advanceRounds();
    await srStaker0.applyUpdates(staker_0);

    expect((await srStaker0.stakes(staker_0)).balance).to.be.eq(stakeAmount_0);
    expect(await srStaker0.nodeEffectiveStake(staker_0)).to.be.eq(0);

    await mineNBlocks(longFreezeTime + 1);
    expect(await srStaker0.nodeEffectiveStake(staker_0)).to.be.eq(stakeAmount_0);
  });

  it('should not shorten an existing freeze when a shorter freeze is applied', async function () {
    const srStaker0 = await ethers.getContract('StakeRegistry', staker_0);
    await activateStake(srStaker0, staker_0, nonce_0, stakeAmount_0, height_0);

    const stakeRegistryDeployer = await ethers.getContract('StakeRegistry', deployer);
    await stakeRegistryDeployer.grantRole(await stakeRegistryDeployer.REDISTRIBUTOR_ROLE(), redistributor);
    const srRedis = await ethers.getContract('StakeRegistry', redistributor);

    const longFreeze = roundLength * 10;
    const shortFreeze = 5;
    await srRedis.freezeDeposit(staker_0, longFreeze);
    const untilAfterLong = await srStaker0.freezeUntilBlock(staker_0);

    await mineNBlocks(3);
    await srRedis.freezeDeposit(staker_0, shortFreeze);
    const untilAfterShort = await srStaker0.freezeUntilBlock(staker_0);

    expect(untilAfterShort).to.be.eq(untilAfterLong);
  });

  it('should not allow invalid withdrawals', async function () {
    const srStaker0 = await ethers.getContract('StakeRegistry', staker_0);
    await expectRevertReasonSubstring(srStaker0.withdraw(0), errors.withdraw.invalidWithdrawalAmountZero);
    await expect(srStaker0.exit()).to.be.revertedWith(errors.withdraw.notStaked);

    await activateStake(srStaker0, staker_0, nonce_0, stakeAmount_0, height_0);
    await expectRevertReasonSubstring(srStaker0.withdraw(stakeAmount_0), errors.deposit.belowMinimum);

    const overdraw = BigNumber.from(stakeAmount_0).add(1).toString();
    await expectRevertReasonSubstring(
      srStaker0.withdraw(overdraw),
      errors.withdraw.invalidWithdrawalAmountExceedsBalance
    );
  });

  it('should allow non-transfer updates to be queued and applied while the node is frozen', async function () {
    const srStaker0 = await ethers.getContract('StakeRegistry', staker_0);
    const longFreezeTime = roundLength * 3;
    await activateStake(srStaker0, staker_0, nonce_0, stakeAmount_0, height_0);

    const stakeRegistryDeployer = await ethers.getContract('StakeRegistry', deployer);
    const redistributorRole = await stakeRegistryDeployer.REDISTRIBUTOR_ROLE();
    await stakeRegistryDeployer.grantRole(redistributorRole, redistributor);

    const stakeRegistryRedistributor = await ethers.getContract('StakeRegistry', redistributor);
    await expect(stakeRegistryRedistributor.freezeDeposit(staker_0, longFreezeTime))
      .to.emit(srStaker0, 'StakeFrozen')
      .withArgs(staker_0, overlay_0, longFreezeTime);

    expect(await srStaker0.nodeEffectiveStake(staker_0)).to.be.eq(0);

    await mintAndApprove(staker_0, srStaker0.address, stakeAmount_0);
    await expect(srStaker0.addTokens(stakeAmount_0)).to.emit(srStaker0, 'TokensAdded');
    await expect(srStaker0.changeOverlay(nonce_1_n_25)).to.emit(srStaker0, 'OverlayChanged');
    await expect(srStaker0.increaseHeight(height_0_n_1)).to.emit(srStaker0, 'HeightIncreased');

    await advanceRounds();
    await srStaker0.applyUpdates(staker_0);

    expect(await srStaker0.nodeEffectiveStake(staker_0)).to.be.eq(0);
    expect((await srStaker0.stakes(staker_0)).balance).to.be.eq(doubleStakeAmount_0);
    expect(await srStaker0.overlayOfAddress(staker_0)).to.not.be.eq(overlay_0);
    expect(await srStaker0.heightOfAddress(staker_0)).to.be.eq(height_0_n_1);

    await mineNBlocks(longFreezeTime + 1);

    expect(await srStaker0.nodeEffectiveStake(staker_0)).to.be.eq(doubleStakeAmount_0);
    expect(await srStaker0.overlayOfAddress(staker_0)).to.not.be.eq(overlay_0);
    expect(await srStaker0.heightOfAddress(staker_0)).to.be.eq(height_0_n_1);
  });

  it('should allow withdrawals to be queued while frozen and execute them after the freeze expires', async function () {
    const srStaker0 = await ethers.getContract('StakeRegistry', staker_0);
    const longFreezeTime = roundLength * 3;
    await activateStake(srStaker0, staker_0, nonce_0, doubleStakeAmount_0, height_0);

    const stakeRegistryDeployer = await ethers.getContract('StakeRegistry', deployer);
    const redistributorRole = await stakeRegistryDeployer.REDISTRIBUTOR_ROLE();
    await stakeRegistryDeployer.grantRole(redistributorRole, redistributor);

    const stakeRegistryRedistributor = await ethers.getContract('StakeRegistry', redistributor);
    await stakeRegistryRedistributor.freezeDeposit(staker_0, longFreezeTime);

    await expect(srStaker0.withdraw(withdrawAmount)).to.emit(srStaker0, 'WithdrawalQueued');
    await advanceRounds();

    await expect(srStaker0.applyUpdates(staker_0)).to.be.revertedWith(errors.general.frozenWithdrawal);
    expect(await token.balanceOf(staker_0)).to.be.eq(0);
    expect(await srStaker0.nodeEffectiveStake(staker_0)).to.be.eq(0);

    await mineNBlocks(longFreezeTime + 1);

    expect(await srStaker0.nodeEffectiveStake(staker_0)).to.be.eq(stakeAmount_0);
    await srStaker0.applyUpdates(staker_0);
    expect(await token.balanceOf(staker_0)).to.be.eq(withdrawAmount);
  });

  it('should slash active stake balances', async function () {
    const srStaker0 = await ethers.getContract('StakeRegistry', staker_0);
    await activateStake(srStaker0, staker_0, nonce_0, stakeAmount_0, height_0);

    const stakeRegistryDeployer = await ethers.getContract('StakeRegistry', deployer);
    const redistributorRole = await stakeRegistryDeployer.REDISTRIBUTOR_ROLE();
    await stakeRegistryDeployer.grantRole(redistributorRole, redistributor);

    const stakeRegistryRedistributor = await ethers.getContract('StakeRegistry', redistributor);
    await expect(stakeRegistryRedistributor.slashDeposit(staker_0, '0')).to.be.revertedWith(errors.slash.invalidAmount);

    await expect(stakeRegistryRedistributor.slashDeposit(staker_0, slashAmount))
      .to.emit(srStaker0, 'StakeSlashed')
      .withArgs(staker_0, overlay_0, slashAmount);

    expect((await srStaker0.stakes(staker_0)).balance).to.be.eq(partialSlashBalance);

    await stakeRegistryRedistributor.slashDeposit(staker_0, partialSlashBalance);
    expect((await srStaker0.stakes(staker_0)).balance).to.be.eq(0);
  });

  it('should reduce queued withdrawals that exceed the post-slash stake', async function () {
    const srStaker0 = await ethers.getContract('StakeRegistry', staker_0);
    await activateStake(srStaker0, staker_0, nonce_0, tripleStakeAmount_0, height_0);

    const stakeRegistryDeployer = await ethers.getContract('StakeRegistry', deployer);
    const redistributorRole = await stakeRegistryDeployer.REDISTRIBUTOR_ROLE();
    await stakeRegistryDeployer.grantRole(redistributorRole, redistributor);

    await srStaker0.withdraw(doubleWithdrawAmount);

    const stakeRegistryRedistributor = await ethers.getContract('StakeRegistry', redistributor);
    await stakeRegistryRedistributor.slashDeposit(staker_0, doubleSlashAmount);

    await advanceRounds();

    expect(await srStaker0.nodeEffectiveStake(staker_0)).to.be.eq(0);
    expect(await token.balanceOf(staker_0)).to.be.eq(0);

    await srStaker0.applyUpdates(staker_0);

    expect(await token.balanceOf(staker_0)).to.be.eq(stakeAmount_0);
    expect((await srStaker0.stakes(staker_0)).balance).to.be.eq(0);
  });

  it('should lower height after slash when balance no longer meets the previous minimum', async function () {
    const srStaker0 = await ethers.getContract('StakeRegistry', staker_0);
    await activateStake(srStaker0, staker_0, nonce_0, doubleStakeAmount_0, height_0_n_1);
    expect(await srStaker0.heightOfAddress(staker_0)).to.be.eq(height_0_n_1);

    const stakeRegistryDeployer = await ethers.getContract('StakeRegistry', deployer);
    await stakeRegistryDeployer.grantRole(await stakeRegistryDeployer.REDISTRIBUTOR_ROLE(), redistributor);
    const srRedis = await ethers.getContract('StakeRegistry', redistributor);

    await srRedis.slashDeposit(staker_0, slashAmount);

    expect((await srStaker0.stakes(staker_0)).balance).to.eq(BigNumber.from(doubleStakeAmount_0).sub(slashAmount));
    expect(await srStaker0.heightOfAddress(staker_0)).to.be.eq(height_0);
  });

  it('should reject staking height above MAX_STAKING_HEIGHT', async function () {
    const srStaker1 = await ethers.getContract('StakeRegistry', staker_1);
    const maxH = Number(await srStaker1.MAX_STAKING_HEIGHT());
    await mintAndApprove(staker_1, srStaker1.address, stakeAmount_0);
    await expectRevertReasonSubstring(
      srStaker1.createDeposit(nonce_0, stakeAmount_0, maxH + 1),
      'StakingHeightTooLarge'
    );
  });

  it('should not allow freeze or slash while staking is paused', async function () {
    const srStaker0 = await ethers.getContract('StakeRegistry', staker_0);
    await activateStake(srStaker0, staker_0, nonce_0, stakeAmount_0, height_0);

    const srDeployer = await ethers.getContract('StakeRegistry', deployer);
    await srDeployer.grantRole(await srDeployer.REDISTRIBUTOR_ROLE(), redistributor);
    const srRedis = await ethers.getContract('StakeRegistry', redistributor);

    const srPauser = await ethers.getContract('StakeRegistry', pauser);
    await srPauser.pause();

    await expect(srRedis.freezeDeposit(staker_0, freezeTime)).to.be.revertedWith(errors.pause.currentlyPaused);
    await expect(srRedis.slashDeposit(staker_0, slashAmount)).to.be.revertedWith(errors.pause.currentlyPaused);
  });

  it('should not allow stake migration while unpaused and should include queued deposits when paused', async function () {
    const srStaker0 = await ethers.getContract('StakeRegistry', staker_0);
    await mintAndApprove(staker_0, srStaker0.address, stakeAmount_0);
    await srStaker0.createDeposit(nonce_0, stakeAmount_0, height_0);

    await expect(srStaker0.migrateStake()).to.be.revertedWith(errors.pause.notCurrentlyPaused);

    const stakeRegistryPauser = await ethers.getContract('StakeRegistry', pauser);
    await stakeRegistryPauser.pause();
    await expect(srStaker0.migrateStake()).to.emit(srStaker0, 'StakeMigrated').withArgs(staker_0, stakeAmount_0);

    expect(await token.balanceOf(staker_0)).to.be.eq(stakeAmount_0);
    expect((await srStaker0.stakes(staker_0)).balance).to.be.eq(0);
  });

  describe('contract migration freeze import', function () {
    it('should import freezeUntilBlock and block effective stake after restake on successor registry', async function () {
      const longFreezeTime = roundLength * 3;
      const Factory = await ethers.getContractFactory('StakeRegistry');
      const srOld = await Factory.deploy(token.address, await stakeRegistry.networkId(), 2, 10, 2);
      await srOld.deployed();
      await srOld.grantRole(await srOld.REDISTRIBUTOR_ROLE(), redistributor);

      const srOldStaker = srOld.connect(await getSignerFor(staker_0));
      await mintAndApprove(staker_0, srOld.address, stakeAmount_0);
      await srOldStaker.createDeposit(nonce_0, stakeAmount_0, height_0);
      await advanceRounds();
      await srOld.applyUpdates(staker_0);

      const srOldRedis = srOld.connect(await getSignerFor(redistributor));
      await srOldRedis.freezeDeposit(staker_0, longFreezeTime);
      const importedUntil = await srOld.freezeUntilBlock(staker_0);

      const srNew = await Factory.deploy(token.address, await stakeRegistry.networkId(), 2, 10, 2);
      await srNew.deployed();
      const srNewAdmin = srNew.connect(await getSignerFor(deployer));
      await expect(srNewAdmin.importFreezeUntilBlocks([staker_0], [importedUntil]))
        .to.emit(srNew, 'AccountFreezeExtended')
        .withArgs(staker_0, importedUntil);
      expect(await srNew.freezeUntilBlock(staker_0)).to.eq(importedUntil);

      const srNewStaker = srNew.connect(await getSignerFor(staker_0));
      await mintAndApprove(staker_0, srNew.address, stakeAmount_0);
      await srNewStaker.createDeposit(nonce_1_n_25, stakeAmount_0, height_0);
      await advanceRounds();
      await srNew.applyUpdates(staker_0);

      expect((await srNew.stakes(staker_0)).balance).to.eq(stakeAmount_0);
      expect(await srNew.nodeEffectiveStake(staker_0)).to.eq(0);

      await mineNBlocks(longFreezeTime + 1);
      expect(await srNew.nodeEffectiveStake(staker_0)).to.eq(stakeAmount_0);
    });

    it('should reject importFreezeUntilBlocks from non-admin and on array length mismatch', async function () {
      const srAdmin = stakeRegistry.connect(await getSignerFor(deployer));
      const srStaker = stakeRegistry.connect(await getSignerFor(staker_0));
      const until = (await ethers.provider.getBlock('latest'))!.number + 100;

      await expect(srStaker.importFreezeUntilBlocks([staker_0], [until])).to.be.revertedWith('AccessControl');
      await expect(srAdmin.importFreezeUntilBlocks([staker_0], [until, until + 1])).to.be.revertedWith(
        'ArrayLengthMismatch()'
      );
    });

    it('should not shorten an existing freeze when importing a lower deadline', async function () {
      const srAdmin = stakeRegistry.connect(await getSignerFor(deployer));
      const laterUntil = (await ethers.provider.getBlock('latest'))!.number + 500;
      const earlierUntil = laterUntil - 200;

      await srAdmin.importFreezeUntilBlocks([staker_0], [laterUntil]);
      expect(await stakeRegistry.freezeUntilBlock(staker_0)).to.eq(laterUntil);

      await srAdmin.importFreezeUntilBlocks([staker_0], [earlierUntil]);
      expect(await stakeRegistry.freezeUntilBlock(staker_0)).to.eq(laterUntil);
    });
  });

  it('should not allow staking while paused and should allow it again after unpause', async function () {
    const srStaker0 = await ethers.getContract('StakeRegistry', staker_0);
    const stakeRegistryPauser = await ethers.getContract('StakeRegistry', pauser);

    await stakeRegistryPauser.pause();
    await mintAndApprove(staker_0, srStaker0.address, stakeAmount_0);
    await expect(srStaker0.createDeposit(nonce_0, stakeAmount_0, height_0)).to.be.revertedWith(
      errors.pause.currentlyPaused
    );

    await stakeRegistryPauser.unpause();
    await expect(srStaker0.createDeposit(nonce_0, stakeAmount_0, height_0)).to.not.be.reverted;
  });

  describe('enqueue API surface', function () {
    it('should match createDeposit callStatic return to DepositCreated round', async function () {
      const sr = await ethers.getContract('StakeRegistry', staker_0);
      await mintAndApprove(staker_0, sr.address, stakeAmount_0);
      const fromCall = await sr.callStatic.createDeposit(nonce_0, stakeAmount_0, height_0);
      const tx = await sr.createDeposit(nonce_0, stakeAmount_0, height_0);
      const receipt = await tx.wait();
      const ev = receipt.events!.find((e: Event) => e.event === 'DepositCreated');
      expect(effectiveRoundFromEvent(ev)).to.eq(fromCall);
    });

    it('should match addTokens callStatic return to TokensAdded round', async function () {
      const sr = await ethers.getContract('StakeRegistry', staker_0);
      await activateStake(sr, staker_0, nonce_0, stakeAmount_0, height_0);
      await mintAndApprove(staker_0, sr.address, stakeAmount_0);
      const fromCall = await sr.callStatic.addTokens(stakeAmount_0);
      const tx = await sr.addTokens(stakeAmount_0);
      const receipt = await tx.wait();
      const ev = receipt.events!.find((e: Event) => e.event === 'TokensAdded');
      expect(effectiveRoundFromEvent(ev)).to.eq(fromCall);
    });

    it('should match changeOverlay callStatic return to OverlayChanged round', async function () {
      const sr = await ethers.getContract('StakeRegistry', staker_1);
      await activateStake(sr, staker_1, nonce_0, stakeAmount_0, height_0);
      const fromCall = await sr.callStatic.changeOverlay(nonce_1_n_25);
      const tx = await sr.changeOverlay(nonce_1_n_25);
      const receipt = await tx.wait();
      const ev = receipt.events!.find((e: Event) => e.event === 'OverlayChanged');
      expect(effectiveRoundFromEvent(ev)).to.eq(fromCall);
    });

    it('should match increaseHeight callStatic return to HeightIncreased round', async function () {
      const sr = await ethers.getContract('StakeRegistry', staker_0);
      await activateStake(sr, staker_0, nonce_0, doubleStakeAmount_0, height_0);
      const fromCall = await sr.callStatic.increaseHeight(height_0_n_1);
      const tx = await sr.increaseHeight(height_0_n_1);
      const receipt = await tx.wait();
      const ev = receipt.events!.find((e: Event) => e.event === 'HeightIncreased');
      expect(effectiveRoundFromEvent(ev)).to.eq(fromCall);
    });

    it('should match withdraw callStatic return to WithdrawalQueued round', async function () {
      const sr = await ethers.getContract('StakeRegistry', staker_0);
      await activateStake(sr, staker_0, nonce_0, doubleStakeAmount_0, height_0);
      const fromCall = await sr.callStatic.withdraw(withdrawAmount);
      const tx = await sr.withdraw(withdrawAmount);
      const receipt = await tx.wait();
      const ev = receipt.events!.find((e: Event) => e.event === 'WithdrawalQueued');
      expect(effectiveRoundFromEvent(ev)).to.eq(fromCall);
    });

    it('should match exit callStatic return to WithdrawalQueued round', async function () {
      const sr = await ethers.getContract('StakeRegistry', staker_1);
      await activateStake(sr, staker_1, nonce_0, stakeAmount_0, height_0);
      const fromCall = await sr.callStatic.exit();
      const tx = await sr.exit();
      const receipt = await tx.wait();
      const ev = receipt.events!.find((e: Event) => e.event === 'WithdrawalQueued');
      expect(effectiveRoundFromEvent(ev)).to.eq(fromCall);
    });

    it('should revert when overlay is unchanged', async function () {
      const sr = await ethers.getContract('StakeRegistry', staker_0);
      await activateStake(sr, staker_0, nonce_0, stakeAmount_0, height_0);
      await expect(sr.changeOverlay(nonce_0)).to.be.revertedWith(errors.general.overlayUnchanged);
    });

    it('should return 0 and emit nothing when height is unchanged', async function () {
      const sr = await ethers.getContract('StakeRegistry', staker_0);
      await activateStake(sr, staker_0, nonce_0, doubleStakeAmount_0, height_0_n_1);
      expect(await sr.callStatic.increaseHeight(height_0_n_1)).to.eq(0);
      const tx = await sr.increaseHeight(height_0_n_1);
      const receipt = await tx.wait();
      expect(receipt.events?.some((e: Event) => e.event === 'HeightIncreased')).to.eq(false);
    });

    it('should assign non-decreasing effective rounds when stacking addTokens without mining', async function () {
      const sr = await ethers.getContract('StakeRegistry', staker_0);
      await activateStake(sr, staker_0, nonce_0, stakeAmount_0, height_0);
      const rounds: BigNumber[] = [];
      for (let i = 0; i < 5; i++) {
        await mintAndApprove(staker_0, sr.address, stakeAmount_0);
        const tx = await sr.addTokens(stakeAmount_0);
        const receipt = await tx.wait();
        const ev = receipt.events!.find((e: Event) => e.event === 'TokensAdded');
        rounds.push(effectiveRoundFromEvent(ev));
      }
      for (let i = 1; i < rounds.length; i++) {
        expect(rounds[i].gte(rounds[i - 1])).to.eq(true);
      }
    });

    it('should reject withdraw that would leave remainder below minimum for current height', async function () {
      const sr = await ethers.getContract('StakeRegistry', staker_0);
      await activateStake(sr, staker_0, nonce_0, doubleStakeAmount_0, height_0);
      const almostAll = BigNumber.from(doubleStakeAmount_0).sub(1);
      await expectRevertReasonSubstring(sr.withdraw(almostAll), errors.deposit.belowMinimum);
    });

    it('should revert applyUpdates atomically when a due withdrawal is blocked by freeze (withdraw then top-up)', async function () {
      const sr = await ethers.getContract('StakeRegistry', staker_0);
      const longFreezeTime = roundLength * 3;
      await activateStake(sr, staker_0, nonce_0, doubleStakeAmount_0, height_0);

      const srDeployer = await ethers.getContract('StakeRegistry', deployer);
      await srDeployer.grantRole(await srDeployer.REDISTRIBUTOR_ROLE(), redistributor);
      const srRedis = await ethers.getContract('StakeRegistry', redistributor);
      await srRedis.freezeDeposit(staker_0, longFreezeTime);

      await sr.withdraw(withdrawAmount);
      await mintAndApprove(staker_0, sr.address, stakeAmount_0);
      await sr.addTokens(stakeAmount_0);
      await advanceRounds();

      const balanceBefore = (await sr.stakes(staker_0)).balance;
      await expect(sr.applyUpdates(staker_0)).to.be.revertedWith(errors.general.frozenWithdrawal);
      expect((await sr.stakes(staker_0)).balance).to.eq(balanceBefore);
    });

    it('should revert applyUpdates atomically when due withdrawal blocks after earlier queued top-up', async function () {
      const sr = await ethers.getContract('StakeRegistry', staker_0);
      const longFreezeTime = roundLength * 3;
      await activateStake(sr, staker_0, nonce_0, doubleStakeAmount_0, height_0);

      const srDeployer = await ethers.getContract('StakeRegistry', deployer);
      await srDeployer.grantRole(await srDeployer.REDISTRIBUTOR_ROLE(), redistributor);
      const srRedis = await ethers.getContract('StakeRegistry', redistributor);
      await srRedis.freezeDeposit(staker_0, longFreezeTime);

      await mintAndApprove(staker_0, sr.address, stakeAmount_0);
      await sr.addTokens(stakeAmount_0);
      await sr.withdraw(withdrawAmount);
      await advanceRounds();

      const balanceBefore = (await sr.stakes(staker_0)).balance;
      await expect(sr.applyUpdates(staker_0)).to.be.revertedWith(errors.general.frozenWithdrawal);
      expect((await sr.stakes(staker_0)).balance).to.eq(balanceBefore);
    });

    it('should migrate active stake plus queued addTokens payout when paused', async function () {
      const sr = await ethers.getContract('StakeRegistry', staker_0);
      await activateStake(sr, staker_0, nonce_0, stakeAmount_0, height_0);
      await mintAndApprove(staker_0, sr.address, stakeAmount_0);
      await sr.addTokens(stakeAmount_0);

      const srPauser = await ethers.getContract('StakeRegistry', pauser);
      await srPauser.pause();

      const payout = BigNumber.from(stakeAmount_0).add(stakeAmount_0);
      await expect(sr.migrateStake()).to.emit(sr, 'StakeMigrated').withArgs(staker_0, payout);
      expect(await token.balanceOf(staker_0)).to.eq(doubleStakeAmount_0);
      expect((await sr.stakes(staker_0)).balance).to.eq(0);
    });
  });

  it('should reject staking constructor when waits are below base', async function () {
    const tokenDeploy = await ethers.getContract('TestToken', deployer);
    const netId = await stakeRegistry.networkId();
    const Factory = await ethers.getContractFactory('StakeRegistry');
    await expect(Factory.deploy(tokenDeploy.address, netId, 5, 4, 8)).to.be.revertedWith(
      errors.general.invalidWaitConfig
    );
  });

  it('should reject enqueue when the update queue is full', async function () {
    const srStaker0 = await ethers.getContract('StakeRegistry', staker_0);
    await activateStake(srStaker0, staker_0, nonce_0, doubleStakeAmount_0, height_0);
    for (let i = 0; i < 10; i++) {
      await mintAndApprove(staker_0, srStaker0.address, stakeAmount_0);
      await expect(srStaker0.addTokens(stakeAmount_0)).to.emit(srStaker0, 'TokensAdded');
    }
    await mintAndApprove(staker_0, srStaker0.address, stakeAmount_0);
    await expect(srStaker0.addTokens(stakeAmount_0)).to.be.revertedWith(errors.general.queueFull);
  });

  it('should apply earlier-enqueued top-up while frozen before overlay change is due', async function () {
    const Factory = await ethers.getContractFactory('StakeRegistry');
    const srAlt = await Factory.deploy(token.address, await stakeRegistry.networkId(), 2, 10, 2);
    await srAlt.deployed();
    await srAlt.grantRole(await srAlt.REDISTRIBUTOR_ROLE(), redistributor);

    const srStaker = srAlt.connect(await getSignerFor(staker_0));
    await mintAndApprove(staker_0, srAlt.address, doubleStakeAmount_0);
    await srStaker.createDeposit(nonce_0, stakeAmount_0, height_0);
    await advanceRounds();
    await srAlt.applyUpdates(staker_0);

    await mintAndApprove(staker_0, srAlt.address, stakeAmount_0);
    await srStaker.addTokens(stakeAmount_0);
    await srStaker.changeOverlay(nonce_1_n_25);

    const srRedis = srAlt.connect(await getSignerFor(redistributor));
    await srRedis.freezeDeposit(staker_0, roundLength * 25);

    await advanceRounds(2);

    await srAlt.applyUpdates(staker_0);

    expect((await srAlt.stakes(staker_0)).balance).to.be.eq(doubleStakeAmount_0);
    expect(await srAlt.overlayOfAddress(staker_0)).to.be.eq(overlay_0);
  });

  describe('queue FIFO and mixed delays', function () {
    /** WAIT_BASE / WAIT_OVERLAY_CHANGE / WAIT_WITHDRAWAL — overlay and withdrawal waits > base so effective rounds spread out. */
    async function deployStakeRegistryAlt(
      waitBase: number,
      waitOverlay: number,
      waitWithdrawal: number
    ): Promise<Contract> {
      const Factory = await ethers.getContractFactory('StakeRegistry');
      const srAlt = await Factory.deploy(
        token.address,
        await stakeRegistry.networkId(),
        waitBase,
        waitOverlay,
        waitWithdrawal
      );
      await srAlt.deployed();
      await srAlt.grantRole(await srAlt.REDISTRIBUTOR_ROLE(), redistributor);
      return srAlt;
    }

    it('applies addTokens, withdraw, and changeOverlay in effective-round order when waits differ', async function () {
      const waitBase = 2;
      const waitWithdrawal = 6;
      const waitOverlay = 10;
      const srAlt = await deployStakeRegistryAlt(waitBase, waitOverlay, waitWithdrawal);
      const srStaker = srAlt.connect(await getSignerFor(staker_1));

      expect(await srAlt.WAIT_BASE()).to.eq(waitBase);
      expect(await srAlt.WAIT_OVERLAY_CHANGE()).to.eq(waitOverlay);
      expect(await srAlt.WAIT_WITHDRAWAL()).to.eq(waitWithdrawal);

      await mintAndApprove(staker_1, srAlt.address, doubleStakeAmount_0);
      await srStaker.createDeposit(nonce_0, doubleStakeAmount_0, height_0);
      await advanceRounds(waitBase);
      await srAlt.applyUpdates(staker_1);
      expect((await srAlt.stakes(staker_1)).balance).to.be.eq(doubleStakeAmount_0);
      expect(await token.balanceOf(staker_1)).to.be.eq(0);

      await mintAndApprove(staker_1, srAlt.address, stakeAmount_0);
      await srStaker.addTokens(stakeAmount_0);
      await srStaker.withdraw(withdrawAmount);
      await srStaker.changeOverlay(nonce_1_n_25);

      // First maturity: top-up only (round + waitBase).
      await advanceRounds(waitBase);
      await srAlt.applyUpdates(staker_1);
      expect((await srAlt.stakes(staker_1)).balance).to.be.eq(BigNumber.from(doubleStakeAmount_0).add(stakeAmount_0));
      expect(await srAlt.overlayOfAddress(staker_1)).to.be.eq(overlay_1);
      expect(await token.balanceOf(staker_1)).to.be.eq(0);

      // Second: queued withdrawal (stacked after top-up; maturity round + waitWithdrawal).
      await advanceRounds(waitWithdrawal - waitBase);
      await srAlt.applyUpdates(staker_1);
      expect((await srAlt.stakes(staker_1)).balance).to.be.eq(doubleStakeAmount_0);
      expect(await token.balanceOf(staker_1)).to.be.eq(BigNumber.from(withdrawAmount));
      expect(await srAlt.overlayOfAddress(staker_1)).to.be.eq(overlay_1);

      // Third: overlay (candidate round + waitOverlay vs last scheduled round).
      await advanceRounds(waitOverlay - waitWithdrawal);
      await srAlt.applyUpdates(staker_1);
      expect(await srAlt.overlayOfAddress(staker_1)).to.be.eq(overlay_1_n_25);
      expect((await srAlt.stakes(staker_1)).balance).to.be.eq(doubleStakeAmount_0);
    });

    it('applies addTokens then withdraw then addTokens in queue order when shares the same effective round', async function () {
      const waitBase = 2;
      const waitWithdrawal = 6;
      const waitOverlay = 10;
      const srAlt = await deployStakeRegistryAlt(waitBase, waitOverlay, waitWithdrawal);
      const srStaker = srAlt.connect(await getSignerFor(staker_0));

      await mintAndApprove(staker_0, srAlt.address, doubleStakeAmount_0);
      await srStaker.createDeposit(nonce_0, doubleStakeAmount_0, height_0);
      await advanceRounds(waitBase);
      await srAlt.applyUpdates(staker_0);
      expect(await token.balanceOf(staker_0)).to.be.eq(0);

      await mintAndApprove(staker_0, srAlt.address, doubleStakeAmount_0);
      await srStaker.addTokens(stakeAmount_0);
      await srStaker.withdraw(withdrawAmount);
      await srStaker.addTokens(stakeAmount_0);

      await advanceRounds(waitBase);
      await srAlt.applyUpdates(staker_0);
      expect((await srAlt.stakes(staker_0)).balance).to.be.eq(BigNumber.from(doubleStakeAmount_0).add(stakeAmount_0));

      await advanceRounds(waitWithdrawal - waitBase);
      await srAlt.applyUpdates(staker_0);
      expect((await srAlt.stakes(staker_0)).balance).to.be.eq(BigNumber.from(doubleStakeAmount_0).add(stakeAmount_0));
      expect(await token.balanceOf(staker_0)).to.be.eq(BigNumber.from(withdrawAmount));
    });

    it('applies addTokens, withdraw, and increaseHeight in strict FIFO in one round when fixture waits are uniform', async function () {
      const srStaker0 = await ethers.getContract('StakeRegistry', staker_0);
      await activateStake(srStaker0, staker_0, nonce_0, doubleStakeAmount_0, height_0);

      await mintAndApprove(staker_0, srStaker0.address, stakeAmount_0);
      await srStaker0.addTokens(stakeAmount_0);
      await srStaker0.withdraw(withdrawAmount);
      await srStaker0.increaseHeight(height_0_n_1);

      await advanceRounds(2);
      await srStaker0.applyUpdates(staker_0);

      expect((await srStaker0.stakes(staker_0)).balance).to.be.eq(doubleStakeAmount_0);
      expect(await srStaker0.heightOfAddress(staker_0)).to.be.eq(height_0_n_1);
      expect(await token.balanceOf(staker_0)).to.be.eq(BigNumber.from(withdrawAmount));
    });
  });
});
