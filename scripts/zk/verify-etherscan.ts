// Verify the ZK settlement contracts of a network on Etherscan, with the Etherscan v2 API.
//
//   npx hardhat run scripts/zk/verify-etherscan.ts --network sepoliazk
//
// Uses the exact compiler input that hardhat-deploy stored at deployment (deployments/<net>/solcInputs),
// so the verified source always matches the deployed bytecode. Reads the key from TESTNET_ETHERSCAN_KEY
// (or ETHERSCAN_API_KEY). The installed @nomicfoundation/hardhat-verify (2.0.5) only knows the old
// per-chain API, which Etherscan has turned off.
import { deployments, ethers, network } from 'hardhat';
import fs from 'fs';
import path from 'path';

const API = 'https://api.etherscan.io/v2/api';
const CONTRACTS = (process.env.CONTRACTS || 'Settlement,PostageStamp,PriceOracle,StakeRegistry,TestToken').split(',');

async function api(chainId: number, params: Record<string, string>, post: boolean) {
  const url = `${API}?chainid=${chainId}`;
  const body = new URLSearchParams(params).toString();
  const signal = AbortSignal.timeout(60_000);
  const res = post
    ? await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal,
      })
    : await fetch(`${url}&${body}`, { signal });
  const text = await res.text();
  try {
    return JSON.parse(text) as { status: string; message: string; result: string };
  } catch {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
}

async function main() {
  const key = process.env.TESTNET_ETHERSCAN_KEY || process.env.ETHERSCAN_API_KEY;
  if (!key) throw new Error('set TESTNET_ETHERSCAN_KEY');
  const chainId = network.config.chainId!;

  for (const name of CONTRACTS) {
    const d = await deployments.get(name);
    const meta = JSON.parse(d.metadata!);
    const [file, contract] = Object.entries(meta.settings.compilationTarget)[0] as [string, string];
    const input = fs.readFileSync(
      path.join(__dirname, '..', '..', 'deployments', network.name, 'solcInputs', `${d.solcInputHash}.json`),
      'utf8'
    );
    const ctor = d.abi.find((f: { type: string }) => f.type === 'constructor');
    const args = ctor ? ethers.utils.defaultAbiCoder.encode(ctor.inputs, d.args || []).slice(2) : '';

    const done = await api(chainId, { apikey: key, module: 'contract', action: 'getsourcecode', address: d.address }, false);
    if (done.status === '1' && (done.result as unknown as { SourceCode: string }[])[0]?.SourceCode) {
      console.log(`${name} ${d.address}: already verified`);
      continue;
    }

    console.log(`${name} ${d.address}: submitting ${file}:${contract} (${Math.round(input.length / 1024)} KB input)`);
    const sub = await api(
      chainId,
      {
        apikey: key,
        module: 'contract',
        action: 'verifysourcecode',
        contractaddress: d.address,
        sourceCode: input,
        codeformat: 'solidity-standard-json-input',
        contractname: `${file}:${contract}`,
        compilerversion: `v${meta.compiler.version}`,
        constructorArguements: args,
      },
      true
    );
    if (sub.status !== '1') {
      console.log(`${name} ${d.address}: submit failed: ${sub.result}`);
      continue;
    }
    let result = 'no answer';
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const st = await api(chainId, { apikey: key, module: 'contract', action: 'checkverifystatus', guid: sub.result }, false);
      result = st.result;
      if (!result.startsWith('Pending')) break;
    }
    console.log(`${name} ${d.address}: ${result}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
