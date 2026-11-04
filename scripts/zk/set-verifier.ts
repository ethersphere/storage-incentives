// Point Settlement at a new program key (after a change to the zkVM program), without a new deployment.
//
//   PROGRAM_VKEY=0x00... npx hardhat run scripts/zk/set-verifier.ts --network sepoliazk
//
// The verifier stays the same unless ZK_VERIFIER=<address> is set. Admin only. On mainnet this call must be
// behind a timelock (docs/ZK-SETTLEMENT.md, open items).
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
  const rc = await (await s.setVerifier(verifier, vkey)).wait();
  console.log(`Settlement ${s.address}: program key ${current} -> ${vkey} (verifier ${verifier}), gas ${rc.gasUsed}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
