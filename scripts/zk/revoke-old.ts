// After a redeploy that keeps PostageStampZK: take the roles on PostageStampZK from the previous Settlement
// and PriceOracleZK, so that the old Settlement can no longer withdraw from the pot.
//
//   OLD_SETTLEMENT=0x... OLD_ORACLE=0x... npx hardhat run scripts/zk/revoke-old.ts --network sepoliazk
import { deployments, ethers } from 'hardhat';

async function main() {
  const [admin] = await ethers.getSigners();
  const p = await ethers.getContractAt('PostageStampZK', (await deployments.get('PostageStamp')).address, admin);
  const olds: [string, string | undefined][] = [
    ['REDISTRIBUTOR_ROLE', process.env.OLD_SETTLEMENT],
    ['PRICE_ORACLE_ROLE', process.env.OLD_ORACLE],
  ];
  for (const [role, who] of olds) {
    if (!who) continue;
    const r = await p[role]();
    if (await p.hasRole(r, who)) {
      await (await p.revokeRole(r, who)).wait();
      console.log(`revoked ${role} from ${who}`);
    } else {
      console.log(`${who} has no ${role}`);
    }
  }
  const s = (await deployments.get('Settlement')).address;
  const o = (await deployments.get('PriceOracle')).address;
  console.log(`current Settlement ${s} has REDISTRIBUTOR_ROLE: ${await p.hasRole(await p.REDISTRIBUTOR_ROLE(), s)}`);
  console.log(`current PriceOracleZK ${o} has PRICE_ORACLE_ROLE: ${await p.hasRole(await p.PRICE_ORACLE_ROLE(), o)}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
