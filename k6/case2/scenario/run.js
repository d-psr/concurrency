import http from 'k6/http';
import { check } from 'k6';
import { buildSummary } from '../../lib/build-summary.js';

const CASE_SLUG = 'case2';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const PHASE_SEC = Number(__ENV.PHASE_SEC || 30);
const COOL_DOWN_SEC = Number(__ENV.COOL_DOWN_SEC || 20);
const HASH_VUS = Number(__ENV.HASH_VUS || 20);
const PROBE_RATE = Number(__ENV.PROBE_RATE || 10);
const PASSWORD = __ENV.PASSWORD || 'Passw0rd!1';

const PHASE = `${PHASE_SEC}s`;
const PHASE_B_START = `${PHASE_SEC + COOL_DOWN_SEC}s`;
const PHASE_C_START = `${(PHASE_SEC + COOL_DOWN_SEC) * 2}s`;

export const options = {
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],

  scenarios: {
    hash_sync: {
      executor: 'constant-vus',
      vus: HASH_VUS,
      duration: PHASE,
      exec: 'hashSync',
      tags: { variant: 'sync', endpoint: 'hash' },
      startTime: '0s',
    },
    probe_sync: {
      executor: 'constant-arrival-rate',
      rate: PROBE_RATE,
      timeUnit: '1s',
      duration: PHASE,
      preAllocatedVUs: 5,
      maxVUs: 50,
      exec: 'probeHealth',
      tags: { variant: 'sync', endpoint: 'health' },
      startTime: '0s',
    },

    hash_async: {
      executor: 'constant-vus',
      vus: HASH_VUS,
      duration: PHASE,
      exec: 'hashAsync',
      tags: { variant: 'async', endpoint: 'hash' },
      startTime: PHASE_B_START,
    },
    probe_async: {
      executor: 'constant-arrival-rate',
      rate: PROBE_RATE,
      timeUnit: '1s',
      duration: PHASE,
      preAllocatedVUs: 5,
      maxVUs: 50,
      exec: 'probeHealth',
      tags: { variant: 'async', endpoint: 'health' },
      startTime: PHASE_B_START,
    },

    hash_worker: {
      executor: 'constant-vus',
      vus: HASH_VUS,
      duration: PHASE,
      exec: 'hashWorker',
      tags: { variant: 'worker', endpoint: 'hash' },
      startTime: PHASE_C_START,
    },
    probe_worker: {
      executor: 'constant-arrival-rate',
      rate: PROBE_RATE,
      timeUnit: '1s',
      duration: PHASE,
      preAllocatedVUs: 5,
      maxVUs: 50,
      exec: 'probeHealth',
      tags: { variant: 'worker', endpoint: 'health' },
      startTime: PHASE_C_START,
    },
  },

  thresholds: {
    'http_req_duration{endpoint:hash,variant:sync}': ['p(99)>=0'],
    'http_req_duration{endpoint:hash,variant:async}': ['p(99)>=0'],
    'http_req_duration{endpoint:hash,variant:worker}': ['p(99)>=0'],
    'http_req_duration{endpoint:health,variant:sync}': ['p(99)>=0'],
    'http_req_duration{endpoint:health,variant:async}': ['p(99)>=0'],
    'http_req_duration{endpoint:health,variant:worker}': ['p(99)>=0'],
    'http_reqs{variant:sync}': ['count>=0'],
    'http_reqs{variant:async}': ['count>=0'],
    'http_reqs{variant:worker}': ['count>=0'],
    'http_req_failed{variant:sync}': ['rate>=0'],
    'http_req_failed{variant:async}': ['rate>=0'],
    'http_req_failed{variant:worker}': ['rate>=0'],
  },
};

const HEADERS = { 'Content-Type': 'application/json' };

function postHash(route) {
  const body = JSON.stringify({ password: PASSWORD });
  const res = http.post(`${BASE_URL}${route}`, body, {
    headers: HEADERS,
    tags: { endpoint: 'hash' },
  });
  check(res, { 'hash 201': (r) => r.status === 201 });
}

export function hashSync() {
  postHash('/case2/sync-hash');
}

export function hashAsync() {
  postHash('/case2/async-hash');
}

export function hashWorker() {
  postHash('/case2/worker-hash');
}

export function probeHealth() {
  const res = http.get(`${BASE_URL}/case2/health`, {
    tags: { endpoint: 'health' },
  });
  check(res, { 'health 200': (r) => r.status === 200 });
}

export function handleSummary(data) {
  return buildSummary(data, { caseSlug: CASE_SLUG });
}
