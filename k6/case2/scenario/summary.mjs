import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const DEFAULT_INPUT = 'k6/case2/result/summary-latest.json';
const inputPath = process.argv[2] ?? DEFAULT_INPUT;

const raw = await readFile(resolve(inputPath), 'utf8');
const data = JSON.parse(raw);

const STATS = ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'];
const ENDPOINTS = ['hash', 'health'];
const VARIANTS = ['sync', 'async', 'worker'];

function getDurationValues(endpoint, variant) {
  const key = `http_req_duration{endpoint:${endpoint},variant:${variant}}`;
  return data.metrics[key]?.values ?? {};
}

function fmtMs(n) {
  if (n == null || Number.isNaN(n)) return '        --';
  return `${n.toFixed(2).padStart(8)}ms`;
}

console.log('\n=== case2 sync vs async vs worker ===');
console.log(`source: ${inputPath}`);

for (const ep of ENDPOINTS) {
  const sync = getDurationValues(ep, 'sync');
  const async_ = getDurationValues(ep, 'async');
  const worker = getDurationValues(ep, 'worker');

  console.log(`\n[${ep}] http_req_duration`);
  console.log(
    `  ${'stat'.padEnd(7)}  ${'sync'.padStart(10)}  ${'async'.padStart(10)}  ${'worker'.padStart(10)}`,
  );
  for (const stat of STATS) {
    console.log(
      `  ${stat.padEnd(7)}  ${fmtMs(sync[stat])}  ${fmtMs(async_[stat])}  ${fmtMs(worker[stat])}`,
    );
  }
}

console.log('\n[throughput / errors]');
console.log(
  `  ${'variant'.padEnd(8)}  ${'reqs(count)'.padStart(12)}  ${'fail rate'.padStart(10)}`,
);
for (const variant of VARIANTS) {
  const reqs =
    data.metrics[`http_reqs{variant:${variant}}`]?.values?.count ?? null;
  const failKey = Object.keys(data.metrics).find(
    (k) => k.startsWith('http_req_failed{') && k.includes(`variant:${variant}`),
  );
  const failRate = data.metrics[failKey]?.values?.rate ?? null;
  const reqsStr = reqs != null ? String(reqs).padStart(12) : '          --';
  const failStr =
    failRate != null
      ? `${(failRate * 100).toFixed(2)}%`.padStart(10)
      : '        --';
  console.log(`  ${variant.padEnd(8)}  ${reqsStr}  ${failStr}`);
}

console.log('');
