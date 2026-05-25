# Case 7 — 분산 락 vs 인프로세스 락

## 1. 목적

case1·case3·case4에서 효과적이었던 `p-limit` 같은 **프로세스 로컬 직렬화**가, API 인스턴스를 2개 이상 띄우는 순간 어떻게 **무력화**되는지 재현한다. 그 위에서 분산 락(Redis SETNX, single-node Redlock)·DB row lock 의 정합성·throughput·overhead를 비교한다.

> **사전 지식**: in-process 직렬화는 *단일 프로세스 가정* 위에서만 성립한다. 수평 확장은 락 매체의 외부화를 강제한다.
>
> **case3 와의 차이**: case3 는 "어떤 DB 연산을 쓸 것인가"를 단일 인스턴스 안에서 비교. case7 은 "락 매체를 어디서 가져올 것인가"를 멀티 인스턴스 차원에서 비교. case3 의 정합성 메커니즘을 *수평 확장 축*으로 확장한 자리다.

### 가설

| #  | 가설 |
| -- | ---- |
| H1 | `inproc-mutex` 는 인스턴스 1대일 때만 안전. 2대로 분산하면 case3 naive 와 동급의 **lost update** 가 발생한다. |
| H2 | `redis-setnx` 는 정상 케이스 lost=0, 단 release 가 naive `DEL` (소유권 검증 X) 이라 TTL 만료·stall 시 "남의 락 삭제" corner case 가 존재한다. |
| H3 | `redlock` 은 더 안전하나 overhead 큼 (RTT × N) → throughput 은 setnx 보다 낮다. ※ 본 실험은 **단일 노드 + Lua compare-and-delete** 만 구현해 H3 의 전제(다중 노드 quorum)는 부분적으로만 검증 가능. |
| H4 | `db-row-lock`(pessimistic) 은 외부 락 인프라 없이 안전, throughput 한계는 case3 pessimistic 과 동일 — "락은 어디서 가져오느냐의 문제". |

---

## 2. 실험 환경

### 2.1 라우트 — 라우트 분리 방식 (variant 쿼리스트링 ✗)

| Method | Path                                   | 동작 |
| ------ | -------------------------------------- | ---- |
| POST   | `/case7/reset`                         | 공유 row(id=1) 를 INITIAL 로 초기화 + 락 키 삭제. 응답에 직전 `previousBalance` 포함 |
| POST   | `/case7/inproc-mutex/decrement`        | per-instance `p-limit(1)` 안에서 naive RMW (다른 인스턴스와는 무방비) |
| POST   | `/case7/redis-setnx/decrement`         | `SET NX PX` 락 + naive `DEL` release |
| POST   | `/case7/redlock/decrement`             | `SET NX PX` 락 + UUID token + **Lua compare-and-delete** release (단일 노드) |
| POST   | `/case7/db-row-lock/decrement`         | `$transaction` 안에서 `SELECT … FOR UPDATE` → `update` |

응답 body: `{ before, after, applied, lockWaitMs, instance, variant }`. 인스턴스 ID 는 `INSTANCE_ID` env 로 주입한 값을 그대로 echo (k6 에서 분포 검증용).

### 2.2 핵심 상수 (default)

| 항목                    | 값       | 의미 |
| ----------------------- | -------- | ---- |
| `LOCK_KEY`              | `case7:lock:account:1` | 모든 변형이 공유하는 단일 락 키 |
| `LOCK_TTL_MS`           | **1000** | Redis 락 TTL (acquire 시 PX) |
| `LOCK_WAIT_TIMEOUT_MS`  | **5000** | 락 획득 대기 한도. 초과 시 503 ServiceUnavailable |
| `LOCK_POLL_MS`          | **20**   | Redis 락 polling 간격 |
| `REDLOCK_RELEASE_SCRIPT`| Lua      | `if GET == token then DEL else 0 end` — 소유권 검증 release |

### 2.3 멀티 인스턴스 셋업

```
                 ┌─────────────────┐
                 │   k6 (round-robin) │
                 └────────┬────────┘
                          │
              ┌───────────┴───────────┐
              ▼                       ▼
        ┌──────────┐            ┌──────────┐
        │ api-1    │            │ api-2    │
        │ :3000    │            │ :3001    │
        │ p-limit(1)│            │ p-limit(1)│
        └────┬─────┘            └─────┬────┘
             │                        │
             └────────┬───────────────┘
                      │
            ┌─────────┴──────────┐
            ▼                    ▼
       Redis (락 매체)        MySQL (공유 row id=1)
```

**round-robin 방식**: k6 가 `(vuId + iteration) % URLS.length` 로 URL 선택. nginx 같은 별도 LB 없이 클라가 직접 분배. 응답의 `instance` 필드로 분포 검증.

### 2.4 변형별 다이어그램

#### A. inproc-mutex (의도적 분산 무방비)

```
api-1 p-limit(1)        api-2 p-limit(1)
       │                       │
       SELECT balance         SELECT balance
       │   ↑ 둘 다 같은 값       │
       UPDATE balance-1       UPDATE balance-1   ← 한쪽 차감 증발 (lost update)
       │                       │
       200 applied:true       200 applied:true   ← 둘 다 "성공"
```

#### B. redis-setnx (naive release)

```
api-1                          api-2
  │ SET case7:lock NX PX=1s     │
  │   ← OK                      │
  │ (critical section)          │ SET ... NX → null, polling 20ms
  │   ▼ 만약 1s 초과 ...        │
  │   TTL 만료, 다른 인스턴스가  │   ← OK, 진입
  │   락 가져감                  │ (critical section)
  │ DEL case7:lock               │
  │   └─ 남의 락 삭제             │
  │                              │ DEL case7:lock (이미 사라짐)
```

#### C. redlock (단일 노드 + Lua compare-and-delete)

```
api-1                          api-2
  │ token = uuid()              │
  │ SET case7:lock <token> NX   │
  │   ← OK                      │
  │ (critical section)          │ ...
  │                              │
  │ EVAL: if GET == <token>     │
  │       then DEL else 0       │
  │   → 만료됐다면 DEL X         │   (소유권 검증으로 "남의 락 삭제" 차단)
```

#### D. db-row-lock (외부 락 매체 없음)

```
api-1                          api-2
  │ BEGIN                       │
  │ SELECT ... FOR UPDATE       │ BEGIN
  │   ← X-lock 획득              │ SELECT ... FOR UPDATE  ← T1 commit까지 대기
  │ UPDATE                       │
  │ COMMIT (lock 해제)           │
  │                              │   ← lock 획득
  │                              │ UPDATE / COMMIT
```

---

## 3. 테스트 방법

### 3.1 부하 프로파일

각 variant 마다 `constant-vus` 단일 phase:

```
load (30s, VUS=20)
  └── drain (12s) ── reset ── cool-down (4s)
```

총 4 phase × 47s ≈ **3분 8초**.

**DRAIN_SEC=12s 인 이유**: `LOCK_WAIT_TIMEOUT_MS=5s` 보다 충분히 커야 적체분이 다음 phase 의 reset 측정 구간으로 새지 않는다. (초기 4s 로 돌렸을 때 redis-setnx 의 lost 가 음수로 잡히는 cross-talk 발생을 확인하고 늘림.)

**VUS=20 인 이유**: 50 으로 돌리면 락 매체 capacity 를 압도해 fail% 가 70%대까지 치솟고, 적체로 인한 phase cross-talk 가 측정을 오염시킨다. 20 이면 inproc-mutex 의 lost update 는 유지되면서 다른 변형의 fail% 도 정상 범위.

### 3.2 측정 메트릭

| 종류             | 메트릭 키                                       | 용도 |
| ---------------- | --------------------------------------------- | ---- |
| k6 표준          | `http_req_duration{variant:X}`                | 클라이언트 응답시간 |
| k6 표준          | `http_reqs{variant:X}`                        | 시도된 요청 수 |
| k6 표준          | `http_req_failed{variant:X}`                  | 비-2xx 응답 비율 (= 락 wait timeout 503) |
| 커스텀 Counter   | `applied_true{variant:X}`                     | 응답 `applied: true` 개수 |
| 커스텀 Counter   | `final_balance{variant:X}`                    | reset 시 `previousBalance` (lost 계산 근거) |
| 커스텀 Counter   | `instance_hits{variant:X,instance:Y}`         | 인스턴스 분포 검증 |
| 커스텀 Trend     | `lock_wait_ms{variant:X}`                     | 서버 응답의 `lockWaitMs` (락 획득 대기) |

`lost = applied - actual`, `actual = INITIAL - finalBalance`.

### 3.3 사전 조건

- MySQL up (case3 와 동일 스키마 `accounts` 재사용)
- Redis up
- API **2 인스턴스** 동시 기동 — `INSTANCE_ID` 와 `PORT` 만 다르게

### 3.4 실행

```bash
# 인스턴스 1
PORT=3000 INSTANCE_ID=api-1 npm run --workspace @concurrency/api start:prod

# 인스턴스 2 (별도 터미널)
PORT=3001 INSTANCE_ID=api-2 npm run --workspace @concurrency/api start:prod

# k6 실행 (기본값으로 round-robin)
k6 run k6/case7/scenario/run.js

# 환경변수 override
BASE_URLS=http://localhost:3000,http://localhost:3001 \
INSTANCES=api-1,api-2 \
VUS=20 DRAIN_SEC=12 \
k6 run k6/case7/scenario/run.js

# 비교 표 출력
node k6/case7/scenario/summary.mjs
```

---

## 4. 측정 결과

> **측정 환경**
>
> - OS: macOS (Darwin 24.1.0, Apple Silicon)
> - API 2 인스턴스 (`start:prod`), `INSTANCE_ID=api-1` / `api-2`, 각각 :3000 / :3001
> - MySQL + Redis 각 1 인스턴스
> - k6: `constant-vus` VUS=20, PHASE=30s, DRAIN=12s, COOL=4s, INITIAL=1,000,000
> - amount=1 고정

### 4.1 정합성 — `lost = applied - actual`

| variant       | applied | actual | lost | lost%  |
| ------------- | ------: | -----: | ---: | -----: |
| inproc-mutex  |     219 |    111 |  108 | **49.32%** |
| redis-setnx   |     102 |    102 |    0 |  0.00% |
| redlock       |     103 |    103 |    0 |  0.00% |
| db-row-lock   |     188 |    188 |    0 |  0.00% |

**핵심 발견**: `inproc-mutex` 가 정확히 절반의 차감을 소실. 인스턴스 분배가 49.6 / 50.4 로 균등하므로 충돌 확률이 최대 — 거의 모든 요청이 다른 인스턴스의 RMW 와 겹친다. 분산 락 3종은 모두 lost=0.

### 4.2 응답시간 — `http_req_duration`

| variant       |     avg |     med |   p(95) |   p(99) |     max |
| ------------- | ------: | ------: | ------: | ------: | ------: |
| inproc-mutex  | 2881 ms | 2951 ms | 3356 ms | 3771 ms | 3936 ms |
| redis-setnx   | 3064 ms | 5004 ms | 5055 ms | 5230 ms | 5286 ms |
| redlock       | 3170 ms | 5005 ms | 5055 ms | 5183 ms | 5235 ms |
| db-row-lock   | 3360 ms | 3483 ms | 3995 ms | 4437 ms | 4451 ms |

**setnx / redlock 의 bimodal 분포 주목** — med 5s 는 즉시 timeout 으로 떨어진 49% 가 분포 중앙으로 끌어당긴 결과. 성공한 요청만 보면 (`{expected_response:true}` 기준 med=2.98s, p95=4.33s) 다른 variant 와 유사.

### 4.3 락 대기 — `lock_wait_ms` (서버 보고)

| variant       |     avg |    med |   p(95) |   p(99) |     max |
| ------------- | ------: | -----: | ------: | ------: | ------: |
| inproc-mutex  | 2581 ms | 2651 ms | 3035 ms | 3112 ms | 3602 ms |
| redis-setnx   |  864 ms |    2 ms | 4392 ms | 4988 ms | 4994 ms |
| redlock       | 1185 ms |    2 ms | 4836 ms | 4920 ms | 4925 ms |
| db-row-lock   | 3195 ms | 3297 ms | 3796 ms | 4229 ms | 4269 ms |

- **setnx / redlock med=2ms** — 락을 즉시 획득한 경로의 latency. 두 매체의 정상 비용은 거의 0.
- **p99 ≈ 5s** — `LOCK_WAIT_TIMEOUT_MS` 직전까지 polling 한 케이스. 분포가 명확히 bimodal.
- **inproc-mutex** 는 p-limit 큐가 FIFO 로 평탄 → med 2.6s, p99 3.1s 에 분포 모임.
- **db-row-lock** 은 트랜잭션 진입 + FOR UPDATE 대기가 합산 → med 3.3s.

### 4.4 처리량 & 실패율

| variant       | reqs | rps  | applied/s |  fail% |
| ------------- | ---: | ---: | --------: | -----: |
| inproc-mutex  |  220 |  7.3 |       7.3 |  0.00% |
| redis-setnx   |  202 |  6.7 |       3.4 | 49.01% |
| redlock       |  198 |  6.6 |       3.4 | 47.47% |
| db-row-lock   |  189 |  6.3 |       6.3 |  0.00% |

- **db-row-lock 이 분산 락 3종 중 throughput 1위 (6.3/s)** — Redis 1홉 RTT × 2(acquire+release) 비용이 MySQL InnoDB X-lock 한 트랜잭션보다 크다는 직관적 결과. case3 pessimistic 의 결론과 일관.
- **redis-setnx ≈ redlock 완전 동일 (3.4/s)** — 단일 노드 + Lua compare-and-delete 의 추가 overhead 는 측정 불가 수준. **소유권 검증을 거의 공짜로 얻은 것**.
- **inproc-mutex 의 fail=0%** — 락 매체가 아예 없어 timeout 자체가 발생 불가. throughput 도 높지만 그 throughput 의 절반이 lost update.

### 4.5 인스턴스 분배 — round-robin 정상성 검증

| variant       | api-1 | api-2 |
| ------------- | ----: | ----: |
| inproc-mutex  | 109 (49.8%) | 110 (50.2%) |
| redis-setnx   |  51 (50.0%) |  51 (50.0%) |
| redlock       |  53 (51.5%) |  50 (48.5%) |
| db-row-lock   |  93 (49.5%) |  95 (50.5%) |

모든 variant 에서 49–51% 균등. round-robin 정상. **가설 검증의 전제 조건 충족** — inproc-mutex 의 lost update 는 인스턴스 동시성에서 온 것이지 한쪽 인스턴스 편중이 아니다.

### 4.6 가설 검증 매트릭스

| #  | 가설 | 결과 | 비고 |
| -- | ---- | ---- | ---- |
| H1 | inproc-mutex 는 멀티 인스턴스에서 lost update | ✅ 검증 | lost 49.32%, 거의 모든 요청 충돌 |
| H2 | redis-setnx 는 정상 케이스 lost=0 | ✅ 검증 | lost=0. corner case 는 본 실험에서 미발현 (별도 chaos 필요) |
| H3 | redlock overhead > setnx → throughput 낮음 | ⚠️ **부분 반증** | 단일 노드에서는 차이 0. 다중 노드 quorum 미구현 |
| H4 | db-row-lock 안전 + throughput 한계 = case3 pessimistic | ✅ 검증 | lost=0, fail=0, throughput 6.3/s |

---

## 5. 락 매체 선택 — 안전성·throughput·운영 복잡도의 3축

| 매체            | 안전성 | throughput | 인프라 비용 | 운영 복잡도 | 적합한 상황 |
| --------------- | :----: | :--------: | :---------: | :---------: | ---- |
| **inproc-mutex** |  ✗     | 빠름        | 0           | 낮음         | **인스턴스 1대 보장** (스케일아웃 안 함) 이 확실할 때만 |
| **redis-setnx (naive DEL)** | △ corner case | 중간 | Redis 1개 | 낮음 | 정상 케이스만 보장하면 되는 가벼운 상황. **권장 X** — redlock 패턴이 거의 같은 비용 |
| **redlock (single-node + Lua)** | ○ | 중간 | Redis 1개 | 낮음 | **단일 노드 환경의 기본 선택지**. setnx 와 비용 동일, 안전성 우월 |
| **redlock (multi-node quorum)** | ◎ | 낮음(RTT×N) | Redis 3~5대 | 높음 | clock skew·split-brain 우려가 큰 미션 크리티컬 |
| **db-row-lock**  | ◎     | 낮음        | 0 (DB 기존) | 낮음        | DB 가 이미 있고, 락 대상이 DB row 그 자체일 때. 별도 매체 없이 한 곳에서 정합성 처리 |

### 매칭 예

- **단일 row 의 잔액 차감** → `db-row-lock` (락 매체와 데이터가 같은 곳에 있으면 추가 인프라 0)
- **분산 자원의 단일 진입자 보장** (cron job leader election 등) → `redlock` (단일 노드 + Lua release)
- **DB 부하 분산을 위해 락은 Redis 에 둬야 함** → `redlock`
- **`inproc-mutex` 는 운영 선택지가 아니라 실패 baseline** — "스케일아웃하면 깨진다" 시각화 용도

### 한 줄 요약

> **수평 확장 = 락 매체 외부화. 매체 선택은 인프라 비용 vs 안전성 vs throughput 의 3축 trade-off.**

---

## 6. 한계

1. **chaos 시나리오 미구현** — todo.md 에 명시된 "락 보유 인스턴스 kill" 은 H2 의 corner case(setnx 의 남의 락 삭제)와 redlock 의 복구 거동 차이를 드러내는 핵심이지만 본 측정에는 포함하지 않았다. 정상 케이스만 측정해서 H2·H3 의 실패 모드는 *재현하지 않았다*.
2. **multi-node Redlock 미구현** — 단일 노드 + Lua release 만 측정. H3 의 원 가설(RTT × N overhead)은 다중 노드 구성이 필요. 현재 데이터로는 "단일 노드에서는 redlock = setnx 비용" 까지만 말할 수 있다.
3. **VU 20 의 의미** — 락 매체 capacity 가 fail% 를 결정하는 핵심 변수. VU 를 늘리면 setnx/redlock 의 fail% 가 70%대로 치솟고 phase cross-talk 가 측정을 오염시킨다. 다른 VU 값에서의 곡선은 별도 실험 필요.
4. **k6 round-robin 의 한계** — 진짜 운영 LB(nginx, gateway)는 connection affinity·health check 등의 영향이 있다. 본 실험은 분배의 *균등성* 만 검증.
5. **`db-row-lock` 의 fail=0% 는 InnoDB 락 timeout 에 의존** — 서버 코드의 `LOCK_WAIT_TIMEOUT_MS=5s` polling 로직을 안 거치고 `innodb_lock_wait_timeout`(기본 50s)에 위임. 5s 보다 오래 기다려도 죽지 않지만 응답시간 분포가 더 길어진다. 다른 변형과 직접 비교 시 이 차이를 고려할 것.
