import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import { buildSummary } from '../../lib/build-summary.js';

const CASE_SLUG = 'case5';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const PHASE_SEC = Number(__ENV.PHASE_SEC || 30);
const COOL_DOWN_SEC = Number(__ENV.COOL_DOWN_SEC || 10);
const RESET_GAP_SEC = Number(__ENV.RESET_GAP_SEC || 1);
const STAMPEDE_VUS = Number(__ENV.STAMPEDE_VUS || 100);
const PROBE_RATE = Number(__ENV.PROBE_RATE || 10);
const PRODUCT_ID = Number(__ENV.PRODUCT_ID || 1);

const VARIANTS = ['naive', 'singleflight', 'redis-lock', 'xfetch'];
const SOURCES = ['cache', 'db', 'stale'];

const sourceCounter = new Counter('case5_source');

const PHASE = `${PHASE_SEC}s`;
const phaseBlockSec = RESET_GAP_SEC + PHASE_SEC + COOL_DOWN_SEC;

function variantStart(i) {
  return i * phaseBlockSec;
}

function buildScenarios() {
  const scenarios = {};
  VARIANTS.forEach((variant, i) => {
    const baseStart = variantStart(i);
    const loadStart = `${baseStart + RESET_GAP_SEC}s`;

    scenarios[`reset_${variant}`] = {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: 1,
      maxDuration: `${RESET_GAP_SEC}s`,
      exec: 'resetCase5',
      tags: { variant, endpoint: 'reset' },
      startTime: `${baseStart}s`,
    };

    scenarios[`stampede_${variant}`] = {
      executor: 'constant-vus',
      vus: STAMPEDE_VUS,
      duration: PHASE,
      exec: `getProduct_${variant.replace('-', '_')}`,
      tags: { variant, endpoint: 'product' },
      startTime: loadStart,
    };

    scenarios[`probe_${variant}`] = {
      executor: 'constant-arrival-rate',
      rate: PROBE_RATE,
      timeUnit: '1s',
      duration: PHASE,
      preAllocatedVUs: 5,
      maxVUs: 50,
      exec: 'probePool',
      tags: { variant, endpoint: 'probe' },
      startTime: loadStart,
    };
  });
  return scenarios;
}

function buildThresholds() {
  const t = {};
  for (const variant of VARIANTS) {
    t[`http_req_duration{endpoint:product,variant:${variant}}`] = ['p(99)>=0'];
    t[`http_req_duration{endpoint:probe,variant:${variant}}`] = ['p(99)>=0'];
    t[`http_reqs{variant:${variant}}`] = ['count>=0'];
    t[`http_req_failed{variant:${variant}}`] = ['rate<0.05'];
    for (const source of SOURCES) {
      t[`case5_source{source:${source},variant:${variant}}`] = ['count>=0'];
    }
  }
  return t;
}

export const options = {
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  scenarios: buildScenarios(),
  thresholds: buildThresholds(),
};

function fetchProduct(variant, route) {
  const res = http.get(`${BASE_URL}${route}/${PRODUCT_ID}`, {
    tags: { endpoint: 'product', variant },
  });
  const ok = check(res, { 'product 200': (r) => r.status === 200 });
  if (ok) {
    let source = 'unknown';
    try {
      source = res.json('data.source') || 'unknown';
    } catch (_e) {
      source = 'parse-error';
    }
    sourceCounter.add(1, { variant, source });
  }
}

export function getProduct_naive() {
  fetchProduct('naive', '/case5/product-naive');
}

export function getProduct_singleflight() {
  fetchProduct('singleflight', '/case5/product-singleflight');
}

export function getProduct_redis_lock() {
  fetchProduct('redis-lock', '/case5/product-redis-lock');
}

export function getProduct_xfetch() {
  fetchProduct('xfetch', '/case5/product-xfetch');
}

export function probePool() {
  const res = http.get(`${BASE_URL}/case5/probe`, {
    tags: { endpoint: 'probe' },
  });
  check(res, { 'probe 200': (r) => r.status === 200 });
}

export function resetCase5() {
  const res = http.post(`${BASE_URL}/case5/reset`, null, {
    tags: { endpoint: 'reset' },
  });
  check(res, { 'reset 2xx': (r) => r.status >= 200 && r.status < 300 });
}

export function handleSummary(data) {
  return buildSummary(data, {
    caseSlug: CASE_SLUG,
  });
}
