import http from 'k6/http';
import { check } from 'k6';
import exec from 'k6/execution';
import { Counter, Trend } from 'k6/metrics';
import { buildSummary } from '../../lib/build-summary.js';

const CASE_SLUG = 'case7';

// 멀티 인스턴스 round-robin: 콤마로 구분된 URL 리스트.
// 인스턴스 1대로 돌리면 inproc-mutex도 lost=0으로 보이기 때문에,
// 기본값은 의도적으로 두 포트.
const BASE_URLS = (
  __ENV.BASE_URLS || 'http://localhost:3000,http://localhost:3001'
)
  .split(',')
  .map((u) => u.trim())
  .filter(Boolean);

const PHASE_SEC = Number(__ENV.PHASE_SEC || 30);
const COOL_DOWN_SEC = Number(__ENV.COOL_DOWN_SEC || 4);
// DRAIN은 서버 LOCK_WAIT_TIMEOUT_MS(5s)보다 충분히 커야 적체분이
// 다음 phase의 reset 측정구간으로 새지 않는다 (cross-talk 방지).
const DRAIN_SEC = Number(__ENV.DRAIN_SEC || 12);
// VU 50은 락 매체 capacity를 압도해 fail%가 70%대로 치솟는다.
// 20이면 fail%가 정상 범위로 내려와 throughput 비교가 의미를 가진다.
// inproc-mutex의 lost update는 인스턴스 동시성에서 오므로 VU를 낮춰도 유지된다.
const VUS = Number(__ENV.VUS || 20);
const INITIAL = Number(__ENV.INITIAL || 1_000_000);

// 인스턴스 ID 분포 측정용 — k6는 thresholds에 등록된 sub-metric만 summary JSON에 export.
// 서버의 INSTANCE_ID와 일치시켜 두면 분포가 표에 찍힌다 (예: api-1,api-2).
const INSTANCES = (__ENV.INSTANCES || 'api-1,api-2')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const HEADERS = { 'Content-Type': 'application/json' };

const appliedTrue = new Counter('applied_true');
const finalBalance = new Counter('final_balance');
const instanceHits = new Counter('instance_hits');
const lockWaitMs = new Trend('lock_wait_ms', true);

const RESET_GAP_SEC = 1;
const SLOT_SEC = PHASE_SEC + DRAIN_SEC + RESET_GAP_SEC + COOL_DOWN_SEC;
const PHASE = `${PHASE_SEC}s`;

const tStart = (i) => `${i * SLOT_SEC}s`;
const tReset = (i) => `${i * SLOT_SEC + PHASE_SEC + DRAIN_SEC}s`;

const VARIANTS = ['inproc-mutex', 'redis-setnx', 'redlock', 'db-row-lock'];

// VU + iteration 기반 round-robin — VU 수 ≠ URL 수일 때도 균등 분배 보장
function pickBaseUrl() {
  if (BASE_URLS.length === 1) return BASE_URLS[0];
  const idx =
    (exec.vu.idInTest + exec.vu.iterationInScenario) % BASE_URLS.length;
  return BASE_URLS[idx];
}

export const options = {
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],

  scenarios: {
    inproc_load: {
      executor: 'constant-vus',
      vus: VUS,
      duration: PHASE,
      exec: 'loadInprocMutex',
      tags: { variant: 'inproc-mutex' },
      startTime: tStart(0),
    },
    inproc_reset: {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: 1,
      exec: 'resetAfterInprocMutex',
      tags: { variant: 'inproc-mutex', op: 'reset' },
      startTime: tReset(0),
    },

    setnx_load: {
      executor: 'constant-vus',
      vus: VUS,
      duration: PHASE,
      exec: 'loadRedisSetnx',
      tags: { variant: 'redis-setnx' },
      startTime: tStart(1),
    },
    setnx_reset: {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: 1,
      exec: 'resetAfterRedisSetnx',
      tags: { variant: 'redis-setnx', op: 'reset' },
      startTime: tReset(1),
    },

    redlock_load: {
      executor: 'constant-vus',
      vus: VUS,
      duration: PHASE,
      exec: 'loadRedlock',
      tags: { variant: 'redlock' },
      startTime: tStart(2),
    },
    redlock_reset: {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: 1,
      exec: 'resetAfterRedlock',
      tags: { variant: 'redlock', op: 'reset' },
      startTime: tReset(2),
    },

    dbrow_load: {
      executor: 'constant-vus',
      vus: VUS,
      duration: PHASE,
      exec: 'loadDbRowLock',
      tags: { variant: 'db-row-lock' },
      startTime: tStart(3),
    },
    dbrow_reset: {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: 1,
      exec: 'resetAfterDbRowLock',
      tags: { variant: 'db-row-lock', op: 'reset' },
      startTime: tReset(3),
    },
  },

  thresholds: buildThresholds(),
};

function buildThresholds() {
  const t = {};
  for (const v of VARIANTS) {
    t[`http_reqs{variant:${v}}`] = ['count>=0'];
    t[`http_req_duration{variant:${v}}`] = ['p(99)>=0'];
    // 락 경합이 5s LOCK_WAIT_TIMEOUT_MS를 초과하면 503으로 응답 — 정합성 결함이 아니라
    // 매체별 직렬화 비용의 발현이다. pass/fail이 아닌 측정값으로만 활용한다.
    t[`http_req_failed{variant:${v}}`] = ['rate<1.0'];
    t[`applied_true{variant:${v}}`] = ['count>=0'];
    t[`final_balance{variant:${v}}`] = ['count>=0'];
    t[`lock_wait_ms{variant:${v}}`] = ['avg>=0'];
    for (const inst of INSTANCES) {
      t[`instance_hits{variant:${v},instance:${inst}}`] = ['count>=0'];
    }
  }
  return t;
}

export function setup() {
  // 모든 인스턴스가 같은 row를 공유하므로 한 곳만 reset해도 충분
  const res = http.post(
    `${BASE_URLS[0]}/case7/reset`,
    JSON.stringify({ initial: INITIAL }),
    { headers: HEADERS },
  );
  check(res, { 'setup reset 2xx': (r) => r.status >= 200 && r.status < 300 });
  return { initial: INITIAL, urls: BASE_URLS };
}

function postDecrement(route, variant) {
  const url = `${pickBaseUrl()}${route}`;
  const res = http.post(url, JSON.stringify({ amount: 1 }), {
    headers: HEADERS,
    tags: { variant },
  });
  check(res, { [`${variant} 2xx`]: (r) => r.status >= 200 && r.status < 300 });

  if (res.status >= 200 && res.status < 300) {
    const body = res.json('data');
    if (body) {
      if (body.applied === true) {
        appliedTrue.add(1, { variant });
      }
      if (typeof body.lockWaitMs === 'number') {
        lockWaitMs.add(body.lockWaitMs, { variant });
      }
      if (typeof body.instance === 'string') {
        instanceHits.add(1, { variant, instance: body.instance });
      }
    }
  }
}

export function loadInprocMutex() {
  postDecrement('/case7/inproc-mutex/decrement', 'inproc-mutex');
}
export function loadRedisSetnx() {
  postDecrement('/case7/redis-setnx/decrement', 'redis-setnx');
}
export function loadRedlock() {
  postDecrement('/case7/redlock/decrement', 'redlock');
}
export function loadDbRowLock() {
  postDecrement('/case7/db-row-lock/decrement', 'db-row-lock');
}

function resetAndCapture(variant) {
  // reset도 인스턴스 한 곳에서 — 공유 row를 건드릴 뿐
  const res = http.post(
    `${BASE_URLS[0]}/case7/reset`,
    JSON.stringify({ initial: INITIAL }),
    { headers: HEADERS, tags: { variant, op: 'reset' } },
  );
  check(res, {
    [`reset ${variant} 2xx`]: (r) => r.status >= 200 && r.status < 300,
  });

  if (res.status >= 200 && res.status < 300) {
    const prev = res.json('data.previousBalance');
    if (typeof prev === 'number') {
      finalBalance.add(prev, { variant });
    }
  }
}

export function resetAfterInprocMutex() {
  resetAndCapture('inproc-mutex');
}
export function resetAfterRedisSetnx() {
  resetAndCapture('redis-setnx');
}
export function resetAfterRedlock() {
  resetAndCapture('redlock');
}
export function resetAfterDbRowLock() {
  resetAndCapture('db-row-lock');
}

export function handleSummary(data) {
  return buildSummary(data, { caseSlug: CASE_SLUG });
}
