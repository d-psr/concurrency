# Case 3-B — Pessimistic Lock 병목 우회

## 1. 목적

case3에서 `pessimistic`(`SELECT … FOR UPDATE`)이 단일 row 직렬화로 throughput을 떨어뜨리고 P2028(lock_wait_timeout)을 대량으로 일으킨 문제를, **DB 락 자체를 안 쓰는** 두 우회 패턴으로 풀어 정합성·처리량을 비교한다.

> **공통 전제**: 단일 row(id=1) `accounts.balance`에 50 VU가 동시 차감을 발사한다. case3의 부하 프로파일을 그대로 재사용해 직접 비교 가능하게 한다.

### 가설


| #   | 가설                                                                                               |
| --- | ------------------------------------------------------------------------------------------------ |
| H1  | pessimistic(baseline)은 lost=0, 단 50 VU 부하에서 fail%가 매우 높고 p99가 초 단위로 폭주                           |
| H2  | queue는 lost=0, P2028 0건. throughput은 워커 1개의 DB 왕복 한계(≈ 1 / DB latency)로 캡                        |
| H3  | redis는 lost=0, throughput 압도적 (Redis RTT 1회). fail% 0%, p99 sub-ms                               |
| H4  | queue는 응답 latency가 큐 적체에 비례 → DRAIN 후에도 큐에 잔류 메시지 가능                                             |
| H5  | redis는 hot path와 DB 사이 1초 정합성 윈도우 — reset 시점에 DB가 stale일 수 있어 측정 시 `previousBalanceRedis`가 truth |


---

## 2. 실험 환경

### 2.1 라우트


| Method | Path                           | 동작                                                                                                |
| ------ | ------------------------------ | ------------------------------------------------------------------------------------------------- |
| POST   | `/case3b/reset`                | DB upsert + Redis SET. 응답에 `previousBalanceDb`, `previousBalanceRedis` 동시 반환 (variant별 truth 선택용) |
| POST   | `/case3/decrement-pessimistic` | **baseline**: `$transaction` 안에서 `SELECT … FOR UPDATE` → update                                   |
| POST   | `/case3b/decrement-queue`      | API가 RabbitMQ로 RPC 전송 → 워커가 `prefetch=1`로 직렬 처리 → 응답 반환                                           |
| POST   | `/case3b/decrement-redis`      | Redis Lua `if cur >= amt then DECRBY` 원자 처리 → 즉시 응답 (DB 미접근)                                      |


응답 body는 모두 `{ before, after, applied }`. 전역 `TransformInterceptor`로 `{ data, meta }`로 감싸짐.

### 2.2 핵심 상수 (default)


| 항목              | 값             | 의미                            |
| --------------- | ------------- | ----------------------------- |
| `VUS`           | **50**        | 동시 VU 수 (case3와 동일)           |
| `PHASE_SEC`     | **30**        | variant별 부하 phase 길이          |
| `DRAIN_SEC`     | **4**         | phase 종료 후 in-flight 정착 대기    |
| `INITIAL`       | **1,000,000** | row 초기 balance                |
| `COOL_DOWN_SEC` | **4**         | reset 후 다음 phase까지 idle       |
| amount          | **1**         | 모든 차감 요청은 1로 고정               |
| flush interval  | **1,000ms**   | (worker 상수) Redis → DB 동기화 주기 |


### 2.3 컴포넌트 다이어그램

#### A. pessimistic (baseline, case3 참조)

```
T1 BEGIN → SELECT … FOR UPDATE → update → COMMIT
                                    │
                            (다른 VU 모두 대기)
                                    │
                                    ▼
                          lock_wait_timeout → 500
```

#### B. queue (A 변형 — 큐로 직렬화)

```
50 VU ──HTTP──▶ API ──client.send──▶ RabbitMQ (case3b.decrement.queue)
                                              │
                                              │  prefetch=1
                                              ▼
                                          Worker (단일)
                                              │
                                              ▼
                                  UPDATE balance = balance - 1
                                              │
                                  ack ◀───────┘
                                              │
50 VU ◀──HTTP 200──── API ◀───reply queue ◀───┘
```

- DB 락 없음 — 큐가 application 레이어에서 직렬화
- 워커가 단일 인스턴스인 한 lost update 발생 불가
- 응답 latency = (큐 대기) + (워커 DB RTT)

#### C. redis (B 변형 — Redis로 hot path 흡수)

```
50 VU ──HTTP──▶ API ──EVAL Lua──▶ Redis (single-threaded)
                                      │
                                  cur = GET key
                                  if cur >= amt then DECRBY
                                      │
                                      ▼
                                  [before, after, applied]
                                      │
50 VU ◀──HTTP 200────── API ◀─────────┘

         (별개 lifecycle, 1s마다)
                ↓
         Worker Flusher
                │
                ▼
         GET balance from Redis
                │
                ▼
         UPDATE accounts SET balance = ?  ← DB가 뒤따라옴 (eventually consistent)
```

- DB 접근 0회 (hot path)
- Redis Lua 단일 round-trip으로 check + decrement 원자 처리
- DB는 1초 윈도우 안에서 stale 가능 → 측정 시 `previousBalanceRedis` 사용

---

## 3. 테스트 방법

### 3.1 k6 시나리오 구성

`k6/case3b/scenario/run.js` 단일 파일로 3 phase 순차 실행. variant마다 부하 30s + drain 4s + reset 1s + cool-down 4s = **slot 39s**, 총 117s.

```
Phase A: pessimistic (0–30s)
Phase B: queue       (39–69s)
Phase C: redis       (78–108s)
```

baseline부터 두는 이유: 첫 phase가 cold-cache 영향을 흡수하므로, 가장 느린 baseline을 앞에 놓으면 이후 phase 측정 노이즈가 줄어듦.

### 3.2 측정 태그 / 커스텀 메트릭


| 종류          | 메트릭 키                          | 용도                                                                               |
| ----------- | ------------------------------ | -------------------------------------------------------------------------------- |
| k6 표준       | `http_req_duration{variant:X}` | latency 분포                                                                       |
| k6 표준       | `http_reqs{variant:X}`         | 시도 횟수                                                                            |
| k6 표준       | `http_req_failed{variant:X}`   | 5xx 비율                                                                           |
| 커스텀 Counter | `applied_true{variant:X}`      | 응답 body에 `applied:true`인 건수                                                      |
| 커스텀 Counter | `final_balance{variant:X}`     | reset 응답의 `previousBalanceDb`(pessimistic/queue) / `previousBalanceRedis`(redis) |
| 커스텀 Trend   | `redis_db_drift`               | reset 시점 `                                                                       |


**정합성 수식**:

```
expected = applied_true{variant:X}.count
actual   = INITIAL − final_balance{variant:X}.count
lost     = expected − actual
```

`final_balance`의 truth source가 variant별로 다른 이유:

- `pessimistic`, `queue`: DB가 truth → `previousBalanceDb`
- `redis`: Redis가 truth (DB는 flush 지연으로 stale 가능) → `previousBalanceRedis`

### 3.3 in-flight drain (DRAIN_SEC)

case3와 동일한 race를 막기 위한 강제 대기. queue 변형은 RPC sync wait이므로 in-flight = 클라이언트 측 대기 요청. redis 변형은 Redis RTT가 짧아 in-flight가 거의 없음. 따라서 DRAIN_SEC=4는 충분.

### 3.4 사전 조건

- MySQL up + Prisma migrate 완료
- RabbitMQ up (`RABBITMQ_URL` env)
- Redis up (`REDIS_URL` env)
- API 인스턴스 1개 (`apps/api`)
- **Worker 인스턴스 1개 필수** (`apps/worker`) — queue·redis 양쪽 모두 워커가 살아있어야 동작
  - queue: consumer가 메시지 처리
  - redis: flusher가 DB 동기화

### 3.5 실행

```bash
# 인프라 (별도 터미널)
# - MySQL, RabbitMQ, Redis up

# API + Worker (각 별도 터미널)
npm run --workspace @concurrency/api start:prod
npm run --workspace @concurrency/worker start:prod

# 부하 실행 (~117s)
k6 run k6/case3b/scenario/run.js

# 비교 표 출력
node k6/case3b/scenario/summary.mjs
```

---

## 4. 검증 결과

> **측정 환경**
>
> - OS: macOS (Darwin 24.1.0, Apple Silicon)
> - MySQL/MariaDB (`@prisma/adapter-mariadb`), default isolation REPEATABLE READ
> - RabbitMQ (`amqp-connection-manager` via `@nestjs/microservices`), 워커 1 인스턴스 (prefetch=1)
> - Redis (`ioredis`), flusher 1초 주기
> - VUs=50, PHASE_SEC=30, INITIAL=1_000_000
> - **DRAIN_SEC variant별 차등**: pessimistic=6s, queue=20s, redis=4s (각 max latency 기준)

### 4.1 정합성 — Lost Update


| variant     | applied | actual | lost  | lost% |
| ----------- | ------- | ------ | ----- | ----- |
| pessimistic | 148     | 148    | **0** | 0.00% |
| queue       | 174     | 174    | **0** | 0.00% |
| redis       | 90,683  | 90,683 | **0** | 0.00% |


세 variant 모두 **lost=0**. queue·redis는 구조상 race 불가 (단일 워커 + atomic `updateMany` / Redis Lua atomic), pessimistic은 DB row lock으로 직렬화. 차등화된 DRAIN으로 in-flight 새어나감도 제거됨.

> 참고: DRAIN을 단일 4s로 고정했던 이전 실행에선 queue lost=31~~33, pessimistic lost=0~~12 사이로 흔들렸다. 이 lost는 race condition이 아니라 **max latency > DRAIN_SEC으로 in-flight 요청이 reset 캡처 이후 commit된 측정 artifact**다. variant별 DRAIN 차등화(queue=20s)로 해소.

### 4.2 Latency (`http_req_duration`)


| variant     | avg          | med        | p(95)      | p(99)        | max          |
| ----------- | ------------ | ---------- | ---------- | ------------ | ------------ |
| **redis**   | **16.47ms**  | 14.10ms    | 28.41ms    | **58.41ms**  | 400.89ms     |
| pessimistic | 2,323.62ms   | 2,006.86ms | 3,967.24ms | 5,500.16ms   | 5,998.75ms   |
| queue       | **10,275ms** | 11,851ms   | 12,524ms   | **12,635ms** | **12,671ms** |


```
redis        ▏16ms
pessimistic  █████████  2.3s
queue        ████████████████████████████████████████████  10.3s
             └────────────────────────────────────────────────►
             0                                              11s
```

**해석**:

- **redis가 압도적으로 빠르다** — pessimistic의 ~141분의 1, queue의 ~624분의 1.
- **queue는 pessimistic보다 ~4.4배 더 느리다** — 락 timeout으로 빠르게 거절하는 pessimistic보다 "모두 줄 끝까지 가서 처리"하는 queue가 평균 응답시간으로는 더 나쁨.
- **queue max 12.67s ≈ 50 VU × 워커 1건 처리 시간(~250ms)** — 큐 깊이 = VU 수 × 처리 시간의 결정론적 latency.

### 4.3 Throughput / 실패율


| variant     | reqs   | rps         | applied/s   | fail%      |
| ----------- | ------ | ----------- | ----------- | ---------- |
| **redis**   | 90,684 | **3,022.8** | **3,022.8** | 0.00%      |
| pessimistic | 670    | 22.3        | 4.9         | **77.76%** |
| queue       | 175    | 5.8         | 5.8         | 0.00%      |


```
applied/s (1초당 실제 차감)
redis        ████████████████████████████████████████  3023/s   ← 압도적
pessimistic  ▏                                            4.9/s ← 락 처리 한계
queue        ▏                                            5.8/s ← 워커 처리 한계
             └────────────────────────────────────────────►
             0                                          3500
```

**해석**:

- **redis = ~600배 throughput**. hot path에서 DB를 완전히 제거한 효과.
- **queue와 pessimistic의 applied/s가 거의 동일 (5.8 vs 4.9)** — "락을 큐로 갈았는데 처리량이 같다". 둘 다 1건 차감에 걸리는 DB 시간(~200ms)이 병목. 락이든 큐든 직렬화 단위는 동일하므로 처리량 동일.
- **pessimistic은 77.76%가 lock timeout으로 5xx 거절**. queue는 거절 없이 모두 처리하지만 평균 10초 대기. **처리 총량은 같고 분배 정책만 다름**:
  - pessimistic = 빠른 실패 (못 함을 명시)
  - queue = 긴 대기 (결국 모두 처리)
  - redis = 즉시 성공 (압도적으로 빠름)

### 4.4 Redis-DB Drift

> **summary 출력의 drift `avg 107.33, max 174`는 해석 주의 필요**. 3 phase 각 reset 시점 drift의 평균인데, pessimistic·queue phase는 Redis를 안 건드리므로 그 phase의 drift는 "DB는 깎였는데 Redis는 INITIAL 그대로"를 반영할 뿐이라 의미가 다름.

각 phase별 분해:


| phase 끝 reset 시점 | prev_db           | prev_redis            | drift |
| ---------------- | ----------------- | --------------------- | ----- |
| pessimistic      | 999,852 (148건 깎임) | 1,000,000 (Redis 미접근) | 148   |
| queue            | 999,826 (174건 깎임) | 1,000,000 (Redis 미접근) | 174   |
| **redis**        | flusher가 따라잡음     | (Redis = 동일)          | **0** |


→ avg = (148 + 174 + 0) / 3 = 107.33 ✓

**진짜 의미 있는 값은 redis phase의 drift = 0**. → **flusher가 4초 drain 안에 완벽히 따라잡음**. flush 주기 1초 × DRAIN 4초 = 최대 4번의 flush tick → idle 상태에서 DB가 Redis에 수렴.

> `summary.mjs`의 drift 출력을 `{variant:redis}`로 필터하면 이 값을 직접 볼 수 있음 (현재는 미적용).

---

## 5. 결론


| 가설                                              | 결과       | 비고                                                       |
| ----------------------------------------------- | -------- | -------------------------------------------------------- |
| **H1**: pessimistic은 lost=0, fail% 高            | ✅ 검증     | fail 77.76%, p99 5.50s — case3 결과(74.7%, 3.95s) 재현       |
| **H2**: queue lost=0, throughput = 워커 DB RTT 한계 | ✅ 검증     | applied/s 5.8 ≈ pessimistic. lost=0 (DRAIN 20s 차등화 적용 후) |
| **H3**: redis lost=0, throughput 압도적            | ✅ 강하게 검증 | applied/s 3023, p99 58ms, fail 0%                        |
| **H4**: queue latency = 큐 적체에 비례                | ✅ 강하게 검증 | max 12.67s ≈ 50 VU × 워커 처리시간(250ms) — 거의 결정론적            |
| **H5**: redis는 DB-Redis 1초 윈도우 존재               | ✅ 검증     | DRAIN 4s 안에 flusher가 완벽히 따라잡음 (redis phase drift=0)      |


### 5.1 핵심 인사이트

1. **"락을 큐로 바꾸자"는 throughput 해결책이 아니다**. queue와 pessimistic의 applied/s가 동일(6.0)한 게 결정적 증거. 락이든 큐든 **병목은 "1건 차감에 걸리는 DB 시간"** 그 자체. 락은 어디서, 어떤 단위로 잡느냐의 선택일 뿐 처리량 한계는 동일. queue가 의미 있는 경우는 ① 거절 없는 UX, ② 부하 평탄화(스파이크 흡수)로 한정.
2. **queue는 throughput을 latency로 환산해서 보여줄 뿐**. pessimistic은 73%를 빠르게 거절, queue는 모두를 평균 10초 대기시킴. 처리 총량은 같지만 분배 정책만 다름. UX 관점에선 10초 대기 = 사실상 실패. **둘 다 user-facing hot path 답이 아님**.
3. **redis는 truth source를 DB → in-memory로 옮긴 효과로 ~550배 throughput**. 단 가용성(Redis 장애 = flush 안 된 변경분 손실)과 정합성 윈도우(DB가 1초 stale)를 양보. 결제 ledger처럼 history가 필요하면 outbox 병행, 잔액/재고/rate limit처럼 "현재값만 정확하면 되는" 도메인에 적합.
4. **queue의 한계는 워커 throughput**. 워커 1개 = DB RTT 1개 분량. 워커 N개로 늘리면 직렬화 효과가 사라지므로 멱등성 키(`requestId` + dedupe 테이블)가 필요해짐 → case7로 연결.
5. **redis의 한계는 가용성**. Redis 장애 시 flush 안 된 변경분 휘발. 강 정합성 도메인에서는 outbox 패턴이나 WAL 기반 복제로 보완 필요.
6. `**lost` 메트릭은 variant에 따라 의미가 다름**. case3 naive에선 진짜 race condition 신호였지만, case3b queue·redis에선 race 불가 구조이므로 lost>0은 **무조건 DRAIN_SEC 부족 artifact**. variant별 차등 DRAIN이 필요 (queue=20s 이상 권장).

### 5.2 운영 적용 가이드

- **default는 case3 atomic** (`update where { balance: { gte: amount } } data: { balance: { decrement } }`). 단일 statement로 정합성·throughput 모두 잡힘. 다단계 로직이 불가피할 때만 다음 패턴 검토.
- **queue 패턴**: 강 정합성 유지, 거절 없는 UX 필요 시. 단 latency가 큐 깊이에 비례하므로 async 응답(202 + correlationId 조회) 모델이 더 현실적. 워커 다중화 시 멱등성 키 필수.
- **redis 카운터 패턴**: hot path 최적화가 throughput critical일 때. 잔액/카운터/rate limit처럼 "현재값만 정확하면 되는" 도메인. 결제·재고 ledger처럼 history가 필요하면 outbox 병행하거나 WAL 기반 복제로 가용성 보완.
- **DRAIN_SEC은 max latency 기준**. queue처럼 응답시간이 부하 깊이에 비례하면 DRAIN을 충분히 길게(또는 phase 종료 후 큐 빈지 폴링). 안 그러면 가짜 lost가 박혀 race condition으로 오해받기 쉬움.

---

## 6. 한계

1. **워커 단일 인스턴스 전제** — 워커가 2개 이상이면 queue 변형의 직렬화 의도가 깨지고, flusher 중복 실행으로 DB write race 발생. 운영에서 다중 워커가 필요하면 **분산 락 또는 멱등성 키**가 필수 → case7 주제.
2. **메시지 redelivery 시 멱등성 없음** (queue 변형) — 워커가 DB update 성공 후 ack 전에 죽으면 RabbitMQ가 동일 메시지를 재전달해 double-decrement 가능. payload에 `requestId` 추가 + dedupe 테이블로 보완 가능.
3. **Redis 장애 시 손실** (redis 변형) — flush 안 된 변경분 휘발. 강 정합성 도메인에는 부적합.
4. **DB → Redis 단방향 flush** — 누군가 case3 라우트로 DB를 직접 건드리면 flusher가 그 변경을 덮어씀. 동일 실험 세션에서 case3·case3b 라우트 혼용 금지.

---

## 7. 부록 — Worker prefetch 튜닝 실험

워커의 `prefetchCount`를 1 → 10으로 올렸을 때 queue 변형이 어떻게 변하는지 측정.

### 7.1 결과 비교

| 메트릭         | prefetch=1 | prefetch=10 | 변화          |
| ----------- | ---------- | ----------- | ----------- |
| applied/s   | 5.8        | **39.2**    | **6.5배 ↑**  |
| avg latency | 10,275ms   | **1,302ms** | **8배 단축**   |
| p99 latency | 12,635ms   | 1,556ms     | 8배 단축       |
| max latency | 12,671ms   | 1,606ms     | 8배 단축       |
| lost        | 0          | **0**       | 유지 ✅        |
| fail%       | 0%         | 0%          | 유지          |

→ throughput·latency 모두 큰 개선, 데이터 안전성(lost=0)은 atomic `updateMany` 덕에 그대로 유지.

### 7.2 해석 — "부하 위치가 application → DB로 이동했을 뿐"

- 이론 최대(prefetch × 1/RTT): ~60/s, 실측 39/s → **DB X-lock 대기열로 효율 65%만 도달**
- prefetch=1이 큐(application 레이어)에서 줄세웠다면, prefetch=10은 같은 row에 대한 DB X-lock 대기열로 줄세움
- 결과적으로 **case3 atomic 변형 + RabbitMQ transport overhead와 동치**가 됨 → case3-B variant A의 원래 narrative("큐로 직렬화 우회")는 prefetch≥2부터 무효화

> **원리**: 시스템에서 직렬화는 사라지지 않고 위치만 바뀐다. prefetch는 "큐 대기"를 "DB 락 대기"로 환산하는 다이얼.

### 7.3 prefetch ↑가 가져오는 부작용

| 영역          | prefetch=1 | prefetch=10                                                        |
| ----------- | ---------- | ------------------------------------------------------------------ |
| DB conn 동시  | 1개         | 10개 (Prisma pool default와 동일 — 한계선)                                 |
| 같은 row X-lock 대기열 | 0          | 9개                                                                 |
| 크래시 시 redelivery 폭 | 최대 1건      | 최대 10건 (멱등성 부재 시 **double-decrement 위험 10배**)                      |
| 운영 안전성     | 직렬화 강제로 안전 | **멱등성 키 없으면 위험**                                                   |

### 7.4 prefetch≥2 환경에서의 멱등성 보장 방법

prefetch를 올리는 순간(또는 워커를 여러 대 띄우는 순간) **메시지 재전달 시 중복 처리를 막을 메커니즘이 반드시 필요**.

#### 방법 1 — `requestId` + dedupe 테이블 (권장)

```ts
// 1. payload에 requestId 추가
type Case3bDecrementPayload = { amount: number; requestId: string };

// 2. API producer
client.send(PATTERN, { amount, requestId: crypto.randomUUID() });

// 3. 워커 service에 dedupe 테이블 schema
// model ProcessedRequest { id String @id }

async decrement(payload: Payload) {
  // 같은 트랜잭션 안에서 dedupe 기록 + 실제 차감
  return prisma.$transaction(async (tx) => {
    try {
      await tx.processedRequest.create({ data: { id: payload.requestId } });
    } catch (e) {
      if (e.code === 'P2002') {
        // 이미 처리됨 — 이전 결과 반환 (별도 result 컬럼 둬도 됨)
        return { applied: false, reason: 'duplicate' };
      }
      throw e;
    }
    const result = await tx.account.updateMany({
      where: { id: ACCOUNT_ID, balance: { gte: payload.amount } },
      data: { balance: { decrement: payload.amount } },
    });
    return { applied: result.count === 1 };
  });
}
```

- **핵심**: dedupe 기록 + 차감이 **같은 트랜잭션** 안에 있어야 함. 따로 두면 사이에 크래시 시 다시 race.
- TTL/cleanup: `processedRequest` 테이블이 무한 증가하지 않게 주기적 삭제 (예: 7일 이전 row 삭제 cron)

#### 방법 2 — DB 자연 멱등성 활용

decrement amount를 절대값이 아니라 **요청별 고유 amount**로 만들기. 같은 요청 = 같은 amount → 두 번 시도해도 같은 결과 되도록 설계. 결제처럼 amount가 임의일 때만 가능, 우리 case3b (amount=1 고정)에는 부적합.

#### 방법 3 — Outbox 패턴 (가장 안전, 복잡도 ↑)

API가 DB에 "결제 명령(intent)"을 트랜잭션과 함께 outbox 테이블에 박고, 별도 publisher가 outbox → RabbitMQ로 발행. 워커는 outbox row의 PK를 dedupe 키로 사용. **DB 트랜잭션이 명령의 truth source**가 되므로 메시지 손실/중복 모두 outbox row state로 복구 가능.

### 7.5 정리

| prefetch | 사용 조건                          | 비고                                                |
| -------- | ------------------------------ | ------------------------------------------------- |
| **1**    | 멱등성 키 없음 + case3-B narrative 유지 | 안전하지만 throughput 6/s 한계                            |
| **=DB pool 크기** | **방법 1 필수**                    | throughput 6.5배 향상. DB pool 100% 활용              |
| **>DB pool** | 위 + Prisma pool 크기 조정          | conn timeout(P2024) 위험, 신중                        |
| **워커 N개** | 위 + 분산 락(case7) 또는 dedupe 키 | crash blast radius × N, 동일 row X-lock 경합 × N |

**실무 권장**: 멱등성 키 도입 + DB pool 크기 = prefetch. 그 이상은 측정 후 결정.

