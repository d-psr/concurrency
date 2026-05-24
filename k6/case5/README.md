# Case 5 — Cache Stampede (Thundering Herd)

## 1. 목적

단일 핫 키가 TTL 만료되는 순간 N개의 동시 요청이 캐시 미스 → 동시에 backend(DB)를 때려 connection pool이 포화되는 현상을 재현하고, **4가지 완화 전략의 backend QPS ↔ 응답 latency ↔ 정합성(stale 허용도) trade-off**를 한 번의 k6 실행으로 비교한다.

> **Cache Stampede / Thundering Herd**: 캐시는 평소 backend 부하를 압축해주지만, **단일 키의 만료 순간**이 단일 장애점이다. TTL 직후 모든 reader가 동시에 캐시 미스를 일으키고, 그 N개 요청이 그대로 backend로 흘러간다. 100 VU가 동시 미스를 일으키면 backend는 평소 1 RPS짜리 키 때문에 순간 100 RPS를 받는다. 이 부하가 DB connection pool을 포화시키면 case4의 HOL blocking이 재발해 *같은 풀을 쓰는 다른 트래픽*까지 동반 마비된다.

> **사전 지식 — 4가지 완화 전략**
> 1. **naive**: 캐시 미스 시 즉시 DB 조회. 동시 미스 = 동시 DB 호출 → 가장 단순하지만 stampede에 무방비.
> 2. **singleflight (in-process)**: 같은 키로 진행 중인 요청 Promise를 `Map`에 등록해, 후속 미스를 그 Promise에 합류시킴. 같은 프로세스 안의 모든 미스를 DB 호출 1번으로 수렴. 단 *멀티 인스턴스에서는 인스턴스 수만큼 미스*.
> 3. **redis-lock (distributed)**: `SET key NX PX <TTL>`으로 원자 락 획득. 락 따낸 리더 1명만 DB 호출, 나머지는 짧게 cache poll. 클러스터 전체에서 DB 호출 1회로 수렴하나 락 대기 + Redis 1홉 latency 추가.
> 4. **xfetch (probabilistic early refresh)**: 캐시 값과 함께 backend 호출에 걸린 시간(`delta`)을 저장해두고, 매 읽기마다 `now − δ·β·ln(rand()) ≥ expiresAt` 확률로 사전 갱신을 트리거. 다수 reader는 항상 cache에서 즉시 반환되며, 일부 운 좋은 reader만 백그라운드 refresh를 수행. backend QPS 평탄화, latency 최저, 단 stale 응답 허용 필요.

### 가설

| #   | 가설                                                                                                                |
| --- | ----------------------------------------------------------------------------------------------------------------- |
| H1  | **naive**는 TTL 경계마다 backend QPS 스파이크 → DB 풀(=4) 포화 → product latency p99 폭증 + probe(SELECT 1)까지 동반 지연 |
| H2  | **singleflight**는 같은 프로세스 안 N 동시 미스를 DB 호출 1회로 수렴 → backend QPS 거의 0에 수렴, product latency 평탄                       |
| H3  | **redis-lock**은 클러스터 전체에서 DB 호출 1회 수렴 + 분산 락 대기로 p50 약간 증가 (single instance 환경에서는 singleflight와 거의 동급)          |
| H4  | **xfetch**는 backend QPS를 시간축으로 평탄화 → product latency 최저 (대부분 cache hit), 단 만료 직후 일부 stale 응답 발생                  |

---

## 2. 실험 환경

### 2.1 라우트

| Method | Path                                | 동작                                                              |
| ------ | ----------------------------------- | --------------------------------------------------------------- |
| GET    | `/case5/product-naive/:id`          | TTL Map 캐시. 미스 시 직접 DB 호출                                       |
| GET    | `/case5/product-singleflight/:id`   | TTL Map 캐시 + in-flight Promise Map으로 동시 미스 합류                   |
| GET    | `/case5/product-redis-lock/:id`     | Redis 캐시 + `SET NX PX` 분산 락 + 20ms poll                         |
| GET    | `/case5/product-xfetch/:id`         | Redis 캐시(`{value, delta, expiresAt}`) + 확률적 사전 갱신               |
| GET    | `/case5/probe`                      | case5 전용 풀로 `SELECT 1` — pool 포화 노출용                            |
| POST   | `/case5/reset`                      | Product row upsert + 인-프로세스 Map + Redis 키 모두 무효화                |

### 2.2 핵심 상수

| 항목                          | 값       | 의미                                                                                       |
| --------------------------- | ------- | ---------------------------------------------------------------------------------------- |
| `CASE5_POOL_SIZE`           | **4**   | case5 전용 PrismaClient의 connectionLimit. case4와 같은 풀 사이즈로 포화 가시화                          |
| `CASE5_TTL_SEC`             | **5**   | 캐시 TTL. 100 VU가 5초마다 cache stampede 경계를 자연스럽게 만남                                        |
| `CASE5_DB_DELAY_MS`         | **200** | backend 호출 비용 (`SELECT SLEEP(0.2)`) — 풀 슬롯을 200ms 점유                                     |
| `CASE5_REDIS_LOCK_TTL_MS`   | **500** | redis-lock / xfetch 락의 TTL. 락 보유자가 죽어도 자동 해제                                            |
| `CASE5_REDIS_POLL_MS`       | **20**  | 락 못 잡은 follower의 cache poll 주기                                                           |
| `CASE5_XFETCH_BETA`         | **1.0** | xfetch 사전 갱신 aggressiveness. 클수록 만료 전부터 일찍 갱신                                            |

### 2.3 알고리즘 다이어그램

#### A. naive — 무방비

```
TTL 만료 순간
  100 VU ─┐
          ├─► cache.get() → miss (100명 모두)
          ├─► fetchFromBackend() × 100
          ▼
  ┌─────────────────────────────────────┐
  │   Prisma acquire queue              │
  │   [m][m][m][m][m]...[m] (96명 대기) │ ◄── 96/4 × 200ms ≈ 4.8s 대기
  └─────────┬───────────────────────────┘
            ▼
  ┌─────┬─────┬─────┬─────┐
  │ C1  │ C2  │ C3  │ C4  │   pool size = 4
  │ m   │ m   │ m   │ m   │   probe도 같은 풀에서 굶주림
  └─────┴─────┴─────┴─────┘
```

#### B. singleflight — in-process 합류

```
TTL 만료 순간
  100 VU ─┐
          ├─► cache.get() → miss (100명 모두)
          ├─► inFlight.get() → 첫 1명만 undefined
          │
  첫번째─►  fetchFromBackend() 1회만 호출
          │ inFlight.set(id, promise)
          ▼
  나머지 99명 ─► inFlight.get() → promise! → await
                (DB 호출 0회)
```

#### C. redis-lock — 분산 합류

```
TTL 만료 순간
  100 VU ─┐ (단일 인스턴스라 가정해도 패턴 동일)
          ├─► GET cache:1 → null (100명 모두)
          ├─► SET lock:1 NX PX 500
          │   → 1명만 'OK', 99명은 null
          │
  리더 1명─► fetchFromBackend() → SET cache:1 EX 5 → DEL lock:1
          │
  follower 99명 ─► sleep(20ms) → GET cache:1 (loop)
                  → 200ms 후 cache 채워짐 → 모두 반환
```

#### D. xfetch — 확률적 사전 갱신

```
캐시 안 (값+delta+expiresAt 저장)
  매 read ─► xfetchTime = now − δ · β · ln(rand())
          │
          ├─ xfetchTime < expiresAt  → cache 반환 (대다수 케이스)
          │
          └─ xfetchTime ≥ expiresAt  → SET lock NX PX 500 시도
              │
              ├─ 'OK': background에서 refreshXfetch() 발사 (await 안 함)
              │       해당 reader도 cache 즉시 반환
              │
              └─ null: 다른 reader가 이미 갱신 중. cache 반환
```

> **xfetch의 핵심**: cache hit/miss 경계가 없다. 만료가 가까워질수록 *확률적으로* refresh가 일어나 backend QPS가 시간축으로 평탄화된다. 대다수 reader는 절대 backend를 기다리지 않는다.

---

## 3. 테스트 방법

### 3.1 시나리오 구성

단일 파일 `k6/case5/scenario/run.js` 한 번 실행으로 4 variant를 순차 측정한다. 각 phase 시작 직전에 reset(캐시/락 무효화 + product row 초기화)을 1회 호출해 동일 출발선에서 비교.

```
Time:   0s     30s    40s     70s     80s   110s   120s   150s
        ◄ Phase 1 ►  cool  ◄ Phase 2 ►  cool ◄ Ph 3 ►  cool ◄ Ph 4 ►
        [ naive  ]        [singleflight]      [redis-lock]   [xfetch]
        + reset           + reset              + reset       + reset
```

각 phase 1초 전에 reset scenario(iterations=1)가 실행된 뒤 stampede + probe가 동시에 시작됨.

| Phase | variant         | 부하 (stampede)                                  | probe                          |
| ----- | --------------- | ---------------------------------------------- | ------------------------------ |
| 1     | `naive`         | `GET /case5/product-naive/1` × 100 VU 30s     | `GET /case5/probe` 10 RPS 30s  |
| 2     | `singleflight`  | `GET /case5/product-singleflight/1` × 100 VU  | 동일                           |
| 3     | `redis-lock`    | `GET /case5/product-redis-lock/1` × 100 VU    | 동일                           |
| 4     | `xfetch`        | `GET /case5/product-xfetch/1` × 100 VU        | 동일                           |

### 3.2 측정 태그 / 커스텀 메트릭

각 시나리오에 `variant`, `endpoint` 태그를 부여해 동일 endpoint를 variant별로 분리 측정. 추가로 응답 body의 `source` 필드(`cache | db | stale`)를 카운팅하는 커스텀 메트릭으로 **variant별 실제 backend 호출 비율**을 측정한다.

| 메트릭                                                  | 의미                                  |
| ----------------------------------------------------- | ----------------------------------- |
| `http_req_duration{endpoint:product,variant:X}`       | variant별 product API latency        |
| `http_req_duration{endpoint:probe,variant:X}`         | variant별 풀 포화 노출 (probe latency)    |
| `http_reqs{variant:X}`                                | variant별 총 요청 수                     |
| `case5_source{variant:X,source:cache\|db\|stale}`     | **응답이 어디서 왔는지** — DB 호출 비율의 직접 측정 |

### 3.3 실행

```bash
# 별도 터미널: api 띄우기 (Redis + MariaDB 미리 띄워둘 것)
npm run --workspace @concurrency/api start

# 프로젝트 루트에서: 4 variant 한 번에 실행
k6 run k6/case5/scenario/run.js

# 결과 비교 표 출력
node k6/case5/scenario/summary.mjs
```

> **TTL = 5s, 100 VU의 의미**: 모든 VU가 거의 동시에 시작해 첫 미스 후 5초간 캐시 히트 → TTL 경계에 100명이 일제히 다음 iteration 진입 → 자연스러운 stampede burst가 30초 안에 ~6회 발생. 별도 burst 타이밍 코드 없이 TTL 주기로 재현된다.

---

## 4. 검증 결과

> **측정 환경**
>
> - OS: macOS (Darwin 24.1.0, Apple Silicon)
> - `CASE5_POOL_SIZE=4`, `CASE5_TTL_SEC=5`, `CASE5_DB_DELAY_MS=200`, phase=30s, STAMPEDE_VUS=100, PROBE_RATE=10
> - DB: MariaDB (localhost), Redis: localhost:6379
> - k6 시나리오: product 100 VU constant + probe 10 RPS arrival-rate, variant 4종 순차

### 4.1 source distribution (DB 호출 비율)

> **이 표가 case5의 가장 중요한 결과**: variant별로 실제 backend가 몇 번 불렸는지 직접 측정. PHASE_SEC=30, TTL=5s → 시나리오 1개당 약 6 TTL 경계 stampede.

| variant         | cache   | db      | stale | total   | db%        |
| --------------- | ------- | ------- | ----- | ------- | ---------- |
| `naive`         | 75,232  | **300** | 0     | 75,532  | **0.40%**  |
| `singleflight`  | 140,593 | **6**   | 0     | 140,599 | **0.0043%**|
| `redis-lock`    | 118,750 | **6**   | 0     | 118,756 | **0.0051%**|
| `xfetch`        | 122,504 | **1**   | 0     | 122,505 | **0.0008%**|

**해석**
- **naive 300회 / 6 burst = burst당 ~50 DB 호출**. 100 VU 중 절반은 다른 VU가 캐시 채워주기 전에 도착해 미스 → 동시 50개가 풀 슬롯 4개로 직렬화되며 stampede 발생. 풀 포화로 probe까지 굶주림(§4.3).
- **singleflight / redis-lock: 정확히 6회 = burst당 1회**. 합류 메커니즘이 완벽하게 동작. 100 VU 동시 미스가 단일 DB 호출로 수렴.
- **xfetch: 단 1회 (= cold start)**. 백그라운드 refresh가 사용자 응답 경로 *밖에서* 일어나기 때문에 reader는 절대 DB를 기다리지 않음. → backend 실제 호출 수는 다른 distributed 변형과 비슷하지만, *reader에게는 보이지 않는다*는 점이 핵심.

### 4.2 product 라우트 latency

| stat  | naive       | singleflight | redis-lock | xfetch  |
| ----- | ----------- | ------------ | ---------- | ------- |
| avg   | 47.6ms      | 21.3ms       | 25.2ms     | 24.4ms  |
| med   | 16.9ms      | 18.0ms       | 22.3ms     | 22.5ms  |
| p(95) | 28.5ms      | 31.6ms       | 33.3ms     | 33.5ms  |
| p(99) | 43.8ms      | 45.0ms       | 45.8ms     | 45.7ms  |
| max   | **9,430ms** | 489ms        | 393ms      | 426ms   |

**해석**
- **p50~p99는 4 variant 모두 비슷한 범위 (17~46ms)**. 캐시 히트율이 모두 99%+ 라서 percentile은 캐시 히트 latency에 거의 지배됨.
- **max에서 naive만 9.4초**. 이게 stampede 직격탄을 맞은 VU. 풀 슬롯 대기 ~9초 + DB 200ms. 다른 variant는 한 명만 DB 가니까 max도 500ms 이하로 떨어짐.
- singleflight가 redis-lock·xfetch보다 살짝 빠른 이유는 cache 매체가 in-process Map이라 Redis 1홉이 없어서. 캐시 히트 한 번이 ~1ms vs ~5ms 차이.

### 4.3 probe 라우트 latency (pool 포화 노출 — H1의 핵심 증거)

| stat  | naive       | singleflight | redis-lock | xfetch  |
| ----- | ----------- | ------------ | ---------- | ------- |
| avg   | **2,372ms** | 144ms        | 102ms      | 108ms   |
| med   | 1,725ms     | 143ms        | 101ms      | 102ms   |
| p(95) | 6,229ms     | 202ms        | 131ms      | 147ms   |
| p(99) | **6,483ms** | 254ms        | 196ms      | 207ms   |
| max   | 6,593ms     | 285ms        | 272ms      | 361ms   |

**해석** — 이게 cache stampede의 *진짜 비용*:
- naive variant 부하 중 `SELECT 1`(probe) 한 줄짜리가 평균 **2.4초, p99 6.5초**. case5 전용 풀(=4)이 stampede DB 호출에 점유돼서 같은 풀을 쓰는 *완전 무관한 트래픽*까지 함께 굶주림. case4의 HOL blocking이 캐시 레이어에서 재발.
- 나머지 3 variant: probe latency 100~250ms 선에서 안정. 캐시 합류로 풀이 거의 비어있음.
- redis-lock의 probe가 가장 빠른(102ms) 이유는 stampede 시 DB 호출 1회만 발생 + reader 99명은 Redis만 polling → 풀이 가장 한가함.

### 4.4 처리량

| variant         | reqs    | req/s     | fail%   |
| --------------- | ------- | --------- | ------- |
| `naive`         | 75,786  | 2,526     | 0.00%   |
| `singleflight`  | 140,901 | **4,697** | 0.00%   |
| `redis-lock`    | 119,057 | 3,969     | 0.00%   |
| `xfetch`        | 122,806 | 4,094     | 0.00%   |

**해석**
- **naive 처리량이 1.5~1.9배 낮음** (2,526 vs 3,969~4,697). 100 VU가 stampede 동안 풀에 대기하느라 무한 루프를 돌리지 못함.
- **singleflight가 최고 처리량** (4,697 req/s). 캐시 매체가 in-process Map이라 Redis 1홉이 없음 + 합류 효과까지 합쳐짐.
- redis-lock·xfetch는 합류 효과는 있지만 Redis 1홉 비용 때문에 singleflight보다 ~700 req/s 낮음 — 단일 인스턴스에서는 정직한 trade-off.

---

## 5. 결론

| 가설                                                                  | 결과            | 비고                                                                                                  |
| ------------------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------- |
| **H1**: naive는 stampede로 DB 풀 포화 + probe 동반 지연                       | ✅ 강하게 검증     | probe p99 **6.5s** vs 정상 100~250ms. 캐시 레이어에서 case4의 HOL blocking 재발                                  |
| **H2**: singleflight는 in-process 합류로 DB 호출 N → 1                     | ✅ 검증          | 30s/100VU에서 DB 호출 **6회 = 6 TTL 경계 × 1**. 정확히 burst당 1회로 수렴                                          |
| **H3**: redis-lock은 분산 합류 + 락 대기 latency 추가                          | ⚠️ 부분 검증     | DB 호출은 6회로 동일. 락 대기 latency는 ~4ms (singleflight p50 18ms vs redis-lock 22ms). 단일 인스턴스라 차이 작음 |
| **H4**: xfetch는 backend QPS 평탄화 + latency 최저 (stale 허용 비용)          | ✅ 검증, ⚠️ 변형 | reader가 본 DB 호출은 **단 1회** (cold start만). 백그라운드 refresh는 사용자 경로 밖에서 일어남. stale 응답 0건                |

### 5.1 핵심 인사이트

1. **캐시는 단일 캐시가 아니다 — 만료 정책 + coalescing이 본체**. naive는 cache hit rate **99.6%** ("거의 모든 요청이 캐시 히트")인데도, 0.4% 미스가 stampede burst로 뭉쳐 풀(=4)을 점유하면서 *다른 무관한 트래픽까지* p99를 6초로 끌어내림. **캐시 적중률이 높다는 게 안전을 보장하지 않는다** — 미스가 *언제 모이는지*가 더 중요.
2. **coalescing 매체가 작동 범위를 결정한다**. singleflight는 인프라 0개로 단일 프로세스 안에서 완벽하게 동작 (4,697 req/s, DB 호출 burst당 1회). 단 *멀티 인스턴스로 확장하면 인스턴스 수만큼 미스* — 이 한계는 case7에서 보자. redis-lock은 Redis 1홉(~4ms p50 비용)을 지불하고 클러스터 전체 합류를 산다.
3. **xfetch는 reader-perceived latency를 새 차원으로 떨어뜨린다**. 백그라운드 refresh를 사용자 응답 경로 *밖으로* 빼내, reader는 30s 동안 단 1번만 DB 호출을 경험. 실제 backend 호출 수는 다른 distributed 변형과 비슷하지만, **누가 그 비용을 지불하느냐**가 다르다 (reader → background worker). 만료 직후 stale 응답 비용을 *허용할 수 있는 도메인*에서 가장 강력 (상품 상세, 인기 글 리스트 등).
4. **p50/p99 percentile은 stampede를 거의 안 보여준다**. product p99 4개 variant 모두 44~46ms. 캐시 히트율이 워낙 높아 분포가 캐시 히트에 지배됨. naive의 진짜 문제는 **max 9.4초**와 **probe p99 6.5초**에서 노출됨. → "p99만 보는 모니터링은 cache stampede를 놓친다". max와 *공유 자원(DB pool)을 쓰는 다른 라우트* latency를 같이 봐야 함.

### 5.2 운영 적용 시 고려사항

- **TTL이 짧을수록 stampede 빈도가 ↑, TTL이 길수록 stale 허용도가 ↑**. 둘 다 backend QPS를 줄이는 방향이지만 정합성 비용이 다르다. coalescing은 이 trade-off를 *완화*해주는 것이지 *대체*하는 게 아니다.
- **단일 인스턴스 데모에서는 singleflight ≈ redis-lock**. 두 전략의 차이는 *인스턴스가 2개 이상*일 때부터 벌어진다 (case7에서 분산 락 vs 인프로세스 락 차이를 더 깊게 다룸).
- **xfetch의 β 튜닝**: β=1.0이 paper default. backend가 매우 비싸면 β를 키워 일찍 갱신, 매우 싸면 줄여 만료 직전에만 갱신. β=0이면 사실상 naive와 동급.
- **lock holder의 fault tolerance**: redis-lock/xfetch 모두 락 TTL(500ms)을 backend timeout보다 길게 잡지 말 것. backend가 락 TTL을 초과하면 두 명이 동시에 critical section에 진입 가능 (이번 구현은 `deadline = lockTTL + 200ms` 후 fallback fetch로 처리).

---

## 6. 디렉토리 구조

```
k6/
├── lib/
│   └── build-summary.js              ← 공용 handleSummary 빌더
└── case5/
    ├── README.md                     ← (이 문서)
    ├── scenario/
    │   ├── run.js                    ← k6 시나리오 (4 variant 단일 파일)
    │   └── summary.mjs               ← 결과 비교 표 출력기
    └── result/
        ├── summary-<timestamp>.json  ← 매 실행 결과
        └── summary-latest.json       ← summary.mjs 기본 입력
```

## 7. 튜닝

```bash
# 기본
k6 run k6/case5/scenario/run.js

# 부하/시간 튜닝
PHASE_SEC=60 STAMPEDE_VUS=200 PROBE_RATE=20 \
  k6 run k6/case5/scenario/run.js

# 과거 결과로 표만 재생성
node k6/case5/scenario/summary.mjs \
  k6/case5/result/summary-2026-05-24T10-30-00-000.json
```

| env             | default                 | 의미                              |
| --------------- | ----------------------- | ------------------------------- |
| `BASE_URL`      | `http://localhost:3000` | api 주소                          |
| `PHASE_SEC`     | `30`                    | variant 1개당 부하 길이(초)           |
| `COOL_DOWN_SEC` | `10`                    | variant 사이 idle 시간              |
| `RESET_GAP_SEC` | `1`                     | reset과 부하 시작 사이 간격             |
| `STAMPEDE_VUS`  | `100`                   | hot key를 때리는 동시 VU 수           |
| `PROBE_RATE`    | `10`                    | probe req/sec                   |
| `PRODUCT_ID`    | `1`                     | reset이 seed하는 product row id    |
