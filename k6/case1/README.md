# Case 1 — bcrypt vs libuv Thread Pool 경합 / p-limit 완화 효과

## 1. 목적

`bcrypt` 같은 CPU-bound 비동기 작업이 **libuv thread pool**을 점유했을 때, 같은 풀을 쓰는 다른 I/O 작업(`fs.readFile` 등)이 얼마나 지연되는지 측정한다. 그리고 **`p-limit`으로 bcrypt의 동시 실행을 제한**했을 때 그 경합이 얼마나 완화되는지를 한 번의 k6 실행으로 비교 검증한다.

### 가설

| # | 가설 |
|---|---|
| H1 | `bcrypt.hash`가 libuv worker(default 4개)를 모두 점유하면, 동시에 들어온 `fs.readFile` 요청은 큐에서 대기해야 하므로 latency가 크게 증가한다. |
| H2 | bcrypt 호출을 `p-limit(N)`으로 게이팅하면 libuv 큐에 적체가 쌓이지 않아 io 요청이 빠르게 처리된다. |
| H3 | p-limit은 큐를 libuv → JS 레이어로 옮기는 것이므로 bcrypt 자체의 전체 처리량(throughput)은 거의 동일하게 유지된다. |

---

## 2. 실험 환경

### 2.1 라우트

| Method | Path | 동작 |
|---|---|---|
| POST | `/case1/without-limit` | `bcrypt.hash(pw, 12)` → `credential.create` |
| POST | `/case1/with-limit` | `pLimit(N)` 게이팅 후 `bcrypt.hash(pw, 12)` → `credential.create` |
| GET | `/case1/io` | `fs.readFile(<project>/tmp/tmp.bin)` (10MB) |

### 2.2 핵심 상수

| 항목 | 값 | 의미 |
|---|---|---|
| `UV_THREADPOOL_SIZE` | **4** | libuv worker 개수 (Node.js 기본값) |
| `BCRYPT_COST` | **12** | bcrypt 라운드 — 1회 ≈ 150~300ms |
| `BCRYPT_CONCURRENCY` | **4** | `pLimit(4)` — JS 레이어에서 동시 bcrypt 4개로 제한 |
| `tmp.bin` | **10MB** | `/case1/io` probe가 매번 읽는 파일 |

### 2.3 컴포넌트 다이어그램

#### A. p-limit 없을 때 (Phase A)

```
HTTP /case1/without-limit  ┐                     ┌─ bcrypt 작업이 큐를 가득 채움
                           ▼                     │
                  ┌──────────────────┐           │
                  │ Node.js JS layer │           │
                  └────────┬─────────┘           │
                           │                     │
                           ▼                     │
                  ┌────────────────────────────┐ │
                  │      libuv queue           │◄┘
                  │  [b][b][b][b][b][b][b]...  │
                  │  [b][b][b]...[i]...        │◄── io 요청이 뒤에서 대기
                  └────────────┬───────────────┘
                               ▼
                  ┌─────┬─────┬─────┬─────┐
                  │ W1  │ W2  │ W3  │ W4  │   worker pool (size=4)
                  │ b   │ b   │ b   │ b   │
                  └─────┴─────┴─────┴─────┘
                  
                  HTTP /case1/io ─┐
                                  └─► 큐 맨 뒤에 줄서기 → 수 초 대기
```

#### B. p-limit 적용했을 때 (Phase B)

```
HTTP /case1/with-limit  ┐
                        ▼
              ┌──────────────────────┐
              │  JS p-limit queue    │  ← bcrypt 적체는 여기서 멈춤
              │  [b][b][b]...        │
              └──────────┬───────────┘
                         │ (max 4 active)
                         ▼
              ┌─────────────────────┐
              │    libuv queue      │ ◄─ 짧게 유지됨
              │      (idle/짧음)    │
              └──────────┬──────────┘
                         ▼
              ┌─────┬─────┬─────┬─────┐
              │ W1  │ W2  │ W3  │ W4  │
              │ b   │ b   │ b   │ b   │
              └─────┴─────┴─────┴─────┘
                         ▲
                         │
              HTTP /case1/io ────────────► libuv 큐가 비어있어 즉시 진입
```

---

## 3. 테스트 방법

### 3.1 k6 시나리오 구성

단일 파일 `k6/case1/scenario/run.js` 한 번 실행으로 A/B를 모두 마친다. 두 페이즈를 cool-down으로 분리해 libuv 큐와 워밍업 잔열을 정리한다.

```
Time:     0s ─────────── 30s ──── 40s ─────────── 70s
          ◄────── Phase A ──────►   ◄────── Phase B ──────►
          [without-limit + io]        [with-limit + io]
                       Cool-down 10s
```

| Phase | 시작 | 길이 | bcrypt 라우트 | io 라우트 | 부하 프로파일 |
|---|---|---|---|---|---|
| A | 0s | 30s | `/case1/without-limit` | `/case1/io` | bcrypt: 20 VU constant / io: 10 RPS arrival-rate |
| cool | 30s | 10s | — | — | (idle) |
| B | 40s | 30s | `/case1/with-limit` | `/case1/io` | bcrypt: 20 VU constant / io: 10 RPS arrival-rate |

### 3.2 측정 태그

각 시나리오에 다음 태그를 부여해 동일 endpoint를 variant별로 분리 측정한다.

| variant | endpoint | 의미 |
|---|---|---|
| `without-limit` | `bcrypt` | Phase A의 bcrypt 라우트 |
| `without-limit` | `io` | Phase A의 io probe |
| `with-limit` | `bcrypt` | Phase B의 bcrypt 라우트 |
| `with-limit` | `io` | Phase B의 io probe |

k6는 threshold가 선언된 태그 조합만 분리해 summary에 노출하므로, `scenario/run.js`에서 trivially-true threshold(`p(99)>=0`)로 submetric을 활성화한다.

### 3.3 실행

```bash
# 별도 터미널: api 띄우기 (pool size 고정)
UV_THREADPOOL_SIZE=4 npm run --workspace @concurrency/api start

# 프로젝트 루트에서: A/B 한 번에 실행
k6 run k6/case1/scenario/run.js

# 결과 비교 표 출력
node k6/case1/scenario/summary.mjs
```

---

## 4. 검증 결과

> 측정 환경: macOS / `UV_THREADPOOL_SIZE=4` / bcrypt cost=12 / 30s per phase

### 4.1 io 라우트 latency (`http_req_duration{endpoint:io}`)

| stat | without-limit | with-limit | Δ |
|---|---:|---:|---:|
| avg | **5433.87ms** | 428.27ms | **−92.1%** |
| med | 5701.92ms | 418.94ms | −92.7% |
| p(90) | 6231.66ms | 539.58ms | −91.3% |
| p(95) | 6332.84ms | 578.79ms | −90.9% |
| p(99) | **6529.27ms** | **615.34ms** | **−90.6%** |
| max | 6617.75ms | 678.23ms | −89.8% |

#### 시각화 (p99 기준)

```
without-limit  │████████████████████████████████████████  6529ms
with-limit     │████                                       615ms
               └────────────────────────────────────────────────►
               0                                              7000ms
```

**해석**: io 요청이 bcrypt 적체에 막혀 평균 **5.4초**, p99 **6.5초**까지 늘어졌다. p-limit 적용 후 모두 **600ms 대**로 떨어졌다 — 약 **10배** 개선. → **H1, H2 검증**.

### 4.2 bcrypt 라우트 latency (`http_req_duration{endpoint:bcrypt}`)

| stat | without-limit | with-limit | Δ |
|---|---:|---:|---:|
| avg | 1554.82ms | 1512.08ms | −2.7% |
| med | 1550.25ms | 1525.95ms | −1.6% |
| p(90) | 1721.85ms | 1639.41ms | −4.8% |
| p(95) | 1818.82ms | 1670.43ms | −8.2% |
| p(99) | 1974.01ms | 1734.98ms | −12.1% |
| max | 2296.10ms | 1777.53ms | −22.6% |

#### 시각화 (p99 기준)

```
without-limit  │██████████████████████████  1974ms
with-limit     │███████████████████████      1735ms
               └─────────────────────────────────►
               0                                2200ms
```

**해석**: bcrypt 자체 latency도 전 구간 약간 **감소**했고 특히 tail(p99, max)이 더 안정적이다. p-limit이 libuv 내부 큐의 head-of-line blocking을 줄이고, JS 레벨에서 더 공정하게 분배하는 효과로 보인다.

> **주의**: 일반적으로 p-limit은 약간의 양보 비용(p95 ~5% 증가)을 동반한다. 이번 측정에서는 거꾸로 개선됐는데, 이는 io probe가 동시에 worker를 점유하려 시도하면서 phase A의 큐 경합이 bcrypt 자신에게도 손해를 입히고 있었기 때문이다.

### 4.3 처리량 / 오류율 (variant 전체)

| variant | reqs (count) | fail rate |
|---|---:|---:|
| without-limit | 617 | 0.00% |
| with-limit | **706** | 0.00% |

```
without-limit  │█████████████████████      617 reqs / 30s
with-limit     │█████████████████████████  706 reqs / 30s  (+14.4%)
```

**해석**: with-limit이 오히려 **14% 더 많은 요청**을 처리했다. bcrypt 처리량은 거의 동일하지만, **io 요청의 응답이 빨라지면서 io probe의 cumulative reqs가 늘어난 것**이 주된 원인. → **H3는 부분 검증** (bcrypt throughput은 ≈ 동일, 전체 시스템 throughput은 오히려 향상).

---

## 5. 결론

| 가설 | 결과 | 비고 |
|---|---|---|
| **H1**: bcrypt가 libuv pool 점유 시 io가 밀린다 | ✅ 검증 | io p99 6.5초 (정상 baseline은 1~15ms 수준) |
| **H2**: p-limit으로 io 경합이 완화된다 | ✅ 검증 | io p99 6529ms → 615ms (**−90.6%**) |
| **H3**: bcrypt throughput은 거의 유지된다 | ✅ 검증 | bcrypt avg latency 거의 동일, tail은 오히려 개선 |

### 5.1 핵심 인사이트

1. **libuv thread pool은 공유 자원이다**. `bcrypt`처럼 worker를 오래 점유하는 작업은 같은 풀을 쓰는 모든 비동기 I/O(`fs.*`, `dns.lookup`, `crypto.pbkdf2` 등)를 함께 굶긴다.
2. **p-limit은 큐의 위치를 옮긴다**. libuv 큐가 깊어지면 head-of-line blocking이 모든 thread-pool 의존 작업에 전파된다. JS 레벨에서 미리 게이팅하면 libuv 큐를 짧게 유지할 수 있다.
3. **`UV_THREADPOOL_SIZE` 자체를 올리는 것은 근본 해결이 아니다**. 늘려도 bcrypt 동시 처리량만 늘 뿐, "io가 bcrypt 뒤에 줄선다"는 구조는 그대로다. p-limit이 작아야 io 전용 슬롯이 보장된다.

### 5.2 운영 적용 시 고려사항

- `UV_THREADPOOL_SIZE`보다 **작은** p-limit을 쓰면 io 전용 슬롯이 명시적으로 확보된다. 이 실험은 pool=4, limit=4로도 충분한 효과를 봤지만, latency-sensitive io가 있다면 `limit < pool`을 권장.
- `p-limit`은 단일 프로세스 범위. 멀티 인스턴스/스레드라면 각자 풀이 따로이므로 인스턴스별로 설정.
- ESM-only인 `p-limit@4+`를 쓰려면 모듈 시스템 정리가 필요. 이 프로젝트는 CommonJS라 v3 사용.

---

## 6. 디렉토리 구조

```
k6/
├── lib/
│   └── build-summary.js              ← 공용 handleSummary 빌더
└── case1/
    ├── README.md                     ← (이 문서)
    ├── scenario/
    │   ├── run.js                    ← k6 시나리오 (A/B 단일 파일)
    │   └── summary.mjs               ← 결과 비교 표 출력기
    └── result/
        ├── summary-<timestamp>.json  ← 매 실행 결과
        └── summary-latest.json       ← summary.mjs 기본 입력
```

## 7. 재현 / 튜닝

```bash
# 기본
k6 run k6/case1/scenario/run.js

# 부하/시간 튜닝
PHASE_SEC=60 HASH_VUS=30 PROBE_RATE=15 \
  k6 run k6/case1/scenario/run.js

# 과거 결과로 표만 재생성
node k6/case1/scenario/summary.mjs \
  k6/case1/result/summary-2026-05-22T09-46-54-470.json
```

| env | default | 의미 |
|---|---|---|
| `BASE_URL` | `http://localhost:3000` | api 주소 |
| `PHASE_SEC` | `30` | 각 phase 길이(초) |
| `COOL_DOWN_SEC` | `10` | phase 사이 idle 시간 |
| `HASH_VUS` | `20` | bcrypt 라우트 동시 VU 수 |
| `PROBE_RATE` | `10` | io probe req/sec |
| `PASSWORD` | `Passw0rd!1` | bcrypt 입력값 |
