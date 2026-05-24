import http from 'k6/http';
import { check, sleep } from 'k6';
import exec from 'k6/execution';
import { Counter, Trend } from 'k6/metrics';
import { buildSummary } from '../../lib/build-summary.js';

const CASE_SLUG = 'case6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const HEADERS = { 'Content-Type': 'application/json' };

const RAMP_UP_SEC = Number(__ENV.RAMP_UP_SEC || 20);
const HOLD_SEC = Number(__ENV.HOLD_SEC || 30);
const RAMP_DOWN_SEC = Number(__ENV.RAMP_DOWN_SEC || 5);
const ARRIVAL_PEAK = Number(__ENV.ARRIVAL_PEAK || 50); // req/s, consumer 10/s 대비 5x
const PRE_VUS = Number(__ENV.PRE_VUS || 2500);
const MAX_VUS = Number(__ENV.MAX_VUS || 3000);
const COOL_DOWN_SEC = Number(__ENV.COOL_DOWN_SEC || 5);
const RESET_GAP_SEC = 1;
const STATS_INTERVAL_SEC = Number(__ENV.STATS_INTERVAL_SEC || 2);
// k6 기본 http timeout 60s — unbounded는 큐 깊이가 충분히 자라면 60s 초과
// 부하 종료 후 reset이 펜딩을 dropped로 해소하므로 5분이면 충분
const HTTP_TIMEOUT = __ENV.HTTP_TIMEOUT || '5m';

// prefetch-tune은 RMQ purge를 안 하니까 마지막 phase로 배치
const ORDER = ['unbounded', 'drop-oldest', 'reject-429', 'prefetch-tune'];
const PHASE_TOTAL_SEC = RAMP_UP_SEC + HOLD_SEC + RAMP_DOWN_SEC;
const SLOT_SEC = PHASE_TOTAL_SEC + RESET_GAP_SEC + COOL_DOWN_SEC;

const startTimes = {};
const resetTimes = {};
{
  let cursor = 0;
  for (const v of ORDER) {
    startTimes[v] = cursor;
    resetTimes[v] = cursor + PHASE_TOTAL_SEC;
    cursor += SLOT_SEC;
  }
}
const TOTAL_DURATION_SEC = ORDER.length * SLOT_SEC + 5;

const processed = new Counter('processed');
const dropped = new Counter('dropped');
const rejected = new Counter('rejected');
const aborted = new Counter('aborted');
const errored = new Counter('errored');
const serverWaitMs = new Trend('server_wait_ms', true);
const queueDepth = new Trend('queue_depth');
const rssMb = new Trend('rss_mb');

function rampStages() {
  return [
    { target: ARRIVAL_PEAK, duration: `${RAMP_UP_SEC}s` },
    { target: ARRIVAL_PEAK, duration: `${HOLD_SEC}s` },
    { target: 0, duration: `${RAMP_DOWN_SEC}s` },
  ];
}

function loadScenario(variant, execName) {
  return {
    executor: 'ramping-arrival-rate',
    startRate: 1,
    timeUnit: '1s',
    preAllocatedVUs: PRE_VUS,
    maxVUs: MAX_VUS,
    stages: rampStages(),
    exec: execName,
    tags: { variant },
    startTime: `${startTimes[variant]}s`,
    gracefulStop: '60s', // unbounded 적체분이 reset 후 풀려나갈 여유
  };
}

function resetScenario(variant, execName) {
  return {
    executor: 'per-vu-iterations',
    vus: 1,
    iterations: 1,
    exec: execName,
    tags: { variant, op: 'reset' },
    startTime: `${resetTimes[variant]}s`,
  };
}

export const options = {
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],

  scenarios: {
    unbounded_load: loadScenario('unbounded', 'loadUnbounded'),
    unbounded_reset: resetScenario('unbounded', 'resetAfterUnbounded'),

    drop_oldest_load: loadScenario('drop-oldest', 'loadDropOldest'),
    drop_oldest_reset: resetScenario('drop-oldest', 'resetAfterDropOldest'),

    reject_429_load: loadScenario('reject-429', 'loadReject429'),
    reject_429_reset: resetScenario('reject-429', 'resetAfterReject429'),

    prefetch_tune_load: loadScenario('prefetch-tune', 'loadPrefetchTune'),
    prefetch_tune_reset: resetScenario('prefetch-tune', 'resetAfterPrefetchTune'),

    stats_sampler: {
      executor: 'constant-vus',
      vus: 1,
      duration: `${TOTAL_DURATION_SEC}s`,
      exec: 'sampleStats',
      tags: { op: 'stats' },
    },
  },

  // k6는 thresholds에 등록된 sub-metric만 summary JSON에 별도 키로 export 한다.
  // 표시 목적의 임계만 두고, 통과/실패 판정은 따로 안 한다.
  thresholds: buildThresholds(),
};

function buildThresholds() {
  const t = {};
  for (const v of ORDER) {
    t[`http_reqs{variant:${v}}`] = ['count>=0'];
    t[`http_req_duration{variant:${v}}`] = ['p(99)>=0'];
    t[`http_req_failed{variant:${v}}`] = ['rate<1.0'];
    t[`processed{variant:${v}}`] = ['count>=0'];
    t[`dropped{variant:${v}}`] = ['count>=0'];
    t[`rejected{variant:${v}}`] = ['count>=0'];
    t[`aborted{variant:${v}}`] = ['count>=0'];
    t[`errored{variant:${v}}`] = ['count>=0'];
    t[`server_wait_ms{variant:${v}}`] = ['avg>=0'];
    t[`queue_depth{variant:${v}}`] = ['avg>=0'];
    t[`rss_mb{variant:${v}}`] = ['avg>=0'];
  }
  return t;
}

export function setup() {
  const res = http.post(`${BASE_URL}/case6/reset`, null, { headers: HEADERS });
  check(res, { 'setup reset 2xx': (r) => r.status >= 200 && r.status < 300 });
  return { testStartMs: Date.now() };
}

function postEnqueue(policy) {
  const res = http.post(`${BASE_URL}/case6/enqueue?policy=${policy}`, null, {
    headers: HEADERS,
    tags: { variant: policy },
    timeout: HTTP_TIMEOUT,
  });

  if (res.status === 429) {
    rejected.add(1, { variant: policy });
    return;
  }
  if (res.status === 201 || res.status === 200) {
    const body = res.json('data');
    if (body && body.status === 'processed') {
      processed.add(1, { variant: policy });
      if (typeof body.waitMs === 'number') {
        serverWaitMs.add(body.waitMs, { variant: policy });
      }
    } else if (body && body.status === 'dropped') {
      dropped.add(1, { variant: policy });
    } else if (body && body.status === 'aborted') {
      // reset에 의한 강제 종료 — 정책 측정에서 제외
      aborted.add(1, { variant: policy });
    } else {
      errored.add(1, { variant: policy });
    }
    return;
  }
  errored.add(1, { variant: policy });
}

export function loadUnbounded() {
  postEnqueue('unbounded');
}
export function loadDropOldest() {
  postEnqueue('drop-oldest');
}
export function loadReject429() {
  postEnqueue('reject-429');
}
export function loadPrefetchTune() {
  postEnqueue('prefetch-tune');
}

function resetCase6(variant) {
  const res = http.post(`${BASE_URL}/case6/reset`, null, {
    headers: HEADERS,
    tags: { variant, op: 'reset' },
  });
  check(res, {
    [`reset ${variant} 2xx`]: (r) => r.status >= 200 && r.status < 300,
  });
}

export function resetAfterUnbounded() {
  resetCase6('unbounded');
}
export function resetAfterDropOldest() {
  resetCase6('drop-oldest');
}
export function resetAfterReject429() {
  resetCase6('reject-429');
}
export function resetAfterPrefetchTune() {
  resetCase6('prefetch-tune');
}

function activeVariantAt(elapsedSec) {
  for (const v of ORDER) {
    if (elapsedSec >= startTimes[v] && elapsedSec < resetTimes[v]) return v;
  }
  return null;
}

export function sampleStats(setupData) {
  const elapsed = (Date.now() - setupData.testStartMs) / 1000;
  const active = activeVariantAt(elapsed);

  const res = http.get(`${BASE_URL}/case6/stats`, {
    tags: { op: 'stats' },
  });
  if (res.status === 200) {
    const body = res.json('data');
    if (body) {
      if (active && body.byPolicy && body.byPolicy[active]) {
        const p = body.byPolicy[active];
        if (typeof p.queueDepth === 'number') {
          queueDepth.add(p.queueDepth, { variant: active });
        }
      }
      if (typeof body.rss === 'number') {
        rssMb.add(body.rss / (1024 * 1024), {
          variant: active || 'idle',
        });
      }
    }
  }
  sleep(STATS_INTERVAL_SEC);
}

export function handleSummary(data) {
  return buildSummary(data, { caseSlug: CASE_SLUG });
}
