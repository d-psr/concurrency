import http from 'k6/http';
import { check } from 'k6';
import { buildSummary } from '../../lib/build-summary.js';

const CASE_SLUG = 'case1';
// const SCENARIO_NAME = 'case1';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const PHASE_SEC = Number(__ENV.PHASE_SEC || 30);
const COOL_DOWN_SEC = Number(__ENV.COOL_DOWN_SEC || 10);
const HASH_VUS = Number(__ENV.HASH_VUS || 20);
const PROBE_RATE = Number(__ENV.PROBE_RATE || 10);
const PASSWORD = __ENV.PASSWORD || 'Passw0rd!1';

const PHASE = `${PHASE_SEC}s`;
const PHASE_B_START = `${PHASE_SEC + COOL_DOWN_SEC}s`;

export const options = {
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],

  scenarios: {
    bcrypt_without_limit: {
      executor: 'constant-vus',
      vus: HASH_VUS,
      duration: PHASE,
      exec: 'bcryptWithoutLimit',
      tags: { variant: 'without-limit', endpoint: 'bcrypt' },
      startTime: '0s',
    },
    probe_without_limit: {
      executor: 'constant-arrival-rate',
      rate: PROBE_RATE,
      timeUnit: '1s',
      duration: PHASE,
      preAllocatedVUs: 5,
      maxVUs: 50,
      exec: 'probeIo',
      tags: { variant: 'without-limit', endpoint: 'io' },
      startTime: '0s',
    },

    bcrypt_with_limit: {
      executor: 'constant-vus',
      vus: HASH_VUS,
      duration: PHASE,
      exec: 'bcryptWithLimit',
      tags: { variant: 'with-limit', endpoint: 'bcrypt' },
      startTime: PHASE_B_START,
    },
    probe_with_limit: {
      executor: 'constant-arrival-rate',
      rate: PROBE_RATE,
      timeUnit: '1s',
      duration: PHASE,
      preAllocatedVUs: 5,
      maxVUs: 50,
      exec: 'probeIo',
      tags: { variant: 'with-limit', endpoint: 'io' },
      startTime: PHASE_B_START,
    },
  },

  thresholds: {
    'http_req_duration{endpoint:io,variant:without-limit}': ['p(99)>=0'],
    'http_req_duration{endpoint:io,variant:with-limit}': ['p(99)>=0'],
    'http_req_duration{endpoint:bcrypt,variant:without-limit}': ['p(99)>=0'],
    'http_req_duration{endpoint:bcrypt,variant:with-limit}': ['p(99)>=0'],
    'http_reqs{variant:without-limit}': ['count>=0'],
    'http_reqs{variant:with-limit}': ['count>=0'],
    'http_req_failed{variant:without-limit}': ['rate<0.05'],
    'http_req_failed{variant:with-limit}': ['rate<0.05'],
  },
};

const HEADERS = { 'Content-Type': 'application/json' };

function postBcrypt(route) {
  const body = JSON.stringify({ password: PASSWORD });
  const res = http.post(`${BASE_URL}${route}`, body, {
    headers: HEADERS,
    tags: { endpoint: 'bcrypt' },
  });
  check(res, { 'bcrypt 201': (r) => r.status === 201 });
}

export function bcryptWithoutLimit() {
  postBcrypt('/case1/without-limit');
}

export function bcryptWithLimit() {
  postBcrypt('/case1/with-limit');
}

export function probeIo() {
  const res = http.get(`${BASE_URL}/case1/io`, { tags: { endpoint: 'io' } });
  check(res, { 'io 200': (r) => r.status === 200 });
}

export function handleSummary(data) {
  return buildSummary(data, {
    caseSlug: CASE_SLUG,
    // scenarioName: SCENARIO_NAME,
  });
}
