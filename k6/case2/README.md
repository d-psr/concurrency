# Case 2 — Event Loop / Main Thread Blocking

## 1. 목적

CPU 작업을 **어디서 처리하느냐**에 따라 Node.js 서버 응답성이 어떻게 갈리는지 한 번의 k6 실행으로 비교 검증한다. 같은 `bcrypt` 라이브러리를 사용하되 실행 위치만 바꿔 세 가지 풀(메인 스레드 / libuv 풀 / worker_threads 풀)의 격리 수준을 측정한다.

> **사전 지식**
>
> - **메인 스레드**: V8이 JS 코드를 실행하는 곳. Node.js 이벤트 루프가 도는 단일 스레드. 여기서 동기 CPU 작업을 하면 다른 모든 HTTP 요청·timer·I/O 콜백이 같이 얼어붙는다.
> - **libuv 스레드 풀**: Node 코어 C 라이브러리(libuv)가 관리하는 OS 스레드 풀(기본 4개). `fs.`*, `crypto`, `bcrypt.hash` 같은 네이티브 비동기 API가 자동으로 위임한다. JS 코드는 실행 못함.
> - **worker_threads 풀**: 각 워커가 자기 V8 + 자기 이벤트 루프 + 자기 libuv를 가진 "미니 Node 인스턴스"의 풀. 명시적으로 `pool.run()` 호출 시에만 동작하며 임의의 JS 코드를 실행할 수 있다. 본 실험에서는 [piscina](https://github.com/piscinajs/piscina)로 관리.
>
> `**Sync` 접미사 규약**: `bcrypt.hashSync`처럼 이름 끝에 `Sync`가 붙은 함수는 libuv를 거치지 않고 **호출한 스레드가 직접** CPU 작업을 끝까지 수행한다. 즉 메인에서 부르면 메인이, 워커에서 부르면 워커가 멈춘다.

### 가설


| #   | 가설                                                                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| H1  | `sync-hash` 부하는 **메인 스레드를 점유**하므로 동시에 들어온 `/case2/health`(빈 응답) latency가 수 초~timeout으로 폭증한다.                                             |
| H2  | `async-hash`는 libuv 풀로 위임되므로 메인 스레드는 자유 → `/case2/health`는 정상 수준을 유지한다. 단 libuv 풀(4개)이 포화되어도 health 라우트는 libuv를 안 쓰므로 영향 없음.             |
| H3  | `worker-hash`는 Piscina 워커 풀이 CPU를 흡수하므로 메인·libuv 모두 깨끗 → `/case2/health` 가장 안정. 단 worker 4개 한도로 hash 자체 throughput은 libuv 변형보다 약간 손해 가능. |


---

## 2. 실험 환경

### 2.1 라우트


| Method | Path                 | 동작                                             | CPU 작업 위치         |
| ------ | -------------------- | ---------------------------------------------- | ----------------- |
| POST   | `/case2/sync-hash`   | `bcrypt.hashSync(pw, 12)`                      | **메인 스레드**        |
| POST   | `/case2/async-hash`  | `bcrypt.hash(pw, 12)` → libuv 풀                | **libuv 풀 (4)**   |
| POST   | `/case2/worker-hash` | Piscina `pool.run(pw)` → 워커가 `bcrypt.hashSync` | **Piscina 풀 (4)** |
| GET    | `/case2/health`      | `{ ok: true, at: Date.now() }` 즉시 반환           | 메인 스레드 (거의 무부하)   |


### 2.2 핵심 상수


| 항목                   | 값      | 의미                                               |
| -------------------- | ------ | ------------------------------------------------ |
| `UV_THREADPOOL_SIZE` | **4**  | libuv worker 개수 (Node.js 기본값, 통제변수)              |
| `BCRYPT_COST`        | **12** | bcrypt 라운드 — 1회 ≈ 150~300ms (case1과 동일)          |
| `WORKER_POOL_SIZE`   | **4**  | Piscina `maxThreads` — libuv와 같은 4로 맞춰 비교 정합성 확보 |


> **why bcrypt?** case1과 같은 작업을 써서 "같은 부하를 어디로 보내느냐"의 차이만 분리해 측정할 수 있다. cost=12는 case1과 동일 (OWASP 2023 권장 최소값, worker 200~300ms 점유).

### 2.3 컴포넌트 다이어그램

#### A. sync (Phase A)

```
HTTP /case2/sync-hash  ┐
                       ▼
       ┌────────────────────────────────┐
       │  Main thread (event loop)      │ ◄── hashSync가 직접 CPU 갈아넣음
       │  [ hashSync ████████████████ ] │      → 이벤트 루프 정지
       └───────────────┬────────────────┘
                       ▲
HTTP /case2/health ────┘ ◄── 메인 큐에 줄섬 → 응답 못 받음 (수 초 ~ timeout)
```

#### B. async (Phase B)

```
HTTP /case2/async-hash  ┐
                        ▼
       ┌────────────────────────────────┐
       │  Main thread (event loop)      │ ◄── bcrypt.hash 호출만 하고 즉시 반환
       │  [ free ──────────────────── ] │      → 이벤트 루프 자유
       └────────────────┬───────────────┘
                        │ uv_queue_work
                        ▼
       ┌─────┬─────┬─────┬─────┐
       │ W1  │ W2  │ W3  │ W4  │  libuv pool (size=4)
       │ b   │ b   │ b   │ b   │  ◄── 풀 포화 → hash 자체는 큐잉
       └─────┴─────┴─────┴─────┘

HTTP /case2/health ──► 메인 스레드 자유 → 즉시 응답 ✓
                       (health는 libuv 안 씀)
```

#### C. worker (Phase C)

```
HTTP /case2/worker-hash  ┐
                         ▼
       ┌────────────────────────────────┐
       │  Main thread (event loop)      │ ◄── pool.run() 호출만 (postMessage)
       │  [ free ──────────────────── ] │      → 이벤트 루프 자유
       └────────────────┬───────────────┘
                        │ postMessage
                        ▼
       ┌─────┬─────┬─────┬─────┐
       │ Wk1 │ Wk2 │ Wk3 │ Wk4 │  Piscina pool (maxThreads=4)
       │ H!  │ H!  │ H!  │ H!  │  ◄── 각 워커가 자기 V8에서 hashSync
       └─────┴─────┴─────┴─────┘   메인/libuv와 완전 격리

  HTTP /case2/health ──► 메인 자유 + libuv 깨끗 → 가장 안정 ✓
```

> **핵심 차이**: B와 C 모두 메인 스레드를 보호하지만, B는 **libuv 풀**(Node가 내장)을 쓰고 C는 **별도 worker 풀**(내가 만든 영토)을 쓴다. 본 실험에서는 양쪽 모두 풀 크기를 4로 맞췄으므로 hash throughput은 비슷하게 나올 것으로 예상되며, 의미 있는 차이는 **풀 외부 시스템에 미치는 부작용**에서 갈린다. (e.g. async 부하 시 다른 libuv 사용자 — `fs.readFile` 등 — 가 같이 영향받지만, worker 부하 시 libuv는 깨끗하다. 본 시나리오에서는 health가 libuv를 안 쓰므로 이 차이가 직접 드러나진 않지만, case1 결과가 그 효과를 이미 입증.)

---

## 3. 테스트 방법

### 3.1 k6 시나리오 구성

단일 파일 `k6/case2/scenario/run.js` 한 번 실행으로 A/B/C를 모두 마친다. 페이즈 사이 cool-down을 충분히(20s) 둬서 sync 페이즈의 적체가 다음 페이즈에 영향 주지 않도록 함.

```
Time:    0s ─────── 30s ────── 50s ─────── 80s ────── 100s ─────── 130s
         ◄ Phase A ►  cool 20s  ◄ Phase B ►  cool 20s  ◄ Phase C ►
         [sync-hash]            [async-hash]           [worker-hash]
              + /health probe (각 페이즈 병행)
```


| Phase | 시작   | 길이  | hash 라우트             | probe 라우트       | 부하 프로파일                                           |
| ----- | ---- | --- | -------------------- | --------------- | ------------------------------------------------- |
| A     | 0s   | 30s | `/case2/sync-hash`   | `/case2/health` | hash: 20 VU constant / probe: 10 RPS arrival-rate |
| cool  | 30s  | 20s | —                    | —               | (idle)                                            |
| B     | 50s  | 30s | `/case2/async-hash`  | `/case2/health` | 동일                                                |
| cool  | 80s  | 20s | —                    | —               | (idle)                                            |
| C     | 100s | 30s | `/case2/worker-hash` | `/case2/health` | 동일                                                |


### 3.2 측정 태그


| variant  | endpoint | 의미                                |
| -------- | -------- | --------------------------------- |
| `sync`   | `hash`   | Phase A의 hash 라우트 (`sync-hash`)   |
| `sync`   | `health` | Phase A의 health probe             |
| `async`  | `hash`   | Phase B의 hash 라우트 (`async-hash`)  |
| `async`  | `health` | Phase B의 health probe             |
| `worker` | `hash`   | Phase C의 hash 라우트 (`worker-hash`) |
| `worker` | `health` | Phase C의 health probe             |


k6는 threshold가 선언된 태그 조합만 분리해 summary에 노출하므로, `scenario/run.js`에서 trivially-true threshold(`p(99)>=0`)로 submetric을 활성화한다.

> **Phase A의 timeout 정책**: 기본 k6 60s timeout을 그대로 둔다. sync 페이즈에서 health probe가 얼마나 멀리 밀리는지(=메인 스레드 정지의 가시화)가 핵심 데이터이므로 강제로 짧게 끊지 않는다. 단, fail rate가 0%가 아니더라도 threshold는 `rate>=0`로 두어 실험이 중단되지 않게 한다.

### 3.3 실행

```bash
# 별도 터미널: api 띄우기 (UV_THREADPOOL_SIZE를 통제변수로 명시 고정)
UV_THREADPOOL_SIZE=4 npm run --workspace @concurrency/api start

# 프로젝트 루트에서: A/B/C 한 번에 실행
k6 run k6/case2/scenario/run.js

# 결과 비교 표 출력
node k6/case2/scenario/summary.mjs
```

---

## 4. 검증 결과

> **측정 환경**
>
> - OS: macOS (Darwin 24.1.0, Apple Silicon)
> - `UV_THREADPOOL_SIZE=4` (기본값 명시 고정), `WORKER_POOL_SIZE=4`, bcrypt cost=12, phase=30s, cool-down=20s
> - k6 시나리오: hash 20 VU constant + health 10 RPS arrival-rate (각 phase 병행)

### 4.1 health probe latency (`http_req_duration{endpoint:health}`)

| stat  | sync          | async       | worker      |
| ----- | ------------- | ----------- | ----------- |
| avg   | **26767.12ms** | 2.07ms      | **1.70ms**  |
| med   | 30136.81ms    | 1.59ms      | 1.44ms      |
| p(90) | 34682.88ms    | 3.02ms      | 2.48ms      |
| p(95) | 35236.97ms    | 3.56ms      | 3.25ms      |
| p(99) | **35463.58ms** | 11.45ms     | **4.64ms**  |
| max   | 35520.19ms    | 28.46ms     | 12.38ms     |

#### 시각화 (p99 기준, 로그 스케일)

```
sync     │██████████████████████████████████████████  35463ms
async    │                                              11.45ms
worker   │                                               4.64ms
         └───────────────────────────────────────────────────►
         0                                            36000ms
```

**해석**: sync 페이즈의 `/health` p99는 **35.46초** — k6의 기본 60s timeout 직전까지 밀려 사실상 응답 못함. async는 **11.45ms**, worker는 **4.64ms**로 정상 수준. **sync 대비 약 7,600배(worker) / 3,100배(async) 빠르다**. → **H1 강하게 검증**.

worker가 async보다 한 자릿수 빠른 것은 메인 스레드가 더 깨끗하기 때문이 아니라 (둘 다 메인은 자유), libuv가 hash 작업으로 일부 점유되면서 메인 이벤트 루프의 macrotask phase 분배에 미세한 영향을 미친 것으로 추정. 본 실험 범위에서는 1차 효과가 아님.

### 4.2 hash route latency (`http_req_duration{endpoint:hash}`)

| stat  | sync          | async      | worker     |
| ----- | ------------- | ---------- | ---------- |
| avg   | **5183.67ms** | 1471.09ms  | 1449.05ms  |
| med   | 3024.57ms     | 1493.92ms  | 1472.61ms  |
| p(90) | 8396.27ms     | 1532.36ms  | 1499.46ms  |
| p(95) | **26542.48ms** | 1537.96ms  | 1507.93ms  |
| p(99) | 35259.72ms    | **1559.85ms** | **2074.66ms** |
| max   | 35618.03ms    | 1578.31ms  | 2098.57ms  |

```
avg     sync    │██████████████████████████████  5184ms
        async   │█████████                       1471ms
        worker  │█████████                       1449ms

p(99)   sync    │██████████████████████████████  35260ms
        async   │██                              1560ms
        worker  │██                              2075ms
                └──────────────────────────────────────►
                0                                  36000ms
```

**해석**:
- sync는 **자기 자신도 망가진다** — 20 VU가 단일 메인 스레드를 두고 경쟁하므로 직렬화. avg 5.2초, p99 35초로 거의 모든 요청이 timeout 직전.
- async vs worker의 hash latency는 **사실상 동일** (avg 1.47s vs 1.45s, p99 1.56s vs 2.07s). 둘 다 4-스레드 풀이라 처리 속도가 비슷한 게 자연스러움.
- worker의 p99(2.07s)가 async(1.56s)보다 약간 높은 것은 Piscina의 메시지 직렬화 + Worker 부팅 jitter 오버헤드로 추정 (1차 hit는 워커 spawn 비용 포함).

### 4.3 처리량 / 오류율

| variant  | reqs (count) | fail rate | 비고                          |
| -------- | ------------ | --------- | --------------------------- |
| sync     | **185**      | 0.00%     | 대부분 응답 못함, probe도 대거 드롭     |
| async    | **716**      | 0.00%     |                             |
| worker   | **725**      | 0.00%     |                             |

```
sync    │██████                          185 reqs
async   │████████████████████████        716 reqs
worker  │████████████████████████▌       725 reqs
        └──────────────────────────────────────►
        0                                   800
```

**해석**: sync 페이즈의 reqs 수가 async/worker의 **1/4 수준**. 이유는 두 가지가 합쳐진 결과:
1. **hash 요청 자체가 직렬화** → 30s 동안 20VU가 메인 스레드 하나를 두고 줄섬 → 처리량 폭락
2. **probe 라우트도 같이 죽음** → arrival-rate 10 RPS 달성 못해 k6가 242건 드롭(`dropped_iterations: 242`). probe VU는 maxVUs 50까지 늘었지만 응답을 못 받아 다음 iteration을 못 시작.

fail rate는 모두 0% — 응답이 늦더라도 결국은 반환되었기 때문. **타임아웃 정책이 더 짧았다면 sync는 fail rate가 폭증했을 것**.

### 4.4 가설 검증 요약

| 가설 | 결과 | 비고 |
| --- | --- | --- |
| **H1**: sync-hash가 메인 스레드 점유 시 health가 폭증 | ✅ 강하게 검증 | health p99 35.46초 (사실상 timeout) |
| **H2**: async-hash는 메인 자유 → health 정상 | ✅ 검증 | health p99 11.45ms |
| **H3**: worker-hash는 가장 안정, hash throughput은 비슷 | ✅ 검증 | health p99 4.64ms (가장 안정), hash 처리량 worker 725 vs async 716 (사실상 동일) |

---

## 5. 결론

### 5.1 핵심 인사이트

1. **메인 스레드 정지 = 서버 전체 정지**. sync 페이즈에서 `/health`(아무 일도 안 하는 라우트)가 35초까지 밀린 것이 그 직접 증거. CPU 작업이 메인 스레드에 들어가는 순간 hash 라우트뿐 아니라 **무관한 모든 엔드포인트가 함께 죽는다**. 이것이 case2(메인 정지)와 case1(libuv 풀 경합)의 격이 다른 이유.

2. **libuv 위임과 worker 위임은 "메인 스레드 보호"라는 1차 목표에서는 동등**하다. 본 실험의 health p99 차이(11.45ms vs 4.64ms)는 모두 정상 범위이며, 실용적 격차는 case1에서 본 "libuv 풀이 다른 fs/crypto와 공유 자원이라 외부 영향이 큼"이라는 *2차 효과*에서 발생한다. case2 단독으로는 두 방식의 우열이 분명하지 않지만, **시스템 전체 격리**가 필요한 경우 worker 풀이 더 깨끗한 선택.

3. **`Sync` 접미사 = 위험 신호**. Node 생태계의 명명 규약상 `Sync`가 붙은 함수는 호출 스레드에서 동기적으로 실행된다 (libuv 안 거침). 메인 스레드에서 부르면 모든 게 정지하고, worker 안에서 부르면 그 워커만 멈춘다. 본 실험의 `/case2/worker-hash`가 워커 내부에서 `bcrypt.hashSync`를 쓴 이유는 — 이미 격리된 워커 안에서는 굳이 libuv로 한 번 더 떠넘길 필요가 없기 때문.

### 5.2 운영 적용 시 고려사항

- **"이거 sync 함수인가?"가 코드 리뷰 1번 항목**. `bcrypt.hashSync`, `fs.readFileSync`, `crypto.pbkdf2Sync`, `JSON.stringify(거대 객체)`, 복잡한 정규식 등 메인 스레드에서 도는 CPU 작업은 운영 환경에서 절대 금지. 발견 즉시 async 버전으로 교체하거나 worker로 오프로드.
- **이벤트 루프 lag 모니터링**을 도입한다. `perf_hooks`의 `monitorEventLoopDelay`나 `event-loop-lag` 같은 도구로 p99 latency를 메트릭화하면 sync 코드가 슬쩍 섞여 들어와도 조기에 잡힌다.
- **임의 JS CPU 작업은 worker**, **네이티브 비동기 API는 libuv**. 비즈니스 로직(복잡한 계산, 이미지 처리, 압축 알고리즘)은 worker로, 라이브러리 차원에서 이미 비동기 API를 제공하는 작업은 그 비동기 버전을 그대로 사용한다.

---

## 6. 디렉토리 구조

```
k6/
├── lib/
│   └── build-summary.js              ← 공용 handleSummary 빌더
└── case2/
    ├── README.md                     ← (이 문서)
    ├── scenario/
    │   ├── run.js                    ← k6 시나리오 (A/B/C 단일 파일)
    │   └── summary.mjs               ← 결과 비교 표 출력기
    └── result/
        ├── summary-<timestamp>.json  ← 매 실행 결과
        └── summary-latest.json       ← summary.mjs 기본 입력
```

## 7. 튜닝

```bash
# 기본
k6 run k6/case2/scenario/run.js

# 부하/시간 튜닝
PHASE_SEC=60 HASH_VUS=30 PROBE_RATE=15 \
  k6 run k6/case2/scenario/run.js

# 과거 결과로 표만 재생성
node k6/case2/scenario/summary.mjs \
  k6/case2/result/summary-2026-05-23T....json
```


| env             | default                 | 의미                      |
| --------------- | ----------------------- | ----------------------- |
| `BASE_URL`      | `http://localhost:3000` | api 주소                  |
| `PHASE_SEC`     | `30`                    | 각 phase 길이(초)           |
| `COOL_DOWN_SEC` | `20`                    | phase 사이 idle 시간        |
| `HASH_VUS`      | `20`                    | hash 라우트 동시 VU 수        |
| `PROBE_RATE`    | `10`                    | `/health` probe req/sec |
| `PASSWORD`      | `Passw0rd!1`            | bcrypt 입력값              |


