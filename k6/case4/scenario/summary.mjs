import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const DEFAULT_INPUT = 'k6/case4/result/summary-latest.json';
const inputPath = process.argv[2] ?? DEFAULT_INPUT;

const raw = await readFile(resolve(inputPath), 'utf8');
const data = JSON.parse(raw);

const STATS = ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'];
const ENDPOINTS = ['probe', 'heavy'];
const VARIANTS = ['without-limit', 'with-limit'];

function getDurationValues(endpoint, variant) {
  const key = `http_req_duration{endpoint:${endpoint},variant:${variant}}`;
  return data.metrics[key]?.values ?? {};
}

function fmtMs(n) {
  if (n == null || Number.isNaN(n)) return '       --';
  return `${n.toFixed(2).padStart(8)}ms`;
}

function delta(a, b) {
  if (a == null || b == null || a === 0) return '';
  const pct = ((b - a) / a) * 100;
  const sign = pct >= 0 ? '+' : '';
  return ` (${sign}${pct.toFixed(1)}%)`;
}

console.log('\n=== p-limit A/B comparison ===');
console.log(`source: ${inputPath}`);

for (const ep of ENDPOINTS) {
  const withoutLimit = getDurationValues(ep, 'without-limit');
  const withLimit = getDurationValues(ep, 'with-limit');

  console.log(`\n[${ep}] http_req_duration`);
  console.log(
    `  ${'stat'.padEnd(7)}  ${'without-limit'.padStart(10)}  ${'with-limit'.padStart(10)}  delta`,
  );
  for (const stat of STATS) {
    const a = withoutLimit[stat];
    const b = withLimit[stat];
    console.log(
      `  ${stat.padEnd(7)}  ${fmtMs(a)}  ${fmtMs(b)}  ${delta(a, b)}`,
    );
  }
}

console.log('\n[throughput / errors]');
console.log(
  `  ${'variant'.padEnd(12)}  ${'reqs(count)'.padStart(12)}  ${'fail rate'.padStart(10)}`,
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
  console.log(`  ${variant.padEnd(12)}  ${reqsStr}  ${failStr}`);
}

console.log('');
