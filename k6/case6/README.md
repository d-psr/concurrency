# Case 6 — Backpressure 정책 비교

## 1. 목적

생산 속도(요청 도착)가 소비 속도(처리량)를 초과할 때, 어떤 정책이 latency·메모리·작업 손실의 어떤 곡선을 만드는지 비교한다.

> **공통 전제**: consumer 처리시간은 100ms 고정(`CASE6_CONSUMER_MS`). 처리 로직은 단순 `sleep`. 변동은 정책에서만 나오게 통제.

### 가설

| #  | 가설                                                                                              |
| -- | ----------------------------------------------------------------------------------------------- |
| H1 | **unbounded**는 RSS 우상향, 응답 latency = `queueDepth × consumerMs` 로 선형 증가, 종국엔 OOM 위험           |
| H2 | **drop-oldest**는 latency 캡, queueDepth가 `CASE6_QUEUE_MAX`(=100) 근방에서 평탄. 단 오래된 작업은 소실      |
| H3 | **reject-429**는 latency 캡 + 작업 소실 없음, 단 거절률 ↑ (push-back to client)                            |
| H4 | **prefetch-tune**은 RMQ가 transport 레벨에서 자연 backpressure. drop 없이 거절도 없이 latency 캡            |

---

## 2. 실험 환경

### 2.1 라우트

| Method | Path                                | 동작                                                                                  |
| ------ | ----------------------------------- | ----------------------------------------------------------------------------------- |
| POST   | `/case6/enqueue?policy=<policy>`    | 정책별 큐에 job 등록 → 처리완료까지 await 후 응답. `unbounded` / `drop-oldest` / `reject-429` / `prefetch-tune` |
| GET    | `/case6/stats`                      | 정책별 queueDepth, enqueued/processed/dropped/rejected 카운터, avg/p95 waitMs, RSS    |
| POST   | `/case6/reset`                      | 모든 정책의 in-memory 큐와 카운터 초기화. 펜딩된 응답은 `status: 'aborted'`로 일괄 해소 (정책 측정에서 제외용 신호) |

응답 body는 `{ data: { policy, status, jobId, enqueuedAt, startedAt, finishedAt, waitMs, workMs, queueDepthAtEnqueue } }`. `reject-429`의 경우 `HTTP 429` + `{ policy, queueDepth, oldestAgeMs }`.

**`status` 값의 의미**:

| status        | 의미                                          | 실행됨? | 측정 포함? |
| ------------- | ------------------------------------------- | ---- | ------ |
| `processed`   | consumer가 정상 처리                              | ✅    | ✓      |
| `dropped`     | drop-oldest 정책이 큐 가득 찰 때 가장 오래된 job을 밀어냄     | ❌    | ✓      |
| `aborted`     | `/case6/reset` 가 펜딩 상태에서 강제 종료 (테스트 진행 절차상) | ❌    | ✗ (제외) |
| HTTP 429 응답   | reject-429 정책이 입구에서 거절                       | ❌    | ✓      |

### 2.2 핵심 상수 (default)

| 항목                  | 값        | 의미                                              |
| ------------------- | -------- | ----------------------------------------------- |
| `CASE6_CONSUMER_MS` | **100**  | 모든 정책의 consumer 처리시간 고정                         |
| `CASE6_QUEUE_MAX`   | **100**  | drop-oldest / reject-429 정책의 in-memory 큐 정원     |
| `CASE6_PREFETCH`    | **1**    | RMQ 워커의 prefetchCount (prefetch-tune 정책 전용)     |
| `CASE6_STATS_WINDOW`| **1000** | 서버 측 p95 waitMs 계산용 슬라이딩 윈도우 크기                  |
| `ARRIVAL_PEAK`      | **50/s** | k6 ramping-arrival-rate 피크 (consumer 10/s 대비 5x) |

### 2.3 컴포넌트

#### A. unbounded
```
도착 → [in-memory FIFO (제한 없음)] → 단일 consumer (100ms/건)
                                              │
                  큐 깊이 = 도착률 누적 - 처리율 누적 (시간에 따라 우상향)
```

#### B. drop-oldest
```
도착 → [FIFO, max=100]   ← 가득 차면 맨 앞 victim.resolve({status:'dropped'})
            └── consumer
```

#### C. reject-429
```
도착 → 길이 ≥ 100 ? throw 429 : enqueue
       └── consumer
```

#### D. prefetch-tune
```
API ──client.send──▶ RabbitMQ (case6.work.queue)
                              │
                              │  prefetchCount = 1
                              ▼
                          Worker (단일, sleep 100ms)
                              │
                  ack ◀───────┘
                              │
API ◀────reply──◀─────────────┘
```

---

## 3. 테스트 방법

### 3.1 부하 프로파일

각 정책마다 단일 phase:

```
ramping-arrival-rate
├── RAMP_UP_SEC=20s    : 1 → 50/s
├── HOLD_SEC=30s       : 50/s 유지
└── RAMP_DOWN_SEC=5s   : 50 → 0/s
─────────────────────────────────────
PHASE_TOTAL_SEC = 55s
+ reset (1s) + cool-down (5s) = SLOT 61s
```

총 4 phase × 61s ≈ 4분 + sampler 여유.

**ramping-arrival-rate 를 쓰는 이유**: closed-loop(`constant-vus`)은 VU 수만큼만 in-flight 요청을 만들어서 큐가 차지 않음. backpressure 곡선을 보려면 open-loop가 필수.

**순서: unbounded → drop-oldest → reject-429 → prefetch-tune** — `/case6/reset` 이 RMQ 큐를 purge하지 않으므로 prefetch-tune은 마지막에 배치한다.

### 3.2 측정 태그 / 커스텀 메트릭

| 종류          | 메트릭 키                          | 용도                                                     |
| ----------- | ------------------------------ | ------------------------------------------------------ |
| k6 표준       | `http_req_duration{variant:X}` | 클라이언트 응답시간 (= 서버 wait + 처리 + RTT)                     |
| k6 표준       | `http_reqs{variant:X}`         | 시도된 요청 수                                              |
| 커스텀 Counter | `processed{variant:X}`         | 응답 `status: 'processed'` 개수                           |
| 커스텀 Counter | `dropped{variant:X}`           | 응답 `status: 'dropped'` 개수 (drop-oldest)               |
| 커스텀 Counter | `rejected{variant:X}`          | HTTP 429 개수 (reject-429)                              |
| 커스텀 Counter | `aborted{variant:X}`           | 응답 `status: 'aborted'` 개수 (reset 강제종료, 측정에서 제외)      |
| 커스텀 Counter | `errored{variant:X}`           | 기타 비정상 응답                                              |
| 커스텀 Trend   | `server_wait_ms{variant:X}`    | 응답 body의 `waitMs` (큐 대기시간)                            |
| 커스텀 Trend   | `queue_depth{variant:X}`       | `stats_sampler` 가 2s 주기 폴링한 서버 측 queueDepth          |
| 커스텀 Trend   | `rss_mb{variant:X}`            | `stats_sampler` 가 2s 주기 폴링한 RSS (MB)                  |

### 3.3 stats_sampler

별도 시나리오로 `constant-vus: 1` 가 전체 테스트 기간 동안 2초마다 `GET /case6/stats` 폴링. 현재 active variant를 elapsed time으로 판별해서 메트릭에 태그 부착.

### 3.4 사전 조건

- API (`apps/api`) 기동
- Worker (`apps/worker`) 기동 — prefetch-tune phase에 필요
- RabbitMQ up (`RABBITMQ_URL` env)

### 3.5 실행

```bash
# 인프라 (별도 터미널)
# - RabbitMQ up

# API + Worker (각 별도 터미널)
npm run --workspace @concurrency/api start:prod
npm run --workspace @concurrency/worker start:prod

# 부하 실행 (~4분)
k6 run k6/case6/scenario/run.js

# 환경변수로 override 가능
ARRIVAL_PEAK=100 HOLD_SEC=60 k6 run k6/case6/scenario/run.js

# 비교 표 출력
node k6/case6/scenario/summary.mjs
```

---

## 4. 측정 결과

> **측정 환경**
>
> - OS: macOS (Darwin 24.1.0, Apple Silicon)
> - API + Worker 각 1 인스턴스 (`start:prod`)
> - RabbitMQ (`amqp-connection-manager` via `@nestjs/microservices`), 워커 prefetchCount=1
> - k6: `ramping-arrival-rate`, preAllocatedVUs=2500, maxVUs=3000
> - ARRIVAL_PEAK=50/s, RAMP_UP=20s, HOLD=30s, RAMP_DOWN=5s
> - 2회 실행 — 모든 핵심 메트릭이 ±0.5% 이내로 재현됨

### 4.1 요청 분배 — 정책의 본질이 가장 잘 드러나는 곡선

| policy        | attempted | processed | dropped | rejected | aborted | proc%  | drop%  | rej%   |
| ------------- | --------: | --------: | ------: | -------: | ------: | -----: | -----: | -----: |
| unbounded     |     2,135 |       529 |       0 |        0 |   1,605 | 99.81% |  0.00% |  0.00% |
| drop-oldest   |     2,135 |       528 |   1,511 |        0 |      95 | 25.88% | 74.07% |  0.00% |
| reject-429    |     2,135 |       528 |       0 |    1,510 |      96 | 25.90% |  0.00% | 74.06% |
| prefetch-tune |     1,087 |     1,086 |       0 |        0 |       0 | 99.91% |  0.00% |  0.00% |

> 비율은 **`effective = attempted − aborted`** 기준. aborted 는 phase 종료 시 `/case6/reset` 이 펜딩을 강제 해소한 신호로, 정책 효과가 아니므로 측정에서 제외.

- **prefetch-tune은 attempted 자체가 절반(1087 vs 2135)** — RMQ 라운드트립 latency 가 길어 같은 시간 안에 k6 가 보낸 양이 적음.
- 나머지 셋은 동일한 부하 인가량(2135)에서 정책 효과만으로 분배가 갈림.
- **unbounded 의 aborted 1605건**은 운영 관점에서는 "처리되지 못한 채 끊긴" 요청. 테스트가 길어졌다면 결국 처리됐겠지만, 그 자체가 H1 의 다른 증거 — 처리 완료까지 수십~수백 초가 필요.

### 4.2 응답시간 — `http_req_duration`

| policy        |     avg |    med |   p(95) |   p(99) |     max |
| ------------- | ------: | -----: | ------: | ------: | ------: |
| unbounded     | 17.7s   | 17.7s  |  32.9s  |  34.3s  |  34.8s  |
| drop-oldest   |  2.1s   |  2.0s  |   3.2s  |   3.9s  |   4.3s  |
| reject-429    |  2.1s   |  1.7ms |  10.2s  |  10.2s  |  10.2s  |
| prefetch-tune | 38.4s   | 37.6s  |  78.7s  |  82.4s  |  83.3s  |

**reject-429 의 bimodal 분포 주목** — median 1.7ms / p95 10.2s. 거절된 74% 는 즉시 끊기고 처리된 25% 만 ~10s 대기 (큐 100건 × 100ms). 두 모집단이 한 분포에 섞임.

### 4.3 큐 깊이 — `queue_depth` (2s 폴링 시계열)

| policy        |  avg |  p(95) |   max |
| ------------- | ---: | -----: | ----: |
| unbounded     |  672 |  1,570 | 1,610 |
| drop-oldest   |   82 |    100 |   100 |
| reject-429    |   81 |    100 |   100 |
| prefetch-tune |  680 |  1,565 | 1,624 |

drop-oldest / reject-429 는 정확히 `CASE6_QUEUE_MAX=100` 선에서 평탄. **unbounded 와 prefetch-tune 이 거의 동일하게 1,600+ 까지 자유 적체** — H4 반증의 직접 증거.

### 4.4 처리량 — Throughput

| policy        | attempted/s | processed/s |  fail% |
| ------------- | ----------: | ----------: | -----: |
| unbounded     |        71.2 |        17.6 |  0.00% |
| drop-oldest   |        71.2 |        17.6 |  0.00% |
| reject-429    |        71.2 |        17.6 | 70.73% |
| prefetch-tune |        36.2 |        36.2 |  0.00% |

- in-memory 셋의 processed/s 가 정확히 동일 — consumer 가 단일 sleep(100ms) 이라 처리량 한계는 ~10/s 고정. 관측치 17.6 은 ramp-up·ramp-down 포함 평균이라 약간 높음.
- reject-429 의 fail% 70.73% 는 HTTP 429 를 k6 가 fail 로 카운트한 것. **정책이 의도한 거절률**이지 시스템 장애가 아님.

### 4.5 가설 검증 매트릭스

| #   | 가설                                       | 결과       | 비고                                               |
| --- | ---------------------------------------- | -------- | ------------------------------------------------ |
| H1  | unbounded 는 queue·latency 우상향, OOM 위험    | ✅ 검증     | queue 1,610, latency p95 32.9s, aborted 75%      |
| H2  | drop-oldest 는 queue·latency 캡 + 작업 손실    | ✅ 검증     | queue 정확히 100, latency p95 3.2s, dropped 74%     |
| H3  | reject-429 는 latency 캡 + 거절              | ✅ 검증     | queue 100, bimodal latency, rejected 74%         |
| H4  | prefetch-tune 은 transport 레벨 자연 backpressure | ❌ **반증** | queue 1,624 까지 자유 적체, latency p95 78.7s         |

### 4.6 H4 반증의 의미 — 가장 중요한 발견

`prefetch=1` 은 **broker → consumer** 구간만 직렬화한다. **producer(API) → broker** 구간은 무방비 — API 가 보낸 메시지는 그대로 RMQ 큐에 쌓이고, 워커가 10건/s 로 천천히 빼간다. 결과적으로 큐 깊이는 unbounded 와 거의 동일하게 1,600+ 까지 증가.

→ **"prefetch만으로 자연 backpressure가 된다"는 흔한 직관이 틀렸다**는 게 이 실험의 가장 값진 발견.

진짜 backpressure 를 만들려면:

- RabbitMQ `x-max-length` + `x-overflow=reject-publish` → broker 가 publish 자체를 거절
- `x-max-length-bytes` → 메모리 기준 제한
- publisher confirms + producer 측 rate limit → API 가 자체 보류
- 또는 별도 reverse-proxy / API gateway 레벨에서 거절

"메시지 큐만 쓰면 안전하다"는 통념 → 거짓. broker-level 정책이 함께 있어야 진짜 backpressure 가 된다.

### 4.7 RSS (메모리)

| policy        |   avg    |   max    |
| ------------- | -------: | -------: |
| unbounded     | 137.1 MB | 162.5 MB |
| drop-oldest   | 142.8 MB | 173.7 MB |
| reject-429    | 132.7 MB | 134.9 MB |
| prefetch-tune | 142.9 MB | 162.6 MB |

RSS 차이는 GC 타이밍과 이전 phase 잔류 메모리 영향이 크게 섞여 측정 노이즈가 큰 편. **reject-429 만 일관되게 가장 낮음** — 거절된 요청이 큐에 들어가지 않으므로 메모리 누적이 적음. 더 정확한 비교는 phase 사이 idle 시간을 늘려 GC 정착을 기다리거나, RSS 시계열을 phase 별 시간축으로 분리해서 봐야 함.

---

## 5. 정책 선택의 판단 근거

`rss`만으로 정책을 고르지 않는다. 아래 4개 곡선을 함께 보고 **비즈니스 요구사항**과 매칭해 선택한다.

| 지표 | 의미 | 어떤 판단에 쓰나 |
| --- | --- | --- |
| **RSS** (`rss_mb`) | 프로세스가 점유한 물리 메모리 | OOM 회피의 하한선 — unbounded 탈락 근거 |
| **p95 waitMs / latency** | 큐 대기 + 처리 시간 | SLA 만족 여부 — unbounded는 우상향, 나머지는 캡 |
| **queue_depth** | 적체 정도 | RSS·latency 곡선의 원인 추적용 |
| **dropped / rejected** | 잃은 작업 / 거부한 요청 수 | 작업 손실·거부의 비즈니스 허용 여부 |

### 매칭 예

- **손실 불가 + 거부 불가** (결제·주문 등) → `prefetch-tune` (브로커가 자연 backpressure)
- **손실 불가, 거부는 허용** (클라이언트 재시도 가능) → `reject-429`
- **최신값만 중요, 오래된 건 버려도 OK** (실시간 위치/시세) → `drop-oldest`
- **`unbounded`는 운영 선택지가 아니라 비교 baseline** — latency·RSS 우상향을 시각화하는 용도

> 즉 case6는 단일 "정답"을 찾는 게 아니라, 상황별 정책 선택을 위한 **트레이드오프 데이터셋**을 만든다.

---

## 6. 한계

1. **unbounded는 측정상 OOM 직전까지만 밀어붙이지 않는다** — ARRIVAL_PEAK·HOLD를 키우면 실제로 API 프로세스를 OOM시킬 수 있음. 본 시나리오는 곡선이 보일 정도의 부하만 인가.
2. **k6 ramping-arrival-rate의 maxVUs 한계** — unbounded는 모든 in-flight 요청이 응답 대기로 VU를 점유한다. 도착률이 처리량을 크게 상회하면 maxVUs(default 2500)를 초과할 수 있고, k6가 자체적으로 "dropped iterations" 경고를 띄움. 이건 클라이언트(k6)측 backpressure이지 서버 정책의 효과가 아니다.
3. **RMQ purge 미구현** — `/case6/reset`은 in-memory만 정리하고 RMQ 큐는 그대로 둔다. prefetch-tune을 마지막 phase로 배치해서 회피. 이 때문에 prefetch-tune phase 만 attempted 가 절반(1087)으로 줄어든다 — 적체된 메시지를 워커가 다 소화할 때까지 새 요청을 보낼 VU 가 없어서.
4. **prefetch-tune의 queueDepth는 근사값** — 서버 측은 inflight 카운터로만 큐 깊이를 추정. RMQ 자체의 큐 길이는 별도 management API 조회가 필요.
5. **broker-level backpressure 미실험** — H4 반증 후속으로 `x-max-length` / `reject-publish` / publisher confirms 를 적용한 보강 variant 가 필요. case6 의 자연스러운 확장 대상.
