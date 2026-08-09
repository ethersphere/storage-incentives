import { expect } from './util/chai';
import { ethers } from 'hardhat';
import { hexlify } from 'ethers/lib/utils';
import { randomBytes } from 'crypto';

describe('Signatures', () => {
  let harness: Awaited<ReturnType<typeof deployHarness>>;

  async function deployHarness() {
    const factory = await ethers.getContractFactory('SignaturesHarness');
    return factory.deploy();
  }

  before(async () => {
    harness = await deployHarness();
  });

  it('rejects SOC verification bypass via address(0) and malformed signature', async () => {
    const identifier = randomBytes(32);
    const chunkAddr = randomBytes(32);
    const malformedSignature = '0x' + '00'.repeat(65);

    const verified = await harness.socVerify(
      ethers.constants.AddressZero,
      malformedSignature,
      hexlify(identifier),
      hexlify(chunkAddr)
    );

    expect(verified).to.be.false;
  });

  it('rejects SOC verification with invalid signature length', async () => {
    const identifier = randomBytes(32);
    const chunkAddr = randomBytes(32);
    const shortSignature = '0x' + '00'.repeat(64);

    const verified = await harness.socVerify(
      ethers.Wallet.createRandom().address,
      shortSignature,
      hexlify(identifier),
      hexlify(chunkAddr)
    );

    expect(verified).to.be.false;
  });

  it('rejects SOC verification with high-s malleable signature', async () => {
    const wallet = ethers.Wallet.createRandom();
    const identifier = randomBytes(32);
    const chunkAddr = randomBytes(32);
    const messageHash = ethers.utils.solidityKeccak256(['bytes32', 'bytes32'], [identifier, chunkAddr]);
    const signature = await wallet.signMessage(ethers.utils.arrayify(messageHash));

    const { r, s, v } = ethers.utils.splitSignature(signature);
    const malleableS = ethers.BigNumber.from('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141').sub(
      ethers.BigNumber.from(s)
    );
    const malleableSignature = ethers.utils.hexConcat([
      r,
      ethers.utils.hexZeroPad(malleableS.toHexString(), 32),
      ethers.utils.hexlify(v === 27 ? 28 : 27),
    ]);

    const verified = await harness.socVerify(
      wallet.address,
      malleableSignature,
      hexlify(identifier),
      hexlify(chunkAddr)
    );

    expect(verified).to.be.false;
  });

  it('accepts a valid SOC signature', async () => {
    const wallet = ethers.Wallet.createRandom();
    const identifier = randomBytes(32);
    const chunkAddr = randomBytes(32);
    const messageHash = ethers.utils.solidityKeccak256(['bytes32', 'bytes32'], [identifier, chunkAddr]);
    const signature = await wallet.signMessage(ethers.utils.arrayify(messageHash));

    const verified = await harness.socVerify(wallet.address, signature, hexlify(identifier), hexlify(chunkAddr));

    expect(verified).to.be.true;
  });
});
