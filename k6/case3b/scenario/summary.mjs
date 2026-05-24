import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const DEFAULT_INPUT = 'k6/case3b/result/summary-latest.json';
const inputPath = process.argv[2] ?? DEFAULT_INPUT;
const INITIAL = Number(process.env.INITIAL || 1_000_000);
const PHASE_SEC = Number(process.env.PHASE_SEC || 30);

const raw = await readFile(resolve(inputPath), 'utf8');
const data = JSON.parse(raw);

const VARIANTS = ['pessimistic', 'queue', 'redis'];
const STATS = ['avg', 'med', 'p(95)', 'p(99)', 'max'];

function num(key, field = 'count') {
  return data.metrics[key]?.values?.[field] ?? null;
}

function fmtInt(n) {
  return n == null ? '       --' : String(n).padStart(9);
}

function fmtMs(n) {
  if (n == null || Number.isNaN(n)) return '       --';
  return `${n.toFixed(2).padStart(8)}ms`;
}

function fmtPct(n) {
  if (n == null || Number.isNaN(n)) return '     --';
  return `${n.toFixed(2).padStart(5)}%`;
}

console.log('\n=== Case 3-B: 정합성 (INITIAL=' + INITIAL + ') ===');
console.log(`source: ${inputPath}`);
console.log(
  `  ${'variant'.padEnd(12)}  ${'applied'.padStart(9)}  ${'actual'.padStart(9)}  ${'lost'.padStart(9)}  ${'lost%'.padStart(7)}`,
);
for (const v of VARIANTS) {
  const applied = num(`applied_true{variant:${v}}`, 'count');
  const finalBal = num(`final_balance{variant:${v}}`, 'count');
  const actual = finalBal == null ? null : INITIAL - finalBal;
  const lost = applied == null || actual == null ? null : applied - actual;
  const lostPct =
    applied == null || lost == null || applied === 0
      ? null
      : (lost / applied) * 100;
  console.log(
    `  ${v.padEnd(12)}  ${fmtInt(applied)}  ${fmtInt(actual)}  ${fmtInt(lost)}  ${fmtPct(lostPct)}`,
  );
}

console.log('\n=== http_req_duration ===');
console.log(
  `  ${'variant'.padEnd(12)}  ${STATS.map((s) => s.padStart(10)).join('  ')}`,
);
for (const v of VARIANTS) {
  const vals = data.metrics[`http_req_duration{variant:${v}}`]?.values ?? {};
  const cells = STATS.map((s) => fmtMs(vals[s])).join('  ');
  console.log(`  ${v.padEnd(12)}  ${cells}`);
}

console.log('\n=== Throughput ===');
console.log(
  `  ${'variant'.padEnd(12)}  ${'reqs'.padStart(7)}  ${'rps'.padStart(7)}  ${'applied/s'.padStart(10)}  ${'fail%'.padStart(7)}`,
);
for (const v of VARIANTS) {
  const reqs = num(`http_reqs{variant:${v}}`, 'count');
  const applied = num(`applied_true{variant:${v}}`, 'count');
  const failRate = num(`http_req_failed{variant:${v}}`, 'rate');
  const rps = reqs == null ? null : reqs / PHASE_SEC;
  const applRps = applied == null ? null : applied / PHASE_SEC;
  console.log(
    `  ${v.padEnd(12)}  ${fmtInt(reqs)}  ${rps == null ? '     --' : rps.toFixed(1).padStart(7)}  ${applRps == null ? '        --' : applRps.toFixed(1).padStart(10)}  ${fmtPct(failRate == null ? null : failRate * 100)}`,
  );
}

console.log('\n=== Redis-DB Drift (B 변형 정합성 윈도우) ===');
const driftAvg = num('redis_db_drift', 'avg');
const driftMax = num('redis_db_drift', 'max');
console.log(
  `  reset 시점 |db - redis| — avg: ${driftAvg == null ? '--' : driftAvg.toFixed(2)}, max: ${driftMax == null ? '--' : driftMax.toFixed(2)}`,
);

console.log('');
