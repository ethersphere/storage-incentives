import { expect } from './util/chai';
import { ethers } from 'hardhat';
import { BigNumber, Contract } from 'ethers';
import fs from 'fs';
import path from 'path';
import { PV_TYPE } from './util/publicValues';

// Soundness at the contract boundary: a real Groth16 proof of the settlement program (a round settled on
// Sepolia, test/fixtures/sp1-settlement-proof.json) checked by SP1's v6.1.0 verifier, vendored in
// src/settlement/sp1. The proof must pass as it is, and fail after any change to what Settlement executes
// (winner, freezes, pot, truth), to the inputs Settlement checks against the chain, to the program key,
// or to the proof bytes. Settlement.test.ts covers the input checks with SP1MockVerifier.

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'sp1-settlement-proof.json'), 'utf8'));
const coder = ethers.utils.defaultAbiCoder;

// Decoded ABI value -> plain objects and arrays, so a test can change one field and encode again.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function plain(v: any): any {
  if (BigNumber.isBigNumber(v)) return v;
  if (Array.isArray(v)) {
    const named = Object.keys(v).filter((k) => isNaN(Number(k)));
    if (named.length > 0) return Object.fromEntries(named.map((k) => [k, plain(v[k as keyof typeof v])]));
    return v.map(plain);
  }
  return v;
}

describe('SP1 verifier with a real settlement proof', function () {
  let verifier: Contract;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pv: any;

  before(async function () {
    verifier = await (await ethers.getContractFactory('SP1Verifier')).deploy();
    pv = plain(coder.decode([PV_TYPE], fixture.publicValues)[0]);
  });

  const encode = (v: unknown) => coder.encode([PV_TYPE], [v]);
  // verifyProof is overloaded (the inner Groth16 verifier has one too): call it by its signature.
  const SIG = 'verifyProof(bytes32,bytes,bytes)';
  // Through estimateGas: it runs the call as a transaction and throws on every revert. Hardhat's eth_call
  // returns 0x for a revert without data (a too short proof fails a calldata slice), so it cannot be used.
  const verify = (vkey: string, publicValues: string, proof: string) =>
    verifier.estimateGas[SIG](vkey, publicValues, proof);

  it('accepts the proof as it is', async function () {
    expect(encode(pv)).to.eq(fixture.publicValues);
    await verify(fixture.vkey, fixture.publicValues, fixture.proof);
    const gas = await verifier.estimateGas[SIG](fixture.vkey, fixture.publicValues, fixture.proof);
    console.log(`      verifyProof gas (estimate, hardhat): ${gas}`);
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const changes: [string, (v: any) => void][] = [
    ['another winner', (v) => (v.outcome.winner = '0x000000000000000000000000000000000000dEaD')],
    ['no truth', (v) => (v.outcome.hasTruth = !v.outcome.hasTruth)],
    ['unclaimed flag', (v) => (v.outcome.unclaimed = !v.outcome.unclaimed)],
    ['another truth hash', (v) => (v.outcome.truthHash = ethers.utils.keccak256('0x01'))],
    ['higher redundancy', (v) => (v.outcome.redundancy = v.outcome.redundancy + 1)],
    ['higher pot', (v) => (v.outcome.postage.potAmount = BigNumber.from(v.outcome.postage.potAmount).add(1))],
    [
      'one more freeze',
      (v) => {
        v.outcome.freezeOwners = [...v.outcome.freezeOwners, '0x000000000000000000000000000000000000dEaD'];
        v.outcome.freezeDurations = [...v.outcome.freezeDurations, 1];
      },
    ],
    ['another round', (v) => (v.inputs.round = BigNumber.from(v.inputs.round).add(1))],
    ['another commit list', (v) => (v.inputs.commitsHash = ethers.utils.keccak256('0x02'))],
    ['another reveal list', (v) => (v.inputs.revealsHash = ethers.utils.keccak256('0x03'))],
    ['another stake digest', (v) => (v.inputs.stakeDigest = ethers.utils.keccak256('0x04'))],
    ['another postage log position', (v) => (v.inputs.postage.eventHash = ethers.utils.keccak256('0x05'))],
    ['another chain', (v) => (v.inputs.chainId = 1)],
  ];
  for (const [name, change] of changes) {
    it(`rejects the proof for ${name}`, async function () {
      const v = plain(coder.decode([PV_TYPE], fixture.publicValues)[0]);
      change(v);
      await expect(verify(fixture.vkey, encode(v), fixture.proof)).to.be.reverted;
    });
  }

  it('rejects the proof for another program key', async function () {
    const other = '0x' + (BigInt(fixture.vkey) ^ 1n).toString(16).padStart(64, '0');
    await expect(verify(other, fixture.publicValues, fixture.proof)).to.be.reverted;
  });

  it('rejects changed proof bytes', async function () {
    const bytes = ethers.utils.arrayify(fixture.proof);
    for (const i of [4, 40, 100, 200, bytes.length - 1]) {
      const b = Uint8Array.from(bytes);
      b[i] ^= 1;
      await expect(verify(fixture.vkey, fixture.publicValues, ethers.utils.hexlify(b))).to.be.reverted;
    }
    await expect(verify(fixture.vkey, fixture.publicValues, ethers.utils.hexlify(bytes.slice(0, 200)))).to.be
      .reverted;
  });
});
