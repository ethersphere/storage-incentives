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

// SOURCIFY=1: verify on Sourcify (https://sourcify.dev, API v2) instead: the same standard JSON input, no
// API key. Blockscout shows Sourcify results.
async function sourcify(chainId: number, address: string, input: string, compiler: string, id: string) {
  const base = 'https://sourcify.dev/server/v2';
  const res = await fetch(`${base}/verify/${chainId}/${address}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stdJsonInput: JSON.parse(input), compilerVersion: compiler, contractIdentifier: id }),
    signal: AbortSignal.timeout(120_000),
  });
  const sub = (await res.json()) as { verificationId?: string; message?: string; customCode?: string };
  if (!sub.verificationId) return `${res.status} ${sub.customCode ?? ''} ${sub.message ?? ''}`;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const job = (await (await fetch(`${base}/verify/${sub.verificationId}`)).json()) as {
      isJobCompleted: boolean;
      contract?: { match?: string | null; runtimeMatch?: string | null };
      error?: { customCode?: string; message?: string };
    };
    if (!job.isJobCompleted) continue;
    if (job.error) return `failed: ${job.error.customCode} ${job.error.message}`;
    return `verified: runtime ${job.contract?.runtimeMatch}, creation ${job.contract?.match}`;
  }
  return 'still running';
}

async function main() {
  const key = process.env.TESTNET_ETHERSCAN_KEY || process.env.ETHERSCAN_API_KEY || '';
  if (!key && !process.env.SOURCIFY) throw new Error('set TESTNET_ETHERSCAN_KEY');
  const chainId = network.config.chainId!;

  for (const name of CONTRACTS) {
    const d = await deployments.get(name);
    const meta = JSON.parse(d.metadata!);
    const [file, contract] = Object.entries(meta.settings.compilationTarget)[0] as [string, string];
    const full = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, '..', '..', 'deployments', network.name, 'solcInputs', `${d.solcInputHash}.json`),
        'utf8'
      )
    );
    // Only the sources this contract was built from (its metadata lists them). The bytecode is the same:
    // the metadata hash in it covers exactly these sources. The full input has every file of the repo.
    const sources = Object.fromEntries(Object.keys(meta.sources).map((f) => [f, full.sources[f]]));
    const input = JSON.stringify({ ...full, sources });
    if (process.env.SOURCIFY) {
      const r = await sourcify(chainId, d.address, input, meta.compiler.version, `${file}:${contract}`);
      console.log(`${name} ${d.address}: Sourcify ${r}`);
      continue;
    }
    const ctor = d.abi.find((f: { type: string }) => f.type === 'constructor');
    const args = ctor ? ethers.utils.defaultAbiCoder.encode(ctor.inputs, d.args || []).slice(2) : '';

    const done = await api(
      chainId,
      { apikey: key, module: 'contract', action: 'getsourcecode', address: d.address },
      false
    );
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
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const st = await api(
        chainId,
        { apikey: key, module: 'contract', action: 'checkverifystatus', guid: sub.result },
        false
      );
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
