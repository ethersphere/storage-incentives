import { expect } from './util/chai';
import { ethers, getNamedAccounts, getUnnamedAccounts, deployments } from 'hardhat';
import {
  mineNBlocks,
  encodeAndHash,
  mintAndApprove,
  createOverlay,
  ROUND_LENGTH,
  PHASE_LENGTH,
  copyBatchForClaim,
  mineToRevealPhase,
} from './util/tools';
import { BigNumber } from 'ethers';
import { arrayify, hexlify } from 'ethers/lib/utils';
import { addSocProofAttachments, getClaimProofs, loadWitnesses, makeSample } from './util/proofs';

const { read, execute } = deployments;

interface Outcome {
  node: string;
  stake: string;
  wins: number;
}

// Named accounts used by tests.
let deployer: string, stamper: string, oracle: string, pauser: string;
let others: string[];

// Before the tests, assign accounts
before(async function () {
  const namedAccounts = await getNamedAccounts();
  deployer = namedAccounts.deployer;
  stamper = namedAccounts.stamper;
  oracle = namedAccounts.oracle;
  pauser = namedAccounts.pauser;
  others = await getUnnamedAccounts();
});

async function nPlayerGames(nodes: string[], stakes: string[], trials: number) {
  const price1 = 100;

  const postageStampOracle = await ethers.getContract('PostageStamp', oracle);
  await postageStampOracle.setPrice(price1);

  const postageStampAdmin = await ethers.getContract('PostageStamp', deployer);
  await postageStampAdmin.setMinimumValidityBlocks(0);

  const { postageDepth, initialBalance, batchId, batchOwner } = await copyBatchForClaim(deployer);

  const batchSize = BigNumber.from(2).pow(BigNumber.from(postageDepth));
  const transferAmount = BigNumber.from(2).mul(BigNumber.from(initialBalance)).mul(batchSize);

  const postage = await ethers.getContract('PostageStamp', stamper);

  await mintAndApprove(deployer, stamper, postage.address, transferAmount.toString());

  const depth = '0x00';
  const nonce = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';
  const reveal_nonce = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';

  for (let i = 0; i < nodes.length; i++) {
    const sr_node = await ethers.getContract('StakeRegistry', nodes[i]);
    await mintAndApprove(deployer, nodes[i], sr_node.address, stakes[i]);
    await sr_node.depositStake(nodes[i], nonce, stakes[i]);
  }

  const winDist: Outcome[] = [];
  for (let i = 0; i < nodes.length; i++) {
    winDist.push({ node: nodes[i], stake: stakes[i], wins: 0 });
  }

  let r_node = await ethers.getContract('Redistribution', nodes[0]);

  await mineNBlocks(ROUND_LENGTH * 2); // anyway reverted with panic code 0x11 (Arithmetic operation underflowed or overflowed outside of an unchecked block

  const witnessChunks = loadWitnesses('stats');

  for (let i = 0; i < trials; i++) {
    const anchor1 = arrayify(await r_node.currentSeed());
    // add soc chunks to cacs
    // TODO: mine new witness chunks because of new anchor and reserve estimation
    await addSocProofAttachments(witnessChunks, anchor1, Number(depth));
    const sampleChunk = makeSample(witnessChunks, anchor1);
    const sampleHashString = hexlify(sampleChunk.address());

    for (let i = 0; i < nodes.length; i++) {
      const r_node = await ethers.getContract('Redistribution', nodes[i]);
      const overlay = createOverlay(nodes[i], depth, nonce);
      const obsfucatedHash = encodeAndHash(overlay, depth, sampleHashString, reveal_nonce);
      const currentRound = await r_node.currentRound();
      await r_node.commit(obsfucatedHash, overlay, currentRound);
    }

    await mineToRevealPhase();

    for (let i = 0; i < nodes.length; i++) {
      const r_node = await ethers.getContract('Redistribution', nodes[i]);
      const overlay = createOverlay(nodes[i], depth, nonce);
      await r_node.reveal(overlay, depth, sampleHashString, reveal_nonce);
    }

    const anchor2 = await r_node.currentSeed(); // for creating proofs

    await mineNBlocks(PHASE_LENGTH - nodes.length + 1);

    for (let i = 0; i < winDist.length; i++) {
      const overlay = createOverlay(winDist[i].node, depth, nonce);
      if (await r_node.isWinner(overlay)) {
        winDist[i].wins++;
      }
    }
    let winnerIndex = 0;
    for (const [index, outcome] of winDist.entries()) {
      if (outcome.wins > 0) {
        winnerIndex = index;
        break;
      }
    }
    r_node = await ethers.getContract('Redistribution', nodes[winnerIndex]);

    const { proofParams } = await getClaimProofs(witnessChunks, sampleChunk, anchor1, anchor2, batchOwner, batchId);

    await r_node.claim(proofParams.proof1, proofParams.proof2, proofParams.proofLast);

    const sr = await ethers.getContract('StakeRegistry');

    //stakes are preserved
    for (let i = 0; i < nodes.length; i++) {
      const overlay = createOverlay(nodes[i], '0x00', nonce);
      expect(await sr.usableStakeOfOverlay(overlay)).to.be.eq(stakes[i]);
    }

    await mineNBlocks(PHASE_LENGTH * 2 - nodes.length);
  }

  return winDist;
}

describe('Stats', async function () {
  beforeEach(async function () {
    await deployments.fixture();
    const priceOracleRole = await read('PostageStamp', 'PRICE_ORACLE_ROLE');
    await execute('PostageStamp', { from: deployer }, 'grantRole', priceOracleRole, oracle);

    const pauserRole = await read('StakeRegistry', 'PAUSER_ROLE');
    await execute('StakeRegistry', { from: deployer }, 'grantRole', pauserRole, pauser);
  });

  describe('two player game', async function () {
    const trials = 150;

    it('is fair with 1:3 stake', async function () {
      this.timeout(0);
      const allowed_variance = 0.035;
      const stakes = ['100000000000000000', '300000000000000000'];
      const nodes = [others[0], others[1]];

      const dist = await nPlayerGames(nodes, stakes, trials);
      let sumStakes = BigInt(0);
      for (let i = 0; i < stakes.length; i++) {
        sumStakes += BigInt(stakes[i]);
      }

      for (let i = 0; i < dist.length; i++) {
        const actual =
          parseInt((BigInt(dist[i].stake) / BigInt('100000000000000000')).toString()) /
          parseInt((sumStakes / BigInt('100000000000000000')).toString());
        const probable = dist[i].wins / trials;
        expect(Math.abs(actual - probable)).be.lessThan(allowed_variance);
      }
    });
  });
});
