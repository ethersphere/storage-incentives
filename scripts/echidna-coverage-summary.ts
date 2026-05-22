/**
 * Summarize Echidna LCOV coverage with action-only metrics.
 *
 * Echidna records coverage during fuzz transactions (act_*). echidna_* property
 * checks run afterward via eth_call and do not appear in coverage, which makes
 * raw file percentages look worse than action exploration really is.
 *
 * Usage:
 *   yarn ts-node scripts/echidna-coverage-summary.ts
 *   yarn ts-node scripts/echidna-coverage-summary.ts EchidnaRedistributionHarness
 *   yarn ts-node scripts/echidna-coverage-summary.ts EchidnaRedistributionHarness --coverage-dir echidna/corpus/by-contract/EchidnaRedistributionHarness/coverage
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const HARNESS_DIR = path.join(ROOT, 'src', 'echidna');

type CoverageTriple = [pct: number, covered: number, total: number];

interface Summary {
  harness: string;
  lcov: string;
  fileTotal: CoverageTriple;
  actions: CoverageTriple;
  properties: CoverageTriple;
  propertiesLine: number;
}

function discoverHarnesses(): string[] {
  return fs
    .readdirSync(HARNESS_DIR)
    .filter((f) => /^Echidna.*Harness\.sol$/.test(f))
    .map((f) => path.basename(f, '.sol'))
    .sort();
}

function harnessContractStart(lines: string[], harness: string): number {
  const needle = `contract ${harness}`;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith(needle)) return i + 1;
  }
  throw new Error(`contract ${harness} not found in src/echidna/${harness}.sol`);
}

function propertiesSectionStart(lines: string[], harnessStart: number): number {
  for (let i = harnessStart; i <= lines.length; i++) {
    const line = lines[i - 1].trim();
    if (line.startsWith('//') && line.includes('Properties')) return i;
  }
  for (let i = harnessStart; i <= lines.length; i++) {
    if (lines[i - 1].includes('function echidna_')) return i;
  }
  return lines.length + 1;
}

function latestLcov(coverageDir: string): string | null {
  if (!fs.existsSync(coverageDir)) return null;
  const files = fs
    .readdirSync(coverageDir)
    .filter((f) => /^covered\..*\.lcov$/.test(f))
    .map((f) => path.join(coverageDir, f))
    .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
  return files.length > 0 ? files[files.length - 1] : null;
}

function parseLcovHits(lcovPath: string, harness: string): Map<number, number> {
  const text = fs.readFileSync(lcovPath, 'utf8');
  const suffix = `/${harness}.sol`;
  let blockStart = -1;
  for (const match of text.matchAll(/^SF:(.+)$/gm)) {
    if (match[1].endsWith(suffix)) blockStart = match.index ?? -1;
  }
  if (blockStart < 0) {
    throw new Error(`${harness}.sol not present in ${path.basename(lcovPath)}`);
  }

  const rest = text.slice(blockStart);
  const end = rest.indexOf('end_of_record');
  const block = end >= 0 ? rest.slice(0, end) : rest;

  const hits = new Map<number, number>();
  for (const line of block.split('\n')) {
    if (!line.startsWith('DA:')) continue;
    const [lnS, cntS] = line.slice(3).split(',', 2);
    hits.set(Number(lnS), Number(cntS));
  }
  return hits;
}

function coveragePct(hits: Map<number, number>, lo: number, hi: number): CoverageTriple {
  const lines: number[] = [];
  for (let ln = lo; ln <= hi; ln++) {
    if (hits.has(ln)) lines.push(ln);
  }
  if (lines.length === 0) return [0, 0, 0];
  const covered = lines.filter((ln) => (hits.get(ln) ?? 0) > 0).length;
  return [(100 * covered) / lines.length, covered, lines.length];
}

function summarize(harness: string, coverageDir: string): Summary | null {
  const srcPath = path.join(HARNESS_DIR, `${harness}.sol`);
  if (!fs.existsSync(srcPath)) {
    throw new Error(`missing source file ${srcPath}`);
  }

  const lcovPath = latestLcov(coverageDir);
  if (!lcovPath) return null;

  const lines = fs.readFileSync(srcPath, 'utf8').split('\n');
  const harnessStart = harnessContractStart(lines, harness);
  const propStart = propertiesSectionStart(lines, harnessStart);
  const hits = parseLcovHits(lcovPath, harness);

  return {
    harness,
    lcov: path.basename(lcovPath),
    fileTotal: coveragePct(hits, 1, lines.length),
    actions: coveragePct(hits, harnessStart, propStart - 1),
    properties: coveragePct(hits, propStart, lines.length),
    propertiesLine: propStart,
  };
}

function fmtPct([pct, covered, total]: CoverageTriple): string {
  return `${pct.toFixed(1).padStart(5)}% (${covered}/${total})`;
}

function printSummary(result: Summary): void {
  console.log(`==> echidna coverage: ${result.harness} (${result.lcov})`);
  console.log(`    harness file total: ${fmtPct(result.fileTotal)}`);
  console.log(`    actions only:       ${fmtPct(result.actions)}`);
  console.log(
    `    properties block:   ${fmtPct(result.properties)}  (from line ${result.propertiesLine}; not measured during fuzz txs)`
  );
}

function parseArgs(argv: string[]): { harnesses: string[]; coverageDir?: string } {
  const harnesses: string[] = [];
  let coverageDir: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--coverage-dir') {
      coverageDir = argv[++i];
      if (!coverageDir) throw new Error('--coverage-dir requires a path');
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`unknown option ${arg}`);
    }
    harnesses.push(arg);
  }

  return { harnesses, coverageDir };
}

function main(): number {
  const { harnesses: argHarnesses, coverageDir: globalCoverageDir } = parseArgs(process.argv.slice(2));
  const harnesses = argHarnesses.length > 0 ? argHarnesses : discoverHarnesses();
  if (harnesses.length === 0) {
    console.error('no harness contracts found');
    return 1;
  }

  let exitCode = 0;
  for (const harness of harnesses) {
    const coverageDir =
      globalCoverageDir ?? path.join(ROOT, 'echidna', 'corpus', 'by-contract', harness, 'coverage');

    try {
      const result = summarize(harness, coverageDir);
      if (!result) {
        console.error(`==> echidna coverage: ${harness}: no covered.*.lcov in ${coverageDir}`);
        continue;
      }
      printSummary(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`==> echidna coverage: ${harness}: ${msg}`);
      exitCode = 1;
    }
  }

  return exitCode;
}

process.exit(main());
