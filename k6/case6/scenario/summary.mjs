import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const DEFAULT_INPUT = 'k6/case6/result/summary-latest.json';
const inputPath = process.argv[2] ?? DEFAULT_INPUT;
const HOLD_SEC = Number(process.env.HOLD_SEC || 30);
const ARRIVAL_PEAK = Number(process.env.ARRIVAL_PEAK || 50);

const raw = await readFile(resolve(inputPath), 'utf8');
const data = JSON.parse(raw);

const VARIANTS = ['unbounded', 'drop-oldest', 'reject-429', 'prefetch-tune'];
const STATS = ['avg', 'med', 'p(95)', 'p(99)', 'max'];

function num(key, field = 'count') {
  return data.metrics[key]?.values?.[field] ?? null;
}

function fmtInt(n) {
  return n == null ? '       --' : String(Math.round(n)).padStart(9);
}
function fmtMs(n) {
  if (n == null || Number.isNaN(n)) return '         --';
  return `${n.toFixed(1).padStart(9)}ms`;
}
function fmtMb(n) {
  if (n == null || Number.isNaN(n)) return '       --';
  return `${n.toFixed(1).padStart(6)}MB`;
}
function fmtPct(n) {
  if (n == null || Number.isNaN(n)) return '     --';
  return `${n.toFixed(2).padStart(5)}%`;
}

console.log(
  `\n=== Case 6: Backpressure 정책 비교 (ARRIVAL_PEAK=${ARRIVAL_PEAK}/s, hold=${HOLD_SEC}s) ===`,
);
console.log(`source: ${inputPath}\n`);

console.log(
  '--- 요청 분배 (응답 status 기준 · aborted=reset 강제종료) ---',
);
console.log(
  `  ${'policy'.padEnd(14)}  ${'attempted'.padStart(9)}  ${'processed'.padStart(9)}  ${'dropped'.padStart(9)}  ${'rejected'.padStart(9)}  ${'aborted'.padStart(9)}  ${'errored'.padStart(9)}`,
);
for (const v of VARIANTS) {
  const reqs = num(`http_reqs{variant:${v}}`, 'count');
  const proc = num(`processed{variant:${v}}`, 'count') || 0;
  const drop = num(`dropped{variant:${v}}`, 'count') || 0;
  const rej = num(`rejected{variant:${v}}`, 'count') || 0;
  const abo = num(`aborted{variant:${v}}`, 'count') || 0;
  const err = num(`errored{variant:${v}}`, 'count') || 0;
  console.log(
    `  ${v.padEnd(14)}  ${fmtInt(reqs)}  ${fmtInt(proc)}  ${fmtInt(drop)}  ${fmtInt(rej)}  ${fmtInt(abo)}  ${fmtInt(err)}`,
  );
}

console.log('\n--- 비율 (effective = attempted − aborted) ---');
console.log(
  `  ${'policy'.padEnd(14)}  ${'proc%'.padStart(7)}  ${'drop%'.padStart(7)}  ${'rej%'.padStart(7)}`,
);
for (const v of VARIANTS) {
  const reqs = num(`http_reqs{variant:${v}}`, 'count');
  const proc = num(`processed{variant:${v}}`, 'count') || 0;
  const drop = num(`dropped{variant:${v}}`, 'count') || 0;
  const rej = num(`rejected{variant:${v}}`, 'count') || 0;
  const abo = num(`aborted{variant:${v}}`, 'count') || 0;
  const effective = reqs == null ? null : reqs - abo;
  const pPct = effective ? (proc / effective) * 100 : null;
  const dPct = effective ? (drop / effective) * 100 : null;
  const rPct = effective ? (rej / effective) * 100 : null;
  console.log(
    `  ${v.padEnd(14)}  ${fmtPct(pPct)}  ${fmtPct(dPct)}  ${fmtPct(rPct)}`,
  );
}

console.log('\n=== 클라이언트 응답시간 http_req_duration ===');
console.log(
  `  ${'policy'.padEnd(14)}  ${STATS.map((s) => s.padStart(11)).join('  ')}`,
);
for (const v of VARIANTS) {
  const vals = data.metrics[`http_req_duration{variant:${v}}`]?.values ?? {};
  const cells = STATS.map((s) => fmtMs(vals[s])).join('  ');
  console.log(`  ${v.padEnd(14)}  ${cells}`);
}

console.log('\n=== 서버 보고 waitMs (큐 대기시간) ===');
console.log(
  `  ${'policy'.padEnd(14)}  ${STATS.map((s) => s.padStart(11)).join('  ')}`,
);
for (const v of VARIANTS) {
  const vals = data.metrics[`server_wait_ms{variant:${v}}`]?.values ?? {};
  const cells = STATS.map((s) => fmtMs(vals[s])).join('  ');
  console.log(`  ${v.padEnd(14)}  ${cells}`);
}

console.log('\n=== queue_depth (2s 폴링 시계열) ===');
console.log(
  `  ${'policy'.padEnd(14)}  ${'avg'.padStart(9)}  ${'p(95)'.padStart(9)}  ${'max'.padStart(9)}`,
);
for (const v of VARIANTS) {
  const vals = data.metrics[`queue_depth{variant:${v}}`]?.values ?? {};
  console.log(
    `  ${v.padEnd(14)}  ${fmtInt(vals.avg)}  ${fmtInt(vals['p(95)'])}  ${fmtInt(vals.max)}`,
  );
}

console.log('\n=== RSS (2s 폴링 시계열, MB) ===');
console.log(
  `  ${'policy'.padEnd(14)}  ${'avg'.padStart(8)}  ${'p(95)'.padStart(8)}  ${'max'.padStart(8)}`,
);
for (const v of VARIANTS) {
  const vals = data.metrics[`rss_mb{variant:${v}}`]?.values ?? {};
  console.log(
    `  ${v.padEnd(14)}  ${fmtMb(vals.avg)}  ${fmtMb(vals['p(95)'])}  ${fmtMb(vals.max)}`,
  );
}

console.log('\n=== throughput (attempted/s, processed/s, peak 기준 = HOLD_SEC) ===');
console.log(
  `  ${'policy'.padEnd(14)}  ${'attempt/s'.padStart(10)}  ${'proc/s'.padStart(8)}  ${'fail%'.padStart(7)}`,
);
for (const v of VARIANTS) {
  const reqs = num(`http_reqs{variant:${v}}`, 'count');
  const proc = num(`processed{variant:${v}}`, 'count') || 0;
  const failRate = num(`http_req_failed{variant:${v}}`, 'rate');
  const attRps = reqs == null ? null : reqs / HOLD_SEC;
  const procRps = proc == null ? null : proc / HOLD_SEC;
  console.log(
    `  ${v.padEnd(14)}  ${attRps == null ? '        --' : attRps.toFixed(1).padStart(10)}  ${procRps == null ? '      --' : procRps.toFixed(1).padStart(8)}  ${fmtPct(failRate == null ? null : failRate * 100)}`,
  );
}

console.log('');
