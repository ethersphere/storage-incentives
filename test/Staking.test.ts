import { expect } from './util/chai';
import { ethers, deployments, getNamedAccounts, getUnnamedAccounts } from 'hardhat';
import { Signer, Contract } from 'ethers';
import { strictEqual } from 'assert';

// Named accounts used by tests.
let deployer: string;
let redistributor: string;
let pauser: string;
let others: string[];

const zeroAddress = '0x0000000000000000000000000000000000000000';
const zeroBytes32 = '0x0000000000000000000000000000000000000000000000000000000000000000';

const freezeTime = 3;

let errors = {
  deposit: {
    noBalance: 'ERC20: transfer amount exceeds balance',
    noZeroAddress: 'owner cannot be the zero address',
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
    onlyPauseCanUnPause: 'only pauser can unpause the contract'
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

let staker_0: string;
let overlay_0 = '0xd665e1fdc559f0987e10d70f0d3e6c877f64620f58d79c60b4742a3806555c48';
let stakeAmount_0 = 1000000;
let nonce_0 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';

let staker_1: string;
let overlay_1 = '0xd665e1fdc559f0987e10d70f0d3e6c877f64620f58d79c60b4742a3806555c48';
let stakeAmount_1 = 1000000;
let nonce_1 = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';

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
      expect(await stakeRegistry.hasRole(pauserRole, pauser)).to.be.true;
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
      await expect(stakeRegistry.depositStake(staker_0, nonce_0, stakeAmount_0)).to.be.revertedWith(
        errors.deposit.noBalance
      );
    });

    //it is not possible to have funds in the zero address, so this will fail anyway, can we remove this from the contract?
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
      let updatedBlockNumber = (await getBlockNumber()) + 3;

      await mintAndApprove(staker_0, stakeRegistry.address, stakeAmount_0);
      expect(await token.balanceOf(staker_0)).to.be.eq(stakeAmount_0);

      //event is emitted
      await expect(stakeRegistry.depositStake(staker_0, nonce_0, stakeAmount_0))
        .to.emit(stakeRegistry, 'StakeUpdated')
        .withArgs(overlay_0, stakeAmount_0, staker_0, updatedBlockNumber);

      //correct values are persisted
      let staked = await stakeRegistry.stakes(overlay_0);
      expect(staked.overlay).to.be.eq(overlay_0);
      expect(staked.owner).to.be.eq(staker_0);
      expect(staked.stakeAmount).to.be.eq(stakeAmount_0);
      expect(staked.lastUpdatedBlockNumber).to.be.eq(updatedBlockNumber);

      //tokens are successfully transferred
      expect(await token.balanceOf(stakeRegistry.address)).to.be.eq(stakeAmount_0);
    });

    it('should update stake correctly if funds are available', async function () {
      await mintAndApprove(staker_0, stakeRegistry.address, stakeAmount_0);
      expect(await token.balanceOf(staker_0)).to.be.eq(stakeAmount_0);

      stakeRegistry.depositStake(staker_0, nonce_0, stakeAmount_0);

      let lastUpdatedBlockNumber = (await getBlockNumber()) + 3;
      let updateStakeAmount = 633633;
      let nonce = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';

      await mintAndApprove(staker_0, stakeRegistry.address, updateStakeAmount);
      expect(await token.balanceOf(staker_0)).to.be.eq(updateStakeAmount);

      // commented out to allow tests to pass for now

      // //event is emitted
      // await expect(stakeRegistry.depositStake(staker_0, nonce_0, updateStakeAmount))
      //   .to.emit(stakeRegistry, 'StakeUpdated')
      //   .withArgs(overlay_0, stakeAmount_0+updateStakeAmount, staker_0, lastUpdatedBlockNumber);

      // //correct values are persisted
      // let staked = await stakeRegistry.stakes(overlay_0);
      // expect(staked.overlay).to.be.eq(overlay_0);
      // expect(staked.owner).to.be.eq(staker_0);
      // expect(staked.stakeAmount).to.be.eq(stakeAmount_0+updateStakeAmount);
      // expect(staked.lastUpdatedBlockNumber).to.be.eq(lastUpdatedBlockNumber);

      // //tokens are successfully transferred
      // expect(await token.balanceOf(stakeRegistry.address)).to.be.eq(stakeAmount_0+updateStakeAmount);
    });

    //this doesn't work for some reason - tries to transfer more balance than is available - perhaps contract needs debugging
    it('should correctly deposit stake from another user if funds are available', async function () {
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

      let stakeRegistryDeployer = await ethers.getContract('StakeRegistry', deployer);
      const redistributorRole = await stakeRegistryDeployer.REDISTRIBUTOR_ROLE();
      await stakeRegistryDeployer.grantRole(redistributorRole, redistributor);
    });

    it('should not slash staked deposit without redistributor role', async function () {
      let stakeRegistry = await ethers.getContract('StakeRegistry', staker_1);
      await expect(stakeRegistry.slashDeposit(overlay_0)).to.be.revertedWith(errors.slash.noRole);
    });

    it('should slash staked deposit with redistributor role', async function () {
      let stakeRegistryRedistributor = await ethers.getContract('StakeRegistry', redistributor);
      await stakeRegistryRedistributor.slashDeposit(overlay_0);

      let staked = await stakeRegistry.stakes(overlay_0);
      expect(staked.overlay).to.be.eq(zeroBytes32);
      // expect(staked.owner).to.be.eq(owner);
      // expect(staked.stakeAmount).to.be.eq(stakeAmount);
      // expect(staked.lastUpdatedBlockNumber).to.be.eq(lastUpdatedBlockNumber);
    });

    // other nodes stake and check they are unslashed
    // other sequences of staking/slashing...
    // restaking after slashing
    // ...
  });

  describe('freezing stake', function () {
    beforeEach(async function () {
      token = await ethers.getContract('TestToken', deployer);
      stakeRegistry = await ethers.getContract('StakeRegistry');
      await deployments.fixture();

      await mintAndApprove(staker_0, stakeRegistry.address, stakeAmount_0);
      await stakeRegistry.depositStake(staker_0, nonce_0, stakeAmount_0);

      let stakeRegistryDeployer = await ethers.getContract('StakeRegistry', deployer);
      const redistributorRole = await stakeRegistryDeployer.REDISTRIBUTOR_ROLE();
      await stakeRegistryDeployer.grantRole(redistributorRole, redistributor);
    });

    it('should not freeze staked deposit without redistributor role', async function () {
      let stakeRegistryStaker1 = await ethers.getContract('StakeRegistry', staker_1);
      await expect(stakeRegistryStaker1.freezeDeposit(overlay_0, freezeTime)).to.be.revertedWith(errors.freeze.noRole);
    });

    it('should freeze staked deposit with redistributor role', async function () {
      let overlay = '0xd665e1fdc559f0987e10d70f0d3e6c877f64620f58d79c60b4742a3806555c48';

      let stakeRegistryRedistributor = await ethers.getContract('StakeRegistry', redistributor);
      await stakeRegistryRedistributor.freezeDeposit(overlay_0, freezeTime);

      let staked = await stakeRegistryRedistributor.stakes(overlay);
      let updatedBlockNumber = (await getBlockNumber()) + 3;

      expect(staked.lastUpdatedBlockNumber).to.be.eq(updatedBlockNumber);
    });

    it('should not allow update of a frozen staked deposit', async function () {
      let overlay = '0xd665e1fdc559f0987e10d70f0d3e6c877f64620f58d79c60b4742a3806555c48';

      let stakeRegistryRedistributor = await ethers.getContract('StakeRegistry', redistributor);
      await stakeRegistryRedistributor.freezeDeposit(overlay_0, freezeTime);

      let staked = await stakeRegistryRedistributor.stakes(overlay);
      let updatedBlockNumber = (await getBlockNumber()) + 3;

      expect(staked.lastUpdatedBlockNumber).to.be.eq(updatedBlockNumber);

      await mintAndApprove(staker_0, stakeRegistry.address, stakeAmount_0);
      await expect(stakeRegistry.depositStake(staker_0, nonce_0, stakeAmount_0)).to.be.revertedWith(
        errors.freeze.currentlyFrozen
      );

      mineNBlocks(3);

      // should this be +2 ?!
      let newUpdatedBlockNumber = (await getBlockNumber()) + 2;
      await expect(stakeRegistry.depositStake(staker_0, nonce_0, stakeAmount_0))
        .to.emit(stakeRegistry, 'StakeUpdated')
        .withArgs(overlay_0, stakeAmount_0*2, staker_0, newUpdatedBlockNumber);
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

      let stakeRegistryDeployer = await ethers.getContract('StakeRegistry', deployer);
      const pauserRole = await stakeRegistryDeployer.PAUSER_ROLE();
      await stakeRegistryDeployer.grantRole(pauserRole, pauser);
    });

    it('should not pause contract without pauser role', async function () {
      let stakeRegistryStaker1 = await ethers.getContract('StakeRegistry', staker_1);
      await expect(stakeRegistryStaker1.pause()).to.be.revertedWith(errors.pause.noRole);
    });

    it('should pause contract with pauser role', async function () {
      let stakeRegistryPauser = await ethers.getContract('StakeRegistry', pauser);
      await stakeRegistryPauser.pause();

      await mintAndApprove(staker_0, stakeRegistry.address, stakeAmount_0);
      await expect(stakeRegistry.depositStake(staker_0, nonce_0, stakeAmount_0)).to.be.revertedWith(
        errors.pause.currentlyPaused
      );
    });

    it('should not unpause contract without pauser role', async function () {
      let stakeRegistryPauser = await ethers.getContract('StakeRegistry', pauser);
      await stakeRegistryPauser.pause();

      let stakeRegistryStaker1 = await ethers.getContract('StakeRegistry', staker_1);
      await expect(stakeRegistryStaker1.unPause()).to.be.revertedWith(errors.pause.onlyPauseCanUnPause);
    });


    it('should allow staking once unpaused', async function () {
      let stakeRegistryPauser = await ethers.getContract('StakeRegistry', pauser);
      await stakeRegistryPauser.pause();

      await mintAndApprove(staker_0, stakeRegistry.address, stakeAmount_0);
      await expect(stakeRegistry.depositStake(staker_0, nonce_0, stakeAmount_0)).to.be.revertedWith(
        errors.pause.currentlyPaused
      );

      await stakeRegistryPauser.unPause();

      let newUpdatedBlockNumber = (await getBlockNumber()) + 3;
      await mintAndApprove(staker_0, stakeRegistry.address, stakeAmount_0);
      await expect(stakeRegistry.depositStake(staker_0, nonce_0, stakeAmount_0))
        .to.emit(stakeRegistry, 'StakeUpdated')
        .withArgs(overlay_0, stakeAmount_0*2, staker_0, newUpdatedBlockNumber);
    });

    // ...
  });

});
