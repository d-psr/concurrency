import http from 'k6/http';
import { check } from 'k6';
import { buildSummary } from '../../lib/build-summary.js';

const CASE_SLUG = 'case4';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const PHASE_SEC = Number(__ENV.PHASE_SEC || 30);
const COOL_DOWN_SEC = Number(__ENV.COOL_DOWN_SEC || 10);
const HEAVY_VUS = Number(__ENV.HEAVY_VUS || 20);
const PROBE_RATE = Number(__ENV.PROBE_RATE || 10);

const PHASE = `${PHASE_SEC}s`;
const PHASE_B_START = `${PHASE_SEC + COOL_DOWN_SEC}s`;

export const options = {
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],

  scenarios: {
    heavy_without_limit: {
      executor: 'constant-vus',
      vus: HEAVY_VUS,
      duration: PHASE,
      exec: 'heavyWithoutLimit',
      tags: { variant: 'without-limit', endpoint: 'heavy' },
      startTime: '0s',
    },
    probe_without_limit: {
      executor: 'constant-arrival-rate',
      rate: PROBE_RATE,
      timeUnit: '1s',
      duration: PHASE,
      preAllocatedVUs: 5,
      maxVUs: 50,
      exec: 'probeDb',
      tags: { variant: 'without-limit', endpoint: 'probe' },
      startTime: '0s',
    },

    heavy_with_limit: {
      executor: 'constant-vus',
      vus: HEAVY_VUS,
      duration: PHASE,
      exec: 'heavyWithLimit',
      tags: { variant: 'with-limit', endpoint: 'heavy' },
      startTime: PHASE_B_START,
    },
    probe_with_limit: {
      executor: 'constant-arrival-rate',
      rate: PROBE_RATE,
      timeUnit: '1s',
      duration: PHASE,
      preAllocatedVUs: 5,
      maxVUs: 50,
      exec: 'probeDb',
      tags: { variant: 'with-limit', endpoint: 'probe' },
      startTime: PHASE_B_START,
    },
  },

  thresholds: {
    'http_req_duration{endpoint:probe,variant:without-limit}': ['p(99)>=0'],
    'http_req_duration{endpoint:probe,variant:with-limit}': ['p(99)>=0'],
    'http_req_duration{endpoint:heavy,variant:without-limit}': ['p(99)>=0'],
    'http_req_duration{endpoint:heavy,variant:with-limit}': ['p(99)>=0'],
    'http_reqs{variant:without-limit}': ['count>=0'],
    'http_reqs{variant:with-limit}': ['count>=0'],
    'http_req_failed{variant:without-limit}': ['rate<0.05'],
    'http_req_failed{variant:with-limit}': ['rate<0.05'],
  },
};

function postHeavy(route) {
  const res = http.post(`${BASE_URL}${route}`, null, {
    tags: { endpoint: 'heavy' },
  });
  check(res, { 'heavy 201': (r) => r.status === 201 });
}

export function heavyWithoutLimit() {
  postHeavy('/case4/heavy-without-limit');
}

export function heavyWithLimit() {
  postHeavy('/case4/heavy-with-limit');
}

export function probeDb() {
  const res = http.get(`${BASE_URL}/case4/probe`, {
    tags: { endpoint: 'probe' },
  });
  check(res, { 'probe 200': (r) => r.status === 200 });
}

export function handleSummary(data) {
  return buildSummary(data, {
    caseSlug: CASE_SLUG,
  });
}
