import { DeployFunction } from 'hardhat-deploy/types';

// Settlement gets the three roles Redistribution holds on master, and the prover key gets ANCHOR_ROLE.
// Then set a price and buy one batch, so the pot grows and winners have something to win.
const func: DeployFunction = async function ({ deployments, getNamedAccounts, ethers }) {
  const { get, read, execute, log } = deployments;
  const { deployer } = await getNamedAccounts();
  const settlement = (await get('Settlement')).address;
  const oracle = (await get('PriceOracle')).address;
  const postage = (await get('PostageStamp')).address;
  const from = { from: deployer, log: true };

  const grant = async (contract: string, role: string, to: string) => {
    const r = await read(contract, role);
    if (!(await read(contract, 'hasRole', r, to))) await execute(contract, from, 'grantRole', r, to);
  };
  await grant('PostageStamp', 'PRICE_ORACLE_ROLE', oracle);
  await grant('PostageStamp', 'REDISTRIBUTOR_ROLE', settlement);
  await grant('StakeRegistry', 'REDISTRIBUTOR_ROLE', settlement);
  await grant('PriceOracle', 'PRICE_UPDATER_ROLE', settlement);
  const prover = process.env.PROVER_ADDRESS || deployer;
  await grant('Settlement', 'ANCHOR_ROLE', prover);
  log(`ANCHOR_ROLE granted to prover ${prover}`);

  // STAKE_AGE_ROUNDS=0 lets nodes play in the round after they stake (test networks). Default: 2.
  const age = Number(process.env.STAKE_AGE_ROUNDS ?? 2);
  if ((await read('Settlement', 'stakeAgeRounds')) !== age) {
    await execute('Settlement', from, 'setStakeAgeRounds', age);
  }
  log(`Settlement.stakeAgeRounds = ${age}`);

  // WARM_RING=n fills the next n round-ring entries once (from the current round on), so that those rounds
  // already pay the reuse price for anchors and forced messages. 256 fills the whole ring. On Sepolia each
  // entry costs about 0.7M gas, so it is done in parts of 16.
  const warm = Number(process.env.WARM_RING ?? 0);
  if (warm > 0) {
    const ring = Number(await read('Settlement', 'RING_SIZE'));
    const round = Math.floor(
      (await ethers.provider.getBlockNumber()) / Number(await read('Settlement', 'ROUND_LENGTH'))
    );
    for (let done = 0; done < Math.min(warm, ring); done += 16) {
      const n = Math.min(16, Math.min(warm, ring) - done);
      const start = (round + done) % ring;
      // Entries wrap around the end of the ring: warm the part up to the end, then the part from 0.
      const first = Math.min(n, ring - start);
      await execute('Settlement', from, 'warmRing', start, first);
      if (first < n) await execute('Settlement', from, 'warmRing', 0, n - first);
    }
    log(`warmed ${Math.min(warm, ring)} ring entries from round ${round}`);
  }

  if ((await read('PostageStamp', 'lastPrice')).eq(0)) {
    await execute('PriceOracle', from, 'setPrice', 24000);
  }
  const nonce = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('zk-settlement-pot'));
  const batchId = ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(['address', 'bytes32'], [deployer, nonce])
  );
  if ((await read('PostageStamp', 'batches', batchId)).owner === ethers.constants.AddressZero) {
    const perChunk = (await read('PostageStamp', 'minimumInitialBalancePerChunk')).mul(4);
    await execute('TestToken', from, 'approve', postage, perChunk.mul(1 << 20));
    await execute('PostageStamp', from, 'createBatch', deployer, perChunk, 20, 17, nonce, false);
  }
};

export default func;
func.tags = ['zk', 'roles'];
