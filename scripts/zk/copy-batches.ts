// Migration rehearsal: copy postage batches into PostageStampZK with copyBatchBulk, and fund the contract
// with their remaining balance (copyBatch moves no tokens).
//
//   BATCHES=prover/data/gnosis/batches.json npx hardhat run scripts/zk/copy-batches.ts --network zklocal
//
// BATCHES is the output of `gnosis-postage --export-batches`. CHUNK batches go in each transaction (default
// 100). Prints the gas of each transaction, the batches that failed (CopyBatchFailed), and the total.
import { ethers, deployments, network } from 'hardhat';
import { readFileSync } from 'fs';

async function main() {
  const file = process.env.BATCHES;
  if (!file) throw new Error('set BATCHES');
  const chunk = Number(process.env.CHUNK || 100);
  const data = JSON.parse(readFileSync(file, 'utf8'));
  const batches = data.batches.map((b: Record<string, unknown>) => ({
    batchId: b.batchId,
    owner: b.owner,
    depth: b.depth,
    bucketDepth: b.bucketDepth,
    immutableFlag: b.immutableFlag,
    remainingBalance: ethers.BigNumber.from(b.remainingBalance),
  }));
  const [deployer] = await ethers.getSigners();
  const stamp = await ethers.getContractAt('PostageStampZK', (await deployments.get('PostageStamp')).address, deployer);
  const token = await ethers.getContractAt('TestToken', (await deployments.get('TestToken')).address, deployer);

  // The tokens the copied batches will pay into the pot.
  const total = batches.reduce(
    (s: ethers.BigNumber, b: { remainingBalance: ethers.BigNumber; depth: number }) =>
      s.add(b.remainingBalance.shl(b.depth)),
    ethers.BigNumber.from(0)
  );
  const have = await token.balanceOf(deployer.address);
  if (have.lt(total)) await (await token.mint(deployer.address, total.sub(have))).wait();
  await (await token.transfer(stamp.address, total)).wait();

  const before = (await stamp.eventCount()).toNumber();
  let gas = ethers.BigNumber.from(0);
  let failed = 0;
  const failedTopic = stamp.interface.getEventTopic('CopyBatchFailed');
  for (let i = 0; i < batches.length; i += chunk) {
    const part = batches.slice(i, i + chunk);
    const rc = await (await stamp.copyBatchBulk(part, { gasLimit: 30_000_000 })).wait();
    const f = rc.logs.filter((l: { topics: string[] }) => l.topics[0] === failedTopic).length;
    failed += f;
    gas = gas.add(rc.gasUsed);
    console.log(
      `batches ${i}-${i + part.length - 1}: gas ${rc.gasUsed} (${rc.gasUsed.div(part.length)} each), failed ${f}`
    );
  }
  const after = (await stamp.eventCount()).toNumber();
  console.log(
    `network ${network.name}: copied ${batches.length - failed} of ${batches.length} batches, ${
      after - before
    } log entries, ` + `gas ${gas} (${gas.div(batches.length)} each), funded ${ethers.utils.formatUnits(total, 16)} BZZ`
  );
  console.log(`expected validChunkCount after the next settlement: ${data.validChunkCount}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
