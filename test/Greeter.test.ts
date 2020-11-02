import { expect } from './util/chai';
import { ethers, deployments, getNamedAccounts, getUnnamedAccounts } from 'hardhat';

// Named accounts used by tests.
let admin: string, other: string;

// Before the tests, set named accounts and read deployments.
before(async function () {
  const namedAccounts = await getNamedAccounts();
  const others = await getUnnamedAccounts();
  admin = namedAccounts.admin;
  other = others[0];
});

describe('Greeter', function () {
  describe('when deploying contract', function () {
    beforeEach(async function () {
      await deployments.fixture();
    });

    it('should deploy Greeter', async function () {
      const Greeter = await ethers.getContract('Greeter');
      expect(Greeter.address).to.be.a('string');
    });

    it('should set the correct initial greeting', async function () {
      const Greeter = await ethers.getContract('Greeter');
      expect(await Greeter.getGreeting()).to.be.eq('Hello World!');
    });

    it('should set the correct admin account', async function () {
      const Greeter = await ethers.getContract('Greeter');
      expect(await Greeter.getAdmin()).to.be.eq(admin);
    });
  });

  describe('with deployed contract', async function () {
    beforeEach(async function () {
      await deployments.fixture();
    });
    describe('when setting admin', function () {
      it('should revert if not called by admin', async function () {
        const Greeter = await ethers.getContract('Greeter', other);
        await expect(Greeter.setAdmin(other)).to.revertedWith('Must be called by admin');
      });

      it('should set the new admin when called by admin', async function () {
        const Greeter = await ethers.getContract('Greeter', admin);
        await expect(Greeter.setAdmin(other)).to.emit(Greeter, 'AdminChanged').withArgs(other);
        expect(await Greeter.getAdmin()).to.be.eq(other);
      });
    });

    describe('when setting greeting', function () {
      it('should revert if not called by an admin', async function () {
        const Greeter = await ethers.getContract('Greeter', other);
        await expect(Greeter.setGreeting('Fail')).to.be.revertedWith('Must be called by admin');
      });

      it('should set the greeting if called by an admin', async function () {
        const Greeter = await ethers.getContract('Greeter', admin);
        await expect(Greeter.setGreeting('BZZZZ!')).to.emit(Greeter, 'GreetingChanged').withArgs('BZZZZ!');
        expect(await Greeter.getGreeting()).to.be.eq('BZZZZ!');
      });
    });
  });
});
