import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const DEFAULT_INPUT = 'k6/case5/result/summary-latest.json';
const inputPath = process.argv[2] ?? DEFAULT_INPUT;

const raw = await readFile(resolve(inputPath), 'utf8');
const data = JSON.parse(raw);

const STATS = ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'];
const VARIANTS = ['naive', 'singleflight', 'redis-lock', 'xfetch'];
const SOURCES = ['cache', 'db', 'stale'];
const ENDPOINTS = ['product', 'probe'];

function getDurationValues(endpoint, variant) {
  const key = `http_req_duration{endpoint:${endpoint},variant:${variant}}`;
  return data.metrics[key]?.values ?? {};
}

function getSourceCount(variant, source) {
  const key = `case5_source{source:${source},variant:${variant}}`;
  return data.metrics[key]?.values?.count ?? 0;
}

function getReqCount(variant) {
  const key = `http_reqs{variant:${variant}}`;
  return data.metrics[key]?.values?.count ?? null;
}

function getFailRate(variant) {
  const failKey = Object.keys(data.metrics).find(
    (k) =>
      k.startsWith('http_req_failed{') && k.includes(`variant:${variant}`),
  );
  return data.metrics[failKey]?.values?.rate ?? null;
}

function fmtMs(n) {
  if (n == null || Number.isNaN(n)) return '      --';
  return `${n.toFixed(1).padStart(7)}ms`;
}

function pad(s, w) {
  return String(s).padStart(w);
}

console.log('\n=== Cache Stampede Mitigation Comparison ===');
console.log(`source: ${inputPath}`);

for (const ep of ENDPOINTS) {
  console.log(`\n[${ep}] http_req_duration`);
  const header = ['stat'.padEnd(6), ...VARIANTS.map((v) => pad(v, 14))].join(
    '  ',
  );
  console.log(`  ${header}`);
  for (const stat of STATS) {
    const cells = VARIANTS.map((v) => {
      const val = getDurationValues(ep, v)[stat];
      return pad(fmtMs(val), 14);
    });
    console.log(`  ${stat.padEnd(6)}  ${cells.join('  ')}`);
  }
}

console.log('\n[source distribution]   (DB call rate = db / total)');
const headerSrc = [
  'variant'.padEnd(14),
  ...SOURCES.map((s) => pad(s, 10)),
  pad('total', 10),
  pad('db%', 8),
].join('  ');
console.log(`  ${headerSrc}`);
for (const v of VARIANTS) {
  const counts = SOURCES.map((s) => getSourceCount(v, s));
  const total = counts.reduce((a, b) => a + b, 0);
  const dbPct = total > 0 ? ((counts[1] / total) * 100).toFixed(2) : '--';
  const cells = counts.map((c) => pad(c, 10));
  console.log(
    `  ${v.padEnd(14)}  ${cells.join('  ')}  ${pad(total, 10)}  ${pad(
      `${dbPct}%`,
      8,
    )}`,
  );
}

console.log('\n[throughput / errors]');
const headerTp = [
  'variant'.padEnd(14),
  pad('reqs', 10),
  pad('req/s', 10),
  pad('fail%', 8),
].join('  ');
console.log(`  ${headerTp}`);
for (const v of VARIANTS) {
  const reqs = getReqCount(v);
  const reqsStr = reqs != null ? String(reqs) : '--';
  const reqRate =
    reqs != null ? (reqs / Number(process.env.PHASE_SEC || 30)).toFixed(1) : '--';
  const failRate = getFailRate(v);
  const failStr = failRate != null ? `${(failRate * 100).toFixed(2)}%` : '--';
  console.log(
    `  ${v.padEnd(14)}  ${pad(reqsStr, 10)}  ${pad(reqRate, 10)}  ${pad(
      failStr,
      8,
    )}`,
  );
}

console.log('');
