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
