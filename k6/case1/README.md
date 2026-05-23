# Case 1 — libuv Thread Pool 경합

## 1. 목적

`bcrypt` 같은 CPU-bound 비동기 작업이 **libuv thread pool**을 점유했을 때, 같은 풀을 쓰는 다른 I/O 작업(`fs.readFile` 등)이 얼마나 지연되는지 측정한다. 그리고 `**p-limit`으로 bcrypt의 동시 실행을 제한**했을 때 그 경합이 얼마나 완화되는지를 한 번의 k6 실행으로 비교 검증한다.

> **HOL(Head-of-Line) blocking**: 단일 큐에서 맨 앞 작업이 막히면(=worker가 모두 점유되면) 뒤에 들어온 모든 작업이 자기 처리 시간과 무관하게 함께 대기하는 현상. 본 실험에서 io 요청이 bcrypt 뒤에서 수 초간 줄서는 것이 전형적인 사례다.

> **사전 지식**: `bcrypt`(native addon)는 내부적으로 `uv_queue_work`를 호출해 해시 연산을 libuv worker pool에 위임한다. 따라서 `fs.`*, `dns.lookup`, `crypto.pbkdf2` 등 같은 풀을 공유하는 모든 작업과 자원을 경쟁한다. (순수 JS 구현인 `bcryptjs`는 이벤트 루프에서 동기 실행되므로 본 실험과 거동이 다르다.)

### 가설


| #   | 가설                                                                                                         |
| --- | ---------------------------------------------------------------------------------------------------------- |
| H1  | `bcrypt.hash`가 libuv worker(default 4개)를 모두 점유하면, 동시에 들어온 `fs.readFile` 요청은 큐에서 대기해야 하므로 latency가 크게 증가한다. |
| H2  | bcrypt 호출을 `p-limit(N)`으로 게이팅하면 libuv 큐에 적체가 쌓이지 않아 io 요청이 빠르게 처리된다.                                       |
| H3  | p-limit은 큐를 libuv → JS 레이어로 옮기는 것이므로 bcrypt 자체의 전체 처리량(throughput)은 거의 동일하게 유지된다.                          |


---

## 2. 실험 환경

### 2.1 라우트


| Method | Path                   | 동작                                                            |
| ------ | ---------------------- | ------------------------------------------------------------- |
| POST   | `/case1/without-limit` | `bcrypt.hash(pw, 12)` → `credential.create`                   |
| POST   | `/case1/with-limit`    | `pLimit(N)` 게이팅 후 `bcrypt.hash(pw, 12)` → `credential.create` |
| GET    | `/case1/io`            | `fs.readFile(<project>/tmp/tmp.bin)` (5MB)                    |


### 2.2 핵심 상수


| 항목                   | 값       | 의미                                                                                |
| -------------------- | ------- | --------------------------------------------------------------------------------- |
| `UV_THREADPOOL_SIZE` | **4**   | libuv worker 개수 (Node.js 기본값)                                                     |
| `BCRYPT_COST`        | **12**  | bcrypt 라운드 — 1회 ≈ 150~300ms                                                       |
| `BCRYPT_CONCURRENCY` | **3**   | `pLimit(3)` — JS 레이어에서 동시 bcrypt 3개로 제한. `limit < pool`로 worker 1개를 io 전용 슬롯으로 확보 |
| `tmp.bin`            | **5MB** | `/case1/io` probe가 매번 읽는 파일                                                       |


> **cost=12 선택 근거**: OWASP가 2023년 기준 권장하는 최소 비용. 너무 낮으면(<10) 한 회가 ms 단위라 경합 효과가 잘 드러나지 않고, 너무 높으면(>14) 부하 자체가 비현실적이라 측정 시간이 길어진다. 12는 worker를 약 200~300ms 점유해 큐 적체를 확실히 만들면서도 30s phase 안에 통계적 의미가 충분히 누적되는 지점.

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

#### B. p-limit 적용했을 때 (Phase B, `limit=3 < pool=4`)

```
HTTP /case1/with-limit  ┐
                        ▼
              ┌──────────────────────┐
              │  JS p-limit queue    │  ← bcrypt 적체는 여기서 멈춤
              │  [b][b][b][b][b]...  │
              └──────────┬───────────┘
                         │ (max 3 active)
                         ▼
              ┌─────────────────────┐
              │    libuv queue      │ ◄─ 거의 비어있음
              │      (idle)         │
              └──────────┬──────────┘
                         ▼
              ┌─────┬─────┬─────┬─────┐
              │ W1  │ W2  │ W3  │ W4  │
              │ b   │ b   │ b   │ ░░  │  ← W4는 io 전용으로 항상 비어있음
              └─────┴─────┴─────┴─────┘
                                   ▲
                                   │
              HTTP /case1/io ──────┘  ► 대기 없이 즉시 W4로 진입
```

> **왜 `limit < pool` (3 < 4)이 io를 sub-ms 가까이 떨어뜨리나?**
> JS p-limit이 bcrypt를 동시에 3개로 제한하므로 libuv worker 4개 중 1개는 *구조적으로* bcrypt에 점유될 수 없다. 따라서 io 요청은 거의 항상 빈 worker를 즉시 차지하고 libuv 큐를 거치지 않는다. 본 측정에서 io p99이 **30.88ms**까지 떨어진 것이 이 효과의 직접적 결과다. 반대로 `limit == pool`로 두면 io는 bcrypt 슬롯이 잠깐 비는 순간만 노릴 수 있어 평균 100~600ms대까지만 좋아진다.

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


| Phase | 시작  | 길이  | bcrypt 라우트             | io 라우트      | 부하 프로파일                                          |
| ----- | --- | --- | ---------------------- | ----------- | ------------------------------------------------ |
| A     | 0s  | 30s | `/case1/without-limit` | `/case1/io` | bcrypt: 20 VU constant / io: 10 RPS arrival-rate |
| cool  | 30s | 10s | —                      | —           | (idle)                                           |
| B     | 40s | 30s | `/case1/with-limit`    | `/case1/io` | bcrypt: 20 VU constant / io: 10 RPS arrival-rate |


### 3.2 측정 태그

각 시나리오에 다음 태그를 부여해 동일 endpoint를 variant별로 분리 측정한다.


| variant         | endpoint | 의미                  |
| --------------- | -------- | ------------------- |
| `without-limit` | `bcrypt` | Phase A의 bcrypt 라우트 |
| `without-limit` | `io`     | Phase A의 io probe   |
| `with-limit`    | `bcrypt` | Phase B의 bcrypt 라우트 |
| `with-limit`    | `io`     | Phase B의 io probe   |


k6는 threshold가 선언된 태그 조합만 분리해 summary에 노출하므로, `scenario/run.js`에서 trivially-true threshold(`p(99)>=0`)로 submetric을 활성화한다.

### 3.3 실행

```bash
# (사전 준비) io probe가 읽을 5MB 파일을 프로젝트 루트의 tmp/ 에 만든다
mkdir -p tmp
mkfile -n 5m ./tmp/tmp.bin                           # macOS (sparse, 즉시 생성)

# 별도 터미널: api 띄우기 (pool size 고정)
UV_THREADPOOL_SIZE=4 npm run --workspace @concurrency/api start

# 프로젝트 루트에서: A/B 한 번에 실행
k6 run k6/case1/scenario/run.js

# 결과 비교 표 출력
node k6/case1/scenario/summary.mjs
```

## 검증 결과

> **측정 환경**
>
> - OS: macOS (Darwin 24.1.0, Apple Silicon)
> - `UV_THREADPOOL_SIZE=4` (기본값 명시 고정), `BCRYPT_CONCURRENCY=3`, bcrypt cost=12, phase=30s
> - k6 시나리오: bcrypt 20 VU constant + io 10 RPS arrival-rate

### 4.1 io 라우트 latency (`http_req_duration{endpoint:io}`)


| stat  | without-limit | with-limit  | Δ          |
| ----- | ------------- | ----------- | ---------- |
| avg   | **3617.42ms** | 5.36ms      | **−99.9%** |
| med   | 4301.41ms     | 3.26ms      | −99.9%     |
| p(90) | 5597.36ms     | 7.51ms      | −99.9%     |
| p(95) | 5798.03ms     | 16.25ms     | −99.7%     |
| p(99) | **6062.49ms** | **30.88ms** | **−99.5%** |
| max   | 6309.98ms     | 152.39ms    | −97.6%     |


#### 시각화 (p99 기준)

```
without-limit  │████████████████████████████████████████  6062ms
with-limit     │▏                                           31ms
               └────────────────────────────────────────────────►
               0                                              6500ms
```

**해석**: io 요청이 bcrypt 적체에 막혀 평균 **3.6초**, p99 **6.0초**까지 늘어졌다. `limit=3 < pool=4` 적용 후 평균 **5ms / p99 31ms**로 떨어졌다 — 약 **200배** 개선. worker 1개가 구조적으로 io 전용이 되면서 io는 사실상 큐를 거치지 않는다. → **H1, H2 강하게 검증**.

### 4.2 bcrypt 라우트 latency (`http_req_duration{endpoint:bcrypt}`)


| stat  | without-limit | with-limit | Δ          |
| ----- | ------------- | ---------- | ---------- |
| avg   | 1848.38ms     | 2142.39ms  | **+15.9%** |
| med   | 1569.11ms     | 2008.83ms  | **+28.0%** |
| p(90) | 1993.04ms     | 2397.70ms  | +20.3%     |
| p(95) | **6492.08ms** | 4364.53ms  | **−32.8%** |
| p(99) | 7086.18ms     | 5511.61ms  | −22.2%     |
| max   | 7263.86ms     | 5846.90ms  | −19.5%     |


#### 시각화 (avg / p99 두 축)

```
avg     without-limit │████████████████          1848ms
        with-limit    │████████████████████      2142ms  (+15.9%)

p(99)   without-limit │████████████████████████████████████████  7086ms
        with-limit    │███████████████████████████████            5512ms  (-22.2%)
                      └──────────────────────────────────────────────►
                      0                                          7500ms
```

**해석**: 결과가 둘로 갈린다.

- **avg / med / p90 는 악화 (+16~28%)**: bcrypt에 할당 가능한 worker가 4 → 3으로 줄었으므로 *평균 처리량*은 직접적으로 손해를 본다. 이것이 `limit < pool`의 정직한 비용.
- **p95 / p99 / max 는 개선 (-19~33%)**: without-limit은 libuv 큐 깊이가 폭주하면서 tail이 6~7초까지 튄다 (p95에서 avg의 4배). limit이 걸리면 큐 길이가 통제되어 tail이 평탄해진다.

> **재해석**: 직전 측정(`limit=4`)에서 보였던 "bcrypt도 일관되게 개선" 그림은 사라졌다. 이번 결과가 더 일반적인 trade-off 구조 (**throughput ↓ vs tail latency ↑ 안정성**)를 정확히 보여준다.

### 4.3 처리량 / 오류율 (variant 전체)


| variant       | reqs (count) | fail rate |
| ------------- | ------------ | --------- |
| without-limit | 598          | 0.00%     |
| with-limit    | **618**      | 0.00%     |


```
without-limit  │████████████████████████   598 reqs / 30s
with-limit     │█████████████████████████  618 reqs / 30s  (+3.3%)
```

**해석**: 전체 reqs는 **+3.3%**로 미세 증가. 내부 구성을 뜯어보면:

- bcrypt reqs는 줄었다 (worker 4→3 효과)
- io reqs는 늘었다 (응답이 빨라져 probe의 arrival-rate가 100% 달성)
- 결과적으로 *총합은 비슷*하지만 **시스템 응답성(io tail)이 200배 좋아졌다**는 점이 본질.

→ **H3는 부분 검증**: bcrypt throughput 자체는 `limit < pool`의 정직한 비용으로 약간 감소. 단, io의 응답성 회복이 이를 보상하므로 전체 시스템 관점에서는 여전히 우위.

---

## 5. 결론


| 가설                                      | 결과       | 비고                                                        |
| --------------------------------------- | -------- | --------------------------------------------------------- |
| **H1**: bcrypt가 libuv pool 점유 시 io가 밀린다 | ✅ 검증     | io p99 6.06초 (정상 baseline은 1~15ms 수준)                     |
| **H2**: p-limit으로 io 경합이 완화된다           | ✅ 강하게 검증 | io p99 6062ms → **30.88ms** (**−99.5%**, 약 200배)          |
| **H3**: bcrypt throughput은 거의 유지된다      | ⚠️ 부분 검증 | avg/med +16~28% 악화 (worker 4→3 비용), 단 tail p99 -22%로 안정성↑ |


### 5.1 핵심 인사이트

1. **libuv thread pool은 공유 자원이다**. `bcrypt`처럼 worker를 오래 점유하는 작업은 같은 풀을 쓰는 모든 비동기 I/O(`fs.`*, `dns.lookup`, `crypto.pbkdf2` 등)를 함께 굶긴다.
2. **p-limit은 큐의 위치를 옮긴다**. libuv 큐가 깊어지면 head-of-line blocking이 모든 thread-pool 의존 작업에 전파된다. JS 레벨에서 미리 게이팅하면 libuv 큐를 짧게 유지할 수 있다. **단, 큐가 사라지는 게 아니라 JS 힙으로 옮겨갈 뿐**이므로 폭주 시 메모리 누수·응답시간 폭주가 가능하다. 운영에서는 (1) p-limit 큐 길이 상한, (2) 그 상한 초과 시 fast-fail(HTTP 429 등), (3) 업스트림 백프레셔(rate-limit, queue depth metric) 세 가지를 함께 갖춰야 한다.
3. `**UV_THREADPOOL_SIZE` 자체를 올리는 것은 근본 해결이 아니다**. 늘려도 bcrypt 동시 처리량만 늘 뿐, "io가 bcrypt 뒤에 줄선다"는 구조는 그대로다. p-limit이 작아야 io 전용 슬롯이 보장된다.

### 5.2 운영 적용 시 고려사항

- `UV_THREADPOOL_SIZE`보다 **작은** p-limit을 쓰면 io 전용 슬롯이 명시적으로 확보된다. 본 실험의 `pool=4 / limit=3` 구성은 io tail을 단일 자리수 ms로 떨어뜨리는 대신 bcrypt avg를 ~16% 양보했다. **io latency가 SLO 핵심 지표라면 이 trade-off는 충분히 가치 있다**. 반대로 bcrypt 처리량이 critical path라면 `limit == pool`로 두거나 io를 다른 자원(별도 풀, 캐시 등)으로 분리하는 편이 낫다.
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

## 7. 튜닝

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


| env             | default                 | 의미                 |
| --------------- | ----------------------- | ------------------ |
| `BASE_URL`      | `http://localhost:3000` | api 주소             |
| `PHASE_SEC`     | `30`                    | 각 phase 길이(초)      |
| `COOL_DOWN_SEC` | `10`                    | phase 사이 idle 시간   |
| `HASH_VUS`      | `20`                    | bcrypt 라우트 동시 VU 수 |
| `PROBE_RATE`    | `10`                    | io probe req/sec   |
| `PASSWORD`      | `Passw0rd!1`            | bcrypt 입력값         |


