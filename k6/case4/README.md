# Case 4 — DB Connection Pool 경합

## 1. 목적

느린 DB 쿼리(예: `SELECT SLEEP(0.3)`)가 **Prisma connection pool**을 점유했을 때, 같은 풀을 쓰는 가벼운 쿼리가 얼마나 지연되는지 측정한다. 그리고 **`p-limit`으로 무거운 쿼리의 동시 실행을 제한**했을 때 그 경합이 얼마나 완화되는지를 한 번의 k6 실행으로 비교 검증한다.

> **HOL(Head-of-Line) blocking**: 단일 큐에서 맨 앞 작업이 막히면(=커넥션이 모두 점유되면) 뒤에 들어온 모든 작업이 자기 처리 시간과 무관하게 함께 대기하는 현상. 본 실험에서 probe 요청이 heavy 쿼리 뒤에서 수 초간 줄서는 것이 전형적인 사례다.

> **사전 지식**: Prisma의 MariaDB driver adapter(`PrismaMariaDb`)는 내부적으로 `mariadb` 풀을 사용하며, `connectionLimit`이 풀 크기를 결정한다. 모든 쿼리는 이 풀의 슬롯을 acquire → execute → release 순으로 사용하므로, 슬롯이 모두 점유되면 신규 쿼리는 슬롯이 빌 때까지 대기한다. `SELECT SLEEP(n)`은 서버 CPU·메모리 부담이 0이라 **순수하게 커넥션 슬롯만 점유**하므로 풀 HOL을 가장 깔끔하게 재현할 수 있다. (Case 4는 글로벌 `PrismaService`와 별도로 `connectionLimit=4`인 **전용 풀**을 띄워, case1~3의 풀과 격리되어 있다.)

### 가설


| #   | 가설                                                                                                              |
| --- | --------------------------------------------------------------------------------------------------------------- |
| H1  | heavy 20 VU가 connection pool(size=4)을 모두 점유하면, 동시에 들어온 probe 쿼리는 풀 acquire 큐에서 대기해야 하므로 latency가 크게 증가한다.    |
| H2  | heavy 호출을 `p-limit(N)`으로 게이팅하면 acquire 큐에 적체가 쌓이지 않아 probe 쿼리가 빠르게 처리된다.                                       |
| H3  | p-limit은 큐를 connection pool → JS 레이어로 옮기는 것이므로 heavy 자체의 전체 처리량(throughput)은 거의 동일하게 유지된다.                      |


---

## 2. 실험 환경

### 2.1 라우트


| Method | Path                          | 동작                                                          |
| ------ | ----------------------------- | ----------------------------------------------------------- |
| POST   | `/case4/heavy-without-limit`  | 전용 prisma로 `SELECT SLEEP(HEAVY_DURATION_SEC)` 직접 호출        |
| POST   | `/case4/heavy-with-limit`     | `pLimit(N)` 게이팅 후 동일 쿼리                                    |
| GET    | `/case4/probe`                | 전용 prisma로 `SELECT 1` (1ms급)                                |


### 2.2 핵심 상수


| 항목                    | 값        | 의미                                                                                          |
| --------------------- | -------- | ------------------------------------------------------------------------------------------- |
| `CASE4_POOL_SIZE`     | **4**    | `PrismaMariaDb(connectionLimit)` — case4 전용 풀 크기                                            |
| `HEAVY_DURATION_SEC`  | **0.3**  | `SELECT SLEEP(n)`의 n — 슬롯을 약 300ms 점유 (case1의 bcrypt cost=12 자리)                            |
| `HEAVY_CONCURRENCY`   | **3**    | `pLimit(3)` — JS 레이어에서 동시 heavy 3개로 제한. `limit < pool`로 커넥션 1개를 probe 전용 슬롯으로 확보            |


> **`SELECT SLEEP`을 쓰는 이유**: 풀 슬롯 점유 시간만 통제하고 DB 서버의 CPU·디스크·잠금 같은 다른 변수는 모두 0으로 만든다. 실험은 "풀이 가득 차면 무슨 일이 생기는가"만 측정하고, "DB가 느려서 생기는 일"은 격리한다.

### 2.3 컴포넌트 다이어그램

#### A. p-limit 없을 때 (Phase A)

```
HTTP /case4/heavy-without-limit ┐                     ┌─ heavy 쿼리가 큐를 가득 채움
                                ▼                     │
                       ┌──────────────────┐           │
                       │ Node.js JS layer │           │
                       └────────┬─────────┘           │
                                │                     │
                                ▼                     │
                       ┌─────────────────────────────┐│
                       │   Prisma acquire queue      │◄┘
                       │  [h][h][h][h][h][h][h]...   │
                       │  [h][h][h]...[p]...         │◄── probe 쿼리가 뒤에서 대기
                       └────────────┬────────────────┘
                                    ▼
                       ┌─────┬─────┬─────┬─────┐
                       │ C1  │ C2  │ C3  │ C4  │   connection pool (size=4)
                       │ h   │ h   │ h   │ h   │
                       └─────┴─────┴─────┴─────┘

                       HTTP /case4/probe ─┐
                                          └─► 큐 맨 뒤에 줄서기 → 수 초 대기
```

#### B. p-limit 적용했을 때 (Phase B, `limit=3 < pool=4`)

```
HTTP /case4/heavy-with-limit ┐
                             ▼
                   ┌──────────────────────┐
                   │  JS p-limit queue    │  ← heavy 적체는 여기서 멈춤
                   │  [h][h][h][h][h]...  │
                   └──────────┬───────────┘
                              │ (max 3 active)
                              ▼
                   ┌────────────────────────┐
                   │ Prisma acquire queue   │ ◄─ 거의 비어있음
                   │       (idle)           │
                   └──────────┬─────────────┘
                              ▼
                   ┌─────┬─────┬─────┬─────┐
                   │ C1  │ C2  │ C3  │ C4  │
                   │ h   │ h   │ h   │ ░░  │  ← C4는 probe 전용으로 항상 비어있음
                   └─────┴─────┴─────┴─────┘
                                        ▲
                                        │
                   HTTP /case4/probe ───┘  ► 대기 없이 즉시 C4로 진입
```

> **왜 `limit < pool` (3 < 4)이 probe를 sub-ms 가까이 떨어뜨리나?**
> JS p-limit이 heavy를 동시에 3개로 제한하므로 connection 4개 중 1개는 *구조적으로* heavy에 점유될 수 없다. 따라서 probe 쿼리는 거의 항상 빈 커넥션을 즉시 차지하고 acquire 큐를 거치지 않는다. 반대로 `limit == pool`로 두면 probe는 heavy 슬롯이 잠깐 비는 순간만 노릴 수 있어 효과가 제한적이다.

---

## 3. 테스트 방법

### 3.1 k6 시나리오 구성

단일 파일 `k6/case4/scenario/run.js` 한 번 실행으로 A/B를 모두 마친다. 두 페이즈를 cool-down으로 분리해 acquire 큐와 풀 잔열을 정리한다.

```
Time:     0s ─────────── 30s ──── 40s ─────────── 70s
          ◄────── Phase A ──────►   ◄────── Phase B ──────►
          [without-limit + probe]     [with-limit + probe]
                       Cool-down 10s
```


| Phase | 시작  | 길이  | heavy 라우트                       | probe 라우트     | 부하 프로파일                                            |
| ----- | --- | --- | -------------------------------- | -------------- | -------------------------------------------------- |
| A     | 0s  | 30s | `/case4/heavy-without-limit`     | `/case4/probe` | heavy: 20 VU constant / probe: 10 RPS arrival-rate |
| cool  | 30s | 10s | —                                | —              | (idle)                                             |
| B     | 40s | 30s | `/case4/heavy-with-limit`        | `/case4/probe` | heavy: 20 VU constant / probe: 10 RPS arrival-rate |


### 3.2 측정 태그

각 시나리오에 다음 태그를 부여해 동일 endpoint를 variant별로 분리 측정한다.


| variant         | endpoint | 의미                  |
| --------------- | -------- | ------------------- |
| `without-limit` | `heavy`  | Phase A의 heavy 라우트  |
| `without-limit` | `probe`  | Phase A의 probe       |
| `with-limit`    | `heavy`  | Phase B의 heavy 라우트  |
| `with-limit`    | `probe`  | Phase B의 probe       |


k6는 threshold가 선언된 태그 조합만 분리해 summary에 노출하므로, `scenario/run.js`에서 trivially-true threshold(`p(99)>=0`)로 submetric을 활성화한다.

### 3.3 실행

```bash
# 별도 터미널: api 띄우기 (case4 전용 풀은 코드에서 connectionLimit=4 고정)
npm run --workspace @concurrency/api start

# 프로젝트 루트에서: A/B 한 번에 실행
k6 run k6/case4/scenario/run.js

# 결과 비교 표 출력
node k6/case4/scenario/summary.mjs
```

---

## 4. 검증 결과

> **측정 환경**
>
> - OS: macOS (Darwin 24.1.0, Apple Silicon)
> - `CASE4_POOL_SIZE=4` (case4 전용 PrismaClient), `HEAVY_CONCURRENCY=3`, `HEAVY_DURATION_SEC=0.3`, phase=30s
> - k6 시나리오: heavy 20 VU constant + probe 10 RPS arrival-rate
> - DB: MariaDB (localhost), Prisma driver adapter (`PrismaMariaDb`)

### 4.1 probe 라우트 latency (`http_req_duration{endpoint:probe}`)


| stat  | without-limit | with-limit | Δ          |
| ----- | ------------- | ---------- | ---------- |
| avg   | **1930.44ms** | 62.11ms    | **−96.8%** |
| med   | 1919.27ms     | 57.43ms    | −97.0%     |
| p(90) | 2129.24ms     | 91.58ms    | −95.7%     |
| p(95) | 2202.27ms     | 103.43ms   | −95.3%     |
| p(99) | **2266.45ms** | **133.69ms** | **−94.1%** |
| max   | 2317.07ms     | 206.98ms   | −91.1%     |


#### 시각화 (p99 기준)

```
without-limit  │████████████████████████████████████████  2266ms
with-limit     │██▍                                        134ms
               └────────────────────────────────────────────────►
               0                                              2500ms
```

**해석**: probe 요청이 heavy 적체에 막혀 평균 **1.93초**, p99 **2.27초**까지 늘어졌다. `SELECT 1`은 보통 수 ms짜리인데 heavy 20 VU가 pool=4를 항상 점유 → 큐에서 ~16/4 × 0.3s ≈ 1.2s 대기 후 실행되는 산수와 일치한다. `limit=3 < pool=4` 적용 후 평균 **62ms / p99 134ms**로 떨어졌다 — 약 **30배** 개선. 커넥션 1개가 구조적으로 probe 전용이 되면서 probe는 acquire 큐를 거의 거치지 않는다. (case1의 30ms급보다 다소 높은 이유: probe가 로컬 read가 아닌 TCP + DB 왕복이라 베이스라인 자체가 수십 ms 수준이며, 본 측정에서 **거의 베이스라인까지 회복**한 것으로 해석된다.) → **H1, H2 강하게 검증**.

### 4.2 heavy 라우트 latency (`http_req_duration{endpoint:heavy}`)


| stat  | without-limit | with-limit | Δ          |
| ----- | ------------- | ---------- | ---------- |
| avg   | 2068.52ms     | 2340.65ms  | **+13.2%** |
| med   | 2104.85ms     | 2413.26ms  | +14.7%     |
| p(90) | 2263.36ms     | 2524.30ms  | +11.5%     |
| p(95) | 2288.67ms     | 2556.97ms  | +11.7%     |
| p(99) | 2351.22ms     | 2587.57ms  | +10.1%     |
| max   | 2365.62ms     | 2602.08ms  | +10.0%     |


#### 시각화 (avg 기준)

```
without-limit  │█████████████████████████████             2069ms
with-limit     │███████████████████████████████████       2341ms  (+13.2%)
               └────────────────────────────────────────────────►
               0                                              2700ms
```

**해석**: heavy의 모든 percentile이 일관되게 **+10~15% 악화**됐다. heavy 동시 처리 가능 슬롯이 4 → 3으로 줄어든 정직한 비용으로, 같은 20 VU가 좁아진 입구로 들어가니 JS 레이어 큐가 살짝 더 깊어진 결과. case1과 달리 tail의 분기(p95↑/p99↓ 같은 trade-off)는 보이지 않고 분포가 평행 이동하듯 들렸는데, 이는 SLEEP 쿼리가 bcrypt와 달리 처리 시간이 거의 결정적(deterministic)이라 워크로드 자체가 평탄하기 때문이다.

### 4.3 처리량 / 오류율 (variant 전체)


| variant       | reqs (count) | fail rate |
| ------------- | ------------ | --------- |
| without-limit | 582          | 0.00%     |
| with-limit    | 567          | 0.00%     |


```
without-limit  │█████████████████████████  582 reqs / 30s
with-limit     │████████████████████████   567 reqs / 30s  (-2.6%)
```

**해석**: 전체 reqs는 **−2.6%**로 미세 감소. 슬롯이 4→3으로 줄어든 만큼 heavy 자체 throughput은 살짝 손해를 봤지만, probe가 빠르게 응답하게 되면서 일부를 보상한다(without-limit phase에서는 probe가 2초씩 걸리며 `dropped_iterations=19` 발생, with-limit phase에서는 drop이 거의 없음). 

→ **H3 부분 검증**: heavy throughput은 `limit < pool`의 정직한 비용으로 약간 감소. 단, probe 응답성 회복이 이를 보상하므로 전체 시스템 관점에서는 여전히 우위.

---

## 5. 결론


| 가설                                            | 결과       | 비고                                                       |
| --------------------------------------------- | -------- | -------------------------------------------------------- |
| **H1**: heavy가 connection pool 점유 시 probe가 밀린다 | ✅ 검증     | probe p99 2.27초 (정상 baseline은 수 ms~수십 ms 수준)             |
| **H2**: p-limit으로 probe 경합이 완화된다              | ✅ 강하게 검증 | probe p99 2266ms → **134ms** (**−94.1%**, 약 30배)         |
| **H3**: heavy throughput은 거의 유지된다             | ⚠️ 부분 검증 | latency +10~15% 악화, throughput −2.6% (slot 4→3 비용)      |


### 5.1 핵심 인사이트

1. **DB connection pool은 libuv pool과 똑같이 공유 자원이다**. `SLEEP`이든 무거운 분석 쿼리든 슬롯을 오래 점유하는 작업은 같은 풀을 쓰는 모든 가벼운 쿼리(health check, lookup, 단일 row 조회 등)를 함께 굶긴다. case1과 본 case4는 *완전히 다른 레이어*(OS thread vs DB connection)에서 같은 HOL 메커니즘이 작동함을 보인다.
2. **p-limit은 큐의 위치를 옮긴다**. connection pool 큐가 깊어지면 head-of-line blocking이 모든 풀 의존 쿼리에 전파된다. JS 레벨에서 미리 게이팅하면 풀 큐를 짧게 유지할 수 있다. **단, 큐가 사라지는 게 아니라 JS 힙으로 옮겨갈 뿐**이므로 폭주 시 메모리 누수·응답시간 폭주가 가능하다. 운영에서는 (1) p-limit 큐 길이 상한, (2) 그 상한 초과 시 fast-fail(HTTP 429 등), (3) 업스트림 백프레셔 세 가지를 함께 갖춰야 한다.
3. **`connectionLimit` 자체를 올리는 것은 근본 해결이 아니다**. 늘리면 heavy 처리량은 같이 늘지만 "probe가 heavy 뒤에 줄선다"는 구조는 그대로다. 게다가 DB 측 `max_connections`·메모리 부담도 함께 늘어난다. p-limit이 작아야 probe 전용 슬롯이 보장된다.

### 5.2 운영 적용 시 고려사항

- `connectionLimit`보다 **작은** p-limit을 쓰면 가벼운 쿼리 전용 슬롯이 명시적으로 확보된다. 본 실험의 `pool=4 / limit=3` 구성은 probe latency를 베이스라인 수준까지 떨어뜨리는 대신 heavy avg를 ~13% 양보했다. **probe latency(예: 헬스체크, p99 알람)가 SLO 핵심이라면 이 trade-off는 충분히 가치 있다**.
- `p-limit`은 단일 프로세스 범위. 멀티 인스턴스라면 각자 풀이 따로이므로 인스턴스별로 설정. 글로벌 정합성이 필요하면 Redis-backed semaphore 같은 외부 게이팅이 필요.
- 보다 강한 분리가 필요하면 **무거운 쿼리 전용 별도 PrismaClient/풀**을 띄우는 게 한 단계 위 해법(이번 실험에서 case4 자체가 글로벌 풀과 분리된 전용 풀을 쓴 것과 같은 패턴).

---

## 6. 디렉토리 구조

```
k6/
├── lib/
│   └── build-summary.js              ← 공용 handleSummary 빌더
└── case4/
    ├── README.md                     ← (이 문서)
    ├── scenario/
    │   ├── run.js                    ← k6 시나리오 (A/B 단일 파일)
    │   └── summary.mjs               ← 결과 비교 표 출력기
    └── result/
        ├── summary-<timestamp>.json  ← 매 실행 결과
        └── summary-latest.json       ← summary.mjs 기본 입력
```

## 7. 튜닝

```bash
# 기본
k6 run k6/case4/scenario/run.js

# 부하/시간 튜닝
PHASE_SEC=60 HEAVY_VUS=30 PROBE_RATE=15 \
  k6 run k6/case4/scenario/run.js

# 과거 결과로 표만 재생성
node k6/case4/scenario/summary.mjs \
  k6/case4/result/summary-2026-05-23T20-30-00-000.json
```


| env             | default                 | 의미                |
| --------------- | ----------------------- | ----------------- |
| `BASE_URL`      | `http://localhost:3000` | api 주소            |
| `PHASE_SEC`     | `30`                    | 각 phase 길이(초)     |
| `COOL_DOWN_SEC` | `10`                    | phase 사이 idle 시간  |
| `HEAVY_VUS`     | `20`                    | heavy 라우트 동시 VU 수 |
| `PROBE_RATE`    | `10`                    | probe req/sec     |
