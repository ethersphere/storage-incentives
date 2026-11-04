// Point Settlement at a new program key (after a change to the zkVM program), without a new deployment.
//
//   PROGRAM_VKEY=0x00... npx hardhat run scripts/zk/set-verifier.ts --network sepoliazk
//
// The verifier stays the same unless ZK_VERIFIER=<address> is set. Admin only. The change takes effect after
// Settlement.verifierDelay (0 on test networks): the script proposes it, and applies it once the delay is over.
import { deployments, ethers } from 'hardhat';

async function main() {
  const vkey = process.env.PROGRAM_VKEY || '';
  if (!/^0x[0-9a-fA-F]{64}$/.test(vkey)) throw new Error('set PROGRAM_VKEY (prover/target/release/swarm-prover vkey)');
  const [admin] = await ethers.getSigners();
  const s = await ethers.getContractAt('Settlement', (await deployments.get('Settlement')).address, admin);
  const verifier = process.env.ZK_VERIFIER || (await s.verifier());
  const current = await s.programVKey();
  if (current.toLowerCase() === vkey.toLowerCase() && verifier.toLowerCase() === (await s.verifier()).toLowerCase()) {
    console.log(`Settlement ${s.address} already uses verifier ${verifier} and program key ${vkey}`);
    return;
  }
  const pending = await s.pendingVerifier();
  if (pending.eta.eq(0) || pending.programVKey.toLowerCase() !== vkey.toLowerCase()) {
    await (await s.proposeVerifier(verifier, vkey)).wait();
    console.log(`proposed program key ${vkey} (verifier ${verifier}); delay ${await s.verifierDelay()} s`);
  }
  const eta = (await s.pendingVerifier()).eta.toNumber();
  const now = (await ethers.provider.getBlock('latest')).timestamp;
  if (now < eta) {
    console.log(`apply after ${new Date(eta * 1000).toISOString()}: run this script again then`);
    return;
  }
  const rc = await (await s.applyVerifier()).wait();
  console.log(`Settlement ${s.address}: program key ${current} -> ${vkey} (verifier ${verifier}), gas ${rc.gasUsed}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
