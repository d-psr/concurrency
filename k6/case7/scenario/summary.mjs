import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const DEFAULT_INPUT = 'k6/case7/result/summary-latest.json';
const inputPath = process.argv[2] ?? DEFAULT_INPUT;
const INITIAL = Number(process.env.INITIAL || 1_000_000);
const PHASE_SEC = Number(process.env.PHASE_SEC || 30);

const raw = await readFile(resolve(inputPath), 'utf8');
const data = JSON.parse(raw);

const VARIANTS = ['inproc-mutex', 'redis-setnx', 'redlock', 'db-row-lock'];
const STATS = ['avg', 'med', 'p(95)', 'p(99)', 'max'];

function num(key, field = 'count') {
  return data.metrics[key]?.values?.[field] ?? null;
}

function fmtInt(n) {
  return n == null ? '       --' : String(Math.round(n)).padStart(9);
}
function fmtMs(n) {
  if (n == null || Number.isNaN(n)) return '         --';
  return `${n.toFixed(2).padStart(9)}ms`;
}
function fmtPct(n) {
  if (n == null || Number.isNaN(n)) return '     --';
  return `${n.toFixed(2).padStart(5)}%`;
}

console.log(
  `\n=== Case 7: 분산 락 비교 (INITIAL=${INITIAL}, PHASE=${PHASE_SEC}s) ===`,
);
console.log(`source: ${inputPath}\n`);

console.log('--- 정합성 (lost = applied - actual) ---');
console.log(
  `  ${'variant'.padEnd(14)}  ${'applied'.padStart(9)}  ${'actual'.padStart(9)}  ${'lost'.padStart(9)}  ${'lost%'.padStart(7)}`,
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
    `  ${v.padEnd(14)}  ${fmtInt(applied)}  ${fmtInt(actual)}  ${fmtInt(lost)}  ${fmtPct(lostPct)}`,
  );
}

console.log('\n--- http_req_duration (클라이언트 응답시간) ---');
console.log(
  `  ${'variant'.padEnd(14)}  ${STATS.map((s) => s.padStart(11)).join('  ')}`,
);
for (const v of VARIANTS) {
  const vals = data.metrics[`http_req_duration{variant:${v}}`]?.values ?? {};
  const cells = STATS.map((s) => fmtMs(vals[s])).join('  ');
  console.log(`  ${v.padEnd(14)}  ${cells}`);
}

console.log('\n--- lock_wait_ms (서버 보고 락 대기) ---');
console.log(
  `  ${'variant'.padEnd(14)}  ${STATS.map((s) => s.padStart(11)).join('  ')}`,
);
for (const v of VARIANTS) {
  const vals = data.metrics[`lock_wait_ms{variant:${v}}`]?.values ?? {};
  const cells = STATS.map((s) => fmtMs(vals[s])).join('  ');
  console.log(`  ${v.padEnd(14)}  ${cells}`);
}

console.log('\n--- throughput & 실패율 ---');
console.log(
  `  ${'variant'.padEnd(14)}  ${'reqs'.padStart(8)}  ${'rps'.padStart(8)}  ${'applied/s'.padStart(10)}  ${'fail%'.padStart(7)}`,
);
for (const v of VARIANTS) {
  const reqs = num(`http_reqs{variant:${v}}`, 'count');
  const applied = num(`applied_true{variant:${v}}`, 'count');
  const failRate = num(`http_req_failed{variant:${v}}`, 'rate');
  const rps = reqs == null ? null : reqs / PHASE_SEC;
  const applRps = applied == null ? null : applied / PHASE_SEC;
  console.log(
    `  ${v.padEnd(14)}  ${fmtInt(reqs)}  ${rps == null ? '       --' : rps.toFixed(1).padStart(8)}  ${applRps == null ? '        --' : applRps.toFixed(1).padStart(10)}  ${fmtPct(failRate == null ? null : failRate * 100)}`,
  );
}

console.log('\n--- 인스턴스 분배 (instance_hits) ---');
// thresholds에 등록 안 된 sub-metric은 summary JSON에 없으므로
// 모든 키를 스캔해서 variant·instance 조합을 뽑아낸다.
const instanceRows = {};
for (const key of Object.keys(data.metrics)) {
  const m = key.match(/^instance_hits\{(.+)\}$/);
  if (!m) continue;
  const tagPart = m[1];
  // tag 순서가 보장되지 않음 — variant·instance 둘 다 파싱
  const tags = Object.fromEntries(
    tagPart.split(',').map((kv) => {
      const i = kv.indexOf(':');
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
    }),
  );
  const v = tags.variant;
  const inst = tags.instance;
  if (!v || !inst) continue;
  const count = data.metrics[key]?.values?.count ?? 0;
  if (!instanceRows[v]) instanceRows[v] = {};
  instanceRows[v][inst] = (instanceRows[v][inst] || 0) + count;
}

if (Object.keys(instanceRows).length === 0) {
  console.log(
    '  (instance_hits sub-metric이 비어있음 — thresholds 또는 응답 instance 필드를 확인)',
  );
} else {
  for (const v of VARIANTS) {
    const row = instanceRows[v];
    if (!row) {
      console.log(`  ${v.padEnd(14)}  (no data)`);
      continue;
    }
    const total = Object.values(row).reduce((a, b) => a + b, 0);
    const parts = Object.entries(row)
      .sort()
      .map(([inst, c]) => `${inst}=${c} (${((c / total) * 100).toFixed(1)}%)`)
      .join('  ');
    console.log(`  ${v.padEnd(14)}  ${parts}`);
  }
}

console.log('');
