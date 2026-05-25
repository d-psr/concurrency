# concurrency

싱글 / 멀티 Node.js 환경에서 마주칠 수 있는 동시성·자원 경합 문제를 k6 부하 테스트로 재현하고, 그 해결책을 *측정값으로* 비교한다. 

각 케이스는 `**apps/api`(라우트)** + `**k6/caseN/scenario`(부하)** + `**k6/caseN/README.md`(가설·결과 분석)** 한 세트로 구성된다.

```
apps/
  api/        ── 모든 케이스의 HTTP 엔드포인트 (NestJS)
  worker/     ── case3b / case6 의 RabbitMQ 컨슈머
packages/
  database/   ── Prisma + MariaDB 공유 모듈
  redis/      ── ioredis DynamicModule
  shared/     ── DTO·인터셉터·전역 유틸
  logger/     ── 공용 로거
k6/
  caseN/      ── 케이스별 시나리오·결과·README
```

---

## 케이스 개요


| 주제                                                                          | 한 줄 요약                                                                                      |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [**libuv Thread Pool Contention**](./k6/case1/README.md)                    | `bcrypt` 가 worker 4개를 점유하면 같은 풀을 쓰는 `fs.readFile` 가 같이 굶는다. `p-limit < pool` 로 io 전용 슬롯 확보. |
| [**Event Loop / Main Thread Blocking**](./k6/case2/README.md)               | `bcrypt.hashSync` 는 메인 스레드를 멈춰 *무관한 라우트까지* 죽인다. libuv / worker_threads 위임으로 격리.             |
| [**Single-row DB Contention**](./k6/case3/README.md)                        | RMW race 의 lost update 와 4가지 정합성 메커니즘(naive / atomic / pessimistic / optimistic) 비교.        |
| [**Externalizing the Consistency Medium**](./k6/case3b/README.md)           | 큐(RabbitMQ prefetch=1) · Redis Lua 카운터로 정합성을 어디서 잡을 것인가.                                    |
| [**DB Connection Pool Contention**](./k6/case4/README.md)                   | case1 의 HOL blocking 이 OS thread → DB connection 으로 그대로 옮겨오는지 확인. `p-limit` 같은 처방.          |
| [**Cache Stampede**](./k6/case5/README.md)                                  | TTL 만료 순간 동시 미스가 풀을 포화시키는 현상. singleflight / redis-lock / xfetch 로 coalescing.              |
| [**Backpressure Policies**](./k6/case6/README.md)                           | 도착률 > 처리량일 때 unbounded / drop-oldest / reject-429 / broker-prefetch 의 trade-off.            |
| [**Distributed Lock (Multi-instance)**](./k6/case7/README.md)               | 인프로세스 락이 스케일아웃과 함께 깨지는 모습. Redis SETNX / Redlock(Lua) / DB row lock 비교.                     |


---

## 케이스별 라우트 / 결과

### case1 — libuv thread pool 경합


| 라우트                         | 동작                                             |
| --------------------------- | ---------------------------------------------- |
| `POST /case1/without-limit` | `bcrypt.hash(pw, 12)` 직접 호출                    |
| `POST /case1/with-limit`    | `pLimit(3)` 게이팅 후 `bcrypt.hash`                |
| `GET /case1/io`             | `fs.readFile(tmp.bin, 5MB)` — 같은 libuv pool 사용 |


**결과**: io p99 **6062ms → 30.88ms (≈ 200×)**. bcrypt avg 는 +16% 비용. `limit < pool` 이 worker 1개를 io 전용으로 *구조적으로* 보장.

---

### case2 — Event loop / main thread blocking


| 라우트                       | CPU 실행 위치            |
| ------------------------- | -------------------- |
| `POST /case2/sync-hash`   | 메인 스레드 (`hashSync`)  |
| `POST /case2/async-hash`  | libuv 풀              |
| `POST /case2/worker-hash` | Piscina 워커 풀         |
| `GET /case2/health`       | 빈 응답 (메인 스레드 부하 측정용) |


**결과**: sync 페이즈에서 `/health` p99 **35초** (사실상 timeout). async / worker 페이즈에서는 각각 **11.45ms / 4.64ms**. 메인 스레드 정지 = 서버 전체 정지.

---

### case3 — DB 단일 row 동시 갱신


| 라우트                                 | 메커니즘                                                  |
| ----------------------------------- | ----------------------------------------------------- |
| `POST /case3/decrement-naive`       | `SELECT → JS 계산 → UPDATE` (race 의도)                   |
| `POST /case3/decrement-atomic`      | `UPDATE ... balance = balance - 1 WHERE balance >= 1` |
| `POST /case3/decrement-pessimistic` | `SELECT ... FOR UPDATE` + `UPDATE`                    |
| `POST /case3/decrement-optimistic`  | version 컬럼 CAS + retry(≤10)                           |


**결과** (50 VU / 30s, INITIAL=1,000,000):


| variant     | applied/s   | lost              | fail           |
| ----------- | ----------- | ----------------- | -------------- |
| atomic      | **33.0**    | 0                 | 0%             |
| pessimistic | 5.7         | 0                 | 74.7%          |
| naive       | 14.2 (응답기준) | **415건 (97.19%)** | 0% (거짓 성공)     |
| optimistic  | 1.7         | 0                 | 67.7% (CAS 충돌) |


→ **단일 statement(atomic) 가 거의 항상 정답**. naive 의 "거짓 성공" 이 가장 위험.

---

### case3b — 정합성 매체 외부화 (큐 / Redis)


| 라우트                            | 매체                                                     |
| ------------------------------ | ------------------------------------------------------ |
| `POST /case3b/decrement-queue` | RabbitMQ RPC + 단일 워커(`prefetch=1`) 직렬 처리               |
| `POST /case3b/decrement-redis` | Redis Lua `if cur ≥ amt then DECRBY` + 1s flusher → DB |


**결과**:


| variant     | applied/s | lost | fail % | 비고                        |
| ----------- | --------- | ---- | ------ | ------------------------- |
| pessimistic | ~6        | 0    | 77.76% | case3 재현                  |
| queue       | ~6        | 0    | ~0     | latency max 12.67s (큐 적체) |
| **redis**   | **3023**  | 0    | 0      | DB hot path 제거 = ~550×    |


→ "락을 큐로 바꾸기" 는 throughput 해결책이 아님. **진짜 처리량은 truth source 를 in-memory 로 옮길 때만 나온다**.

---

### case4 — DB connection pool 경합


| 라우트                               | 동작                      |
| --------------------------------- | ----------------------- |
| `POST /case4/heavy-without-limit` | `SELECT SLEEP(0.3)` 직접  |
| `POST /case4/heavy-with-limit`    | `pLimit(3)` 게이팅 후 동일 쿼리 |
| `GET /case4/probe`                | `SELECT 1` (1ms급)       |


**결과**: probe p99 **2266ms → 134ms (≈ 30×)**. case1 의 HOL blocking 메커니즘이 OS thread → DB connection 으로 완전히 동일하게 작동.

---

### case5 — Cache stampede


| 라우트                                   | 정책                                  |
| ------------------------------------- | ----------------------------------- |
| `GET /case5/product-naive/:id`        | TTL Map, 미스 시 전원 backend 직행         |
| `GET /case5/product-singleflight/:id` | in-process inFlight Promise 합류      |
| `GET /case5/product-redis-lock/:id`   | `SET NX PX` + 20ms poll             |
| `GET /case5/product-xfetch/:id`       | probabilistic early refresh (백그라운드) |
| `GET /case5/probe`                    | 공유 풀 포화 가시화용 `SELECT 1`             |


**결과** (100 VU / 30s, TTL=5s):


| variant      | DB 호출         | probe p99 | throughput      |
| ------------ | ------------- | --------- | --------------- |
| naive        | 다수            | **6.5s**  | 2,526 req/s     |
| singleflight | 6 (burst당 1)  | 정상        | **4,697 req/s** |
| redis-lock   | 6             | 정상        | 3,969 req/s     |
| xfetch       | 1 (reader 경로) | 정상        | 4,094 req/s     |


→ "캐시 적중률 99.6%" 라도 0.4% 미스가 *언제 모이는지* 가 본질. p99 만 보는 모니터링은 stampede 를 놓친다.

---

### case6 — Backpressure 정책


| 라우트                                        | 정책                            |
| ------------------------------------------ | ----------------------------- |
| `POST /case6/enqueue?policy=unbounded`     | 큐 제한 없음 (baseline)            |
| `POST /case6/enqueue?policy=drop-oldest`   | 가득 차면 맨 앞 victim drop         |
| `POST /case6/enqueue?policy=reject-429`    | 입구에서 HTTP 429 거절              |
| `POST /case6/enqueue?policy=prefetch-tune` | RabbitMQ + `prefetchCount=1`  |
| `GET /case6/stats`                         | queueDepth · wait p95 · RSS 등 |


**결과** (도착 50/s · 처리 10/s):

- **unbounded**: queue depth · latency · RSS 모두 우상향 → 실제 운영에선 OOM 행 직행
- **drop-oldest**: latency 캡, 단 작업 손실. 최신값 중요한 도메인 적합
- **reject-429**: RSS 최저, 클라가 재시도 가능 / 명시적 거부 UX
- **prefetch-tune**: 브로커가 자연 backpressure. 손실·거부 불가한 도메인

→ "정답" 이 없는 **trade-off 데이터셋**. 비즈니스 요구(손실/거부 허용 여부) 와 매칭해 선택.

---

### case7 — 분산 락 (멀티 인스턴스)

API 를 2개 띄우고(`:3000`, `:3001`) k6 가 round-robin.


| 라우트                                  | 매체                                        |
| ------------------------------------ | ----------------------------------------- |
| `POST /case7/inproc-mutex/decrement` | per-instance `p-limit(1)` (의도적 분산 무방비)    |
| `POST /case7/redis-setnx/decrement`  | `SET NX PX` + naive `DEL` release         |
| `POST /case7/redlock/decrement`      | `SET NX PX` + UUID token + Lua CAS-delete |
| `POST /case7/db-row-lock/decrement`  | `$transaction` + `SELECT ... FOR UPDATE`  |


**결과** (20 VU / 30s, 2 인스턴스):


| variant      | applied/s | lost (%)   | fail % |
| ------------ | --------- | ---------- | ------ |
| inproc-mutex | 빠름        | **49.32%** | 0%     |
| redis-setnx  | 3.4       | 0          | 49.0%  |
| redlock      | 3.4       | 0          | 47.5%  |
| db-row-lock  | **6.3**   | 0          | 0%     |


→ **수평 확장 = 락 매체 외부화 필수**. 단일 노드 환경에서는 redlock(Lua release) 가 setnx 와 비용 동일하면서 안전성 우월. 락 대상이 DB row 면 db-row-lock 이 인프라 비용 0 으로 가장 빠름.

---

