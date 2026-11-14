import { expect } from './util/chai';
import { ethers } from 'hardhat';

// MiMC.sol against gnark-crypto: MiMC(1, 2, 3) is the vector of `snarkd vectors`
// (prover/crates/vm/src/snark/vectors_mimc.txt).
describe('MiMC', function () {
  it('matches gnark-crypto and reports the gas of one compression', async function () {
    const [deployer] = await ethers.getSigners();
    const Staking = await ethers.getContractFactory('GameKeyRegistry');
    const reg = await Staking.deploy(deployer.address);
    expect((await reg.mimc([1, 2, 3])).toString()).to.eq(
      '1594628425784724590720470781298820968689131300912933114724835803309940639844'
    );
    const g1 = await reg.estimateGas.compress(1, 2);
    const g3 = await reg.estimateGas.mimc([1, 2, 3]);
    console.log(`      compress: ${g1.toNumber() - 21000} gas; one more element: ${g3.sub(g1).div(2).toNumber()} gas`);
  });
});
