import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { buildSummary } from '../../lib/build-summary.js';

const CASE_SLUG = 'case3b';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const PHASE_SEC = Number(__ENV.PHASE_SEC || 30);
const COOL_DOWN_SEC = Number(__ENV.COOL_DOWN_SEC || 4);
const VUS = Number(__ENV.VUS || 50);
const INITIAL = Number(__ENV.INITIAL || 1_000_000);

const HEADERS = { 'Content-Type': 'application/json' };

const appliedTrue = new Counter('applied_true');
const finalBalance = new Counter('final_balance');
const redisDbDrift = new Trend('redis_db_drift');

const PHASE = `${PHASE_SEC}s`;
const RESET_GAP_SEC = 1;

// variant별 DRAIN — max latency 기준으로 차등화 (in-flight 새어나감 방지)
//   queue:       max ~14s (50 VU × 워커 280ms) → 20s 여유
//   pessimistic: max ~5s (lock_wait_timeout)   → 6s 여유
//   redis:       max ~0.4s (Redis RTT 한계)    → 4s 충분
const DRAIN_BY_VARIANT = {
  pessimistic: Number(__ENV.DRAIN_PESSIMISTIC || 6),
  queue: Number(__ENV.DRAIN_QUEUE || 20),
  redis: Number(__ENV.DRAIN_REDIS || 4),
};
const slotFor = (v) =>
  PHASE_SEC + DRAIN_BY_VARIANT[v] + RESET_GAP_SEC + COOL_DOWN_SEC;

const ORDER = ['pessimistic', 'queue', 'redis'];
const startTimes = {};
const resetTimes = {};
let cursor = 0;
for (const v of ORDER) {
  startTimes[v] = cursor;
  resetTimes[v] = cursor + PHASE_SEC + DRAIN_BY_VARIANT[v];
  cursor += slotFor(v);
}

export const options = {
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],

  scenarios: {
    pessimistic_load: {
      executor: 'constant-vus',
      vus: VUS,
      duration: PHASE,
      exec: 'loadPessimistic',
      tags: { variant: 'pessimistic' },
      startTime: `${startTimes.pessimistic}s`,
    },
    pessimistic_reset: {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: 1,
      exec: 'resetAfterPessimistic',
      tags: { variant: 'pessimistic', op: 'reset' },
      startTime: `${resetTimes.pessimistic}s`,
    },

    queue_load: {
      executor: 'constant-vus',
      vus: VUS,
      duration: PHASE,
      exec: 'loadQueue',
      tags: { variant: 'queue' },
      startTime: `${startTimes.queue}s`,
    },
    queue_reset: {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: 1,
      exec: 'resetAfterQueue',
      tags: { variant: 'queue', op: 'reset' },
      startTime: `${resetTimes.queue}s`,
    },

    redis_load: {
      executor: 'constant-vus',
      vus: VUS,
      duration: PHASE,
      exec: 'loadRedis',
      tags: { variant: 'redis' },
      startTime: `${startTimes.redis}s`,
    },
    redis_reset: {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: 1,
      exec: 'resetAfterRedis',
      tags: { variant: 'redis', op: 'reset' },
      startTime: `${resetTimes.redis}s`,
    },
  },

  thresholds: {
    'http_req_duration{variant:pessimistic}': ['p(99)>=0'],
    'http_req_duration{variant:queue}': ['p(99)>=0'],
    'http_req_duration{variant:redis}': ['p(99)>=0'],

    'http_reqs{variant:pessimistic}': ['count>=0'],
    'http_reqs{variant:queue}': ['count>=0'],
    'http_reqs{variant:redis}': ['count>=0'],

    'http_req_failed{variant:pessimistic}': ['rate<0.95'],
    'http_req_failed{variant:queue}': ['rate<0.05'],
    'http_req_failed{variant:redis}': ['rate<0.05'],

    'applied_true{variant:pessimistic}': ['count>=0'],
    'applied_true{variant:queue}': ['count>=0'],
    'applied_true{variant:redis}': ['count>=0'],

    'final_balance{variant:pessimistic}': ['count>=0'],
    'final_balance{variant:queue}': ['count>=0'],
    'final_balance{variant:redis}': ['count>=0'],

    redis_db_drift: ['avg>=0'],
  },
};

export function setup() {
  const res = http.post(
    `${BASE_URL}/case3b/reset`,
    JSON.stringify({ initial: INITIAL }),
    { headers: HEADERS },
  );
  check(res, { 'setup reset 201': (r) => r.status === 201 });
  return { initial: INITIAL };
}

function postDecrement(route, variant) {
  const res = http.post(`${BASE_URL}${route}`, JSON.stringify({ amount: 1 }), {
    headers: HEADERS,
    tags: { variant },
  });
  check(res, { [`${variant} 201`]: (r) => r.status === 201 });

  if (res.status === 201) {
    const body = res.json('data');
    if (body && body.applied === true) {
      appliedTrue.add(1, { variant });
    }
  }
}

export function loadPessimistic() {
  postDecrement('/case3/decrement-pessimistic', 'pessimistic');
}
export function loadQueue() {
  postDecrement('/case3b/decrement-queue', 'queue');
}
export function loadRedis() {
  postDecrement('/case3b/decrement-redis', 'redis');
}

function resetAndCapture(variant) {
  const res = http.post(
    `${BASE_URL}/case3b/reset`,
    JSON.stringify({ initial: INITIAL }),
    { headers: HEADERS, tags: { variant, op: 'reset' } },
  );
  check(res, { [`reset ${variant} 201`]: (r) => r.status === 201 });

  if (res.status !== 201) return;

  const data = res.json('data');
  if (!data) return;

  const prevDb =
    typeof data.previousBalanceDb === 'number' ? data.previousBalanceDb : null;
  const prevRedis =
    typeof data.previousBalanceRedis === 'number'
      ? data.previousBalanceRedis
      : null;

  const truth = variant === 'redis' ? prevRedis : prevDb;
  if (typeof truth === 'number') {
    finalBalance.add(truth, { variant });
  }

  if (prevDb !== null && prevRedis !== null) {
    redisDbDrift.add(Math.abs(prevDb - prevRedis), { variant });
  }
}

export function resetAfterPessimistic() {
  resetAndCapture('pessimistic');
}
export function resetAfterQueue() {
  resetAndCapture('queue');
}
export function resetAfterRedis() {
  resetAndCapture('redis');
}

export function handleSummary(data) {
  return buildSummary(data, { caseSlug: CASE_SLUG });
}
