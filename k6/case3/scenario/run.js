import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { buildSummary } from '../../lib/build-summary.js';

const CASE_SLUG = 'case3';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const PHASE_SEC = Number(__ENV.PHASE_SEC || 30);
const COOL_DOWN_SEC = Number(__ENV.COOL_DOWN_SEC || 4);
const VUS = Number(__ENV.VUS || 50);
const INITIAL = Number(__ENV.INITIAL || 1_000_000);

const HEADERS = { 'Content-Type': 'application/json' };

const appliedTrue = new Counter('applied_true');
const finalBalance = new Counter('final_balance');
const optimisticAttempts = new Trend('optimistic_attempts');

const PHASE = `${PHASE_SEC}s`;
const DRAIN_SEC = Number(__ENV.DRAIN_SEC || 4);
const RESET_GAP_SEC = 1;
const SLOT_SEC = PHASE_SEC + DRAIN_SEC + RESET_GAP_SEC + COOL_DOWN_SEC;

const tStart = (i) => `${i * SLOT_SEC}s`;
const tReset = (i) => `${i * SLOT_SEC + PHASE_SEC + DRAIN_SEC}s`;

export const options = {
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],

  scenarios: {
    naive_load: {
      executor: 'constant-vus',
      vus: VUS,
      duration: PHASE,
      exec: 'loadNaive',
      tags: { variant: 'naive' },
      startTime: tStart(0),
    },
    naive_reset: {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: 1,
      exec: 'resetAfterNaive',
      tags: { variant: 'naive', op: 'reset' },
      startTime: tReset(0),
    },

    atomic_load: {
      executor: 'constant-vus',
      vus: VUS,
      duration: PHASE,
      exec: 'loadAtomic',
      tags: { variant: 'atomic' },
      startTime: tStart(1),
    },
    atomic_reset: {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: 1,
      exec: 'resetAfterAtomic',
      tags: { variant: 'atomic', op: 'reset' },
      startTime: tReset(1),
    },

    pessimistic_load: {
      executor: 'constant-vus',
      vus: VUS,
      duration: PHASE,
      exec: 'loadPessimistic',
      tags: { variant: 'pessimistic' },
      startTime: tStart(2),
    },
    pessimistic_reset: {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: 1,
      exec: 'resetAfterPessimistic',
      tags: { variant: 'pessimistic', op: 'reset' },
      startTime: tReset(2),
    },

    optimistic_load: {
      executor: 'constant-vus',
      vus: VUS,
      duration: PHASE,
      exec: 'loadOptimistic',
      tags: { variant: 'optimistic' },
      startTime: tStart(3),
    },
    optimistic_reset: {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: 1,
      exec: 'resetAfterOptimistic',
      tags: { variant: 'optimistic', op: 'reset' },
      startTime: tReset(3),
    },
  },

  thresholds: {
    'http_req_duration{variant:naive}': ['p(99)>=0'],
    'http_req_duration{variant:atomic}': ['p(99)>=0'],
    'http_req_duration{variant:pessimistic}': ['p(99)>=0'],
    'http_req_duration{variant:optimistic}': ['p(99)>=0'],

    'http_reqs{variant:naive}': ['count>=0'],
    'http_reqs{variant:atomic}': ['count>=0'],
    'http_reqs{variant:pessimistic}': ['count>=0'],
    'http_reqs{variant:optimistic}': ['count>=0'],

    'http_req_failed{variant:naive}': ['rate<0.05'],
    'http_req_failed{variant:atomic}': ['rate<0.05'],
    'http_req_failed{variant:pessimistic}': ['rate<0.05'],
    'http_req_failed{variant:optimistic}': ['rate<0.50'],

    'applied_true{variant:naive}': ['count>=0'],
    'applied_true{variant:atomic}': ['count>=0'],
    'applied_true{variant:pessimistic}': ['count>=0'],
    'applied_true{variant:optimistic}': ['count>=0'],

    'final_balance{variant:naive}': ['count>=0'],
    'final_balance{variant:atomic}': ['count>=0'],
    'final_balance{variant:pessimistic}': ['count>=0'],
    'final_balance{variant:optimistic}': ['count>=0'],

    optimistic_attempts: ['p(99)>=0'],
  },
};

export function setup() {
  const res = http.post(
    `${BASE_URL}/case3/reset`,
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
    if (variant === 'optimistic' && body && typeof body.attempts === 'number') {
      optimisticAttempts.add(body.attempts);
    }
  }
}

export function loadNaive() {
  postDecrement('/case3/decrement-naive', 'naive');
}
export function loadAtomic() {
  postDecrement('/case3/decrement-atomic', 'atomic');
}
export function loadPessimistic() {
  postDecrement('/case3/decrement-pessimistic', 'pessimistic');
}
export function loadOptimistic() {
  postDecrement('/case3/decrement-optimistic', 'optimistic');
}

function resetAndCapture(variant) {
  const res = http.post(
    `${BASE_URL}/case3/reset`,
    JSON.stringify({ initial: INITIAL }),
    { headers: HEADERS, tags: { variant, op: 'reset' } },
  );
  check(res, { [`reset ${variant} 201`]: (r) => r.status === 201 });

  if (res.status === 201) {
    const prev = res.json('data.previousBalance');
    if (typeof prev === 'number') {
      finalBalance.add(prev, { variant });
    }
  }
}

export function resetAfterNaive() {
  resetAndCapture('naive');
}
export function resetAfterAtomic() {
  resetAndCapture('atomic');
}
export function resetAfterPessimistic() {
  resetAndCapture('pessimistic');
}
export function resetAfterOptimistic() {
  resetAndCapture('optimistic');
}

export function handleSummary(data) {
  return buildSummary(data, { caseSlug: CASE_SLUG });
}
