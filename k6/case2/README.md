# Case 2 — DB Race Condition

## 1. 목적

동일 row에 대한 **read-modify-write(RMW)** 패턴이 동시 실행될 때 어떻게 **조용히 데이터가 사라지는지**를 재현하고, 네 가지 해결 전략의 **정합성 ↔ throughput ↔ latency** trade-off를 한 번의 k6 실행으로 비교한다.

> **Lost Update**: T1이 `SELECT balance(=100)` 후 JS에서 `99` 계산해 `UPDATE`로 쓰는 사이, T2도 동일한 `100`을 읽어 `99`를 쓰면 두 차감 중 하나가 사라진다. **서버는 두 번 모두 "성공" 응답을 보낸 채로 데이터만 사라진다**는 점이 본 문제의 본질이자 위험성.

> **사전 지식**: MySQL InnoDB의 기본 격리 수준 **REPEATABLE READ는 lost update를 막지 못한다**. 격리 수준은 "내가 본 snapshot이 일관되는가"를 다루지, "내가 쓴 값이 다른 쓰기에 덮이는가"는 다루지 않는다. 후자는 **락(`FOR UPDATE`) 또는 원자 update 문, 또는 version 기반 CAS** 같은 별도 메커니즘이 필요하다.

### 가설


| #   | 가설                                                                                   |
| --- | ------------------------------------------------------------------------------------ |
| H1  | naive(`findUnique` → JS 계산 → `update`)는 동시 부하에서 **대량의 lost update**가 발생한다.           |
| H2  | atomic(단일 SQL `UPDATE ... SET balance = balance - amount`)은 lost = 0, throughput 최고. |
| H3  | pessimistic(`SELECT ... FOR UPDATE` + update)은 lost = 0, 단 락 직렬화로 throughput 감소.     |
| H4  | optimistic(`version` CAS + retry)은 lost = 0, 단 고경합 시 retry 폭증 → latency·실패율 상승.      |


---

## 2. 실험 환경

### 2.1 라우트


| Method | Path                           | 동작                                                                                        |
| ------ | ------------------------------ | ----------------------------------------------------------------------------------------- |
| POST   | `/case2/reset`                 | 단일 row(id=1)를 INITIAL로 초기화. 응답에 직전 `previousBalance` 포함 → k6 측정에 사용                       |
| POST   | `/case2/decrement-naive`       | `findUnique` → JS에서 `balance - amount` 계산 → `update` (race window 의도적)                    |
| POST   | `/case2/decrement-atomic`      | `updateMany where { balance: { gte: amount } } data: { balance: { decrement } }` (단일 SQL) |
| POST   | `/case2/decrement-pessimistic` | `$transaction` 안에서 `SELECT … WHERE id = ? FOR UPDATE` → `update`                          |
| POST   | `/case2/decrement-optimistic`  | `findUnique` → `updateMany where { version }` CAS, 충돌 시 retry (최대 10회)                    |


모든 응답은 전역 `TransformInterceptor`가 `{ data, meta }`로 감싸며, decrement 응답 body는 `{ before, after, applied, attempts? }` 형태. naive의 `balance < amount` 분기는 200 + `applied: false`로 반환해 HTTP 에러와 비즈니스 분기를 분리한다.

### 2.2 핵심 상수 (default)


| 항목              | 값             | 의미                                                |
| --------------- | ------------- | ------------------------------------------------- |
| `VUS`           | **50**        | 동시 VU 수 (모두 단일 row id=1을 노림)                      |
| `PHASE_SEC`     | **30**        | variant별 부하 phase 길이                              |
| `DRAIN_SEC`     | **4**         | phase 종료 후 in-flight 요청이 commit될 시간               |
| `INITIAL`       | **1,000,000** | row 초기 balance — phase 내 절대 depletion되지 않을 만큼 큰 값 |
| `COOL_DOWN_SEC` | **4**         | reset 후 다음 phase까지 idle                           |
| amount          | **1**         | 모든 차감 요청은 1로 고정 (`expected = applied 카운트` 단순화)    |


### 2.3 컴포넌트 다이어그램

#### A. naive (race window 의도적)

```
T1: SELECT balance → 100        T2: SELECT balance → 100
        │                              │
   (JS: 100 - 1 = 99)             (JS: 100 - 1 = 99)
        │                              │
        ▼                              ▼
   UPDATE balance = 99            UPDATE balance = 99    ← 한쪽 차감 증발
        │                              │
       200 OK "applied:true"        200 OK "applied:true"  ← 둘 다 성공이라 응답
                                                          (lost update)
```

#### B. atomic (단일 statement)

```
T1: UPDATE balance = balance - 1 WHERE balance >= 1
                  ▲
                  └─ DB가 row X-lock 짧게 잡고 한 statement 내에서 read+write 원자 수행
T2: UPDATE balance = balance - 1 WHERE balance >= 1  ← T1 commit 후 진행
                  → 두 차감 모두 반영
```

#### C. pessimistic (`FOR UPDATE`)

```
T1 BEGIN
T1 SELECT … WHERE id = 1 FOR UPDATE  ← X-lock 획득
T1 (JS 계산)
T1 UPDATE balance = ?
T1 COMMIT                            ← lock 해제
        ────────────────────────────►
T2 SELECT … WHERE id = 1 FOR UPDATE  ← T1 commit까지 대기
                                       (innodb_lock_wait_timeout 안에 못 얻으면 500)
```

#### D. optimistic (CAS + retry)

```
T1: SELECT version=5, balance=100
T2: SELECT version=5, balance=100         ── 둘 다 같은 snapshot
T1: UPDATE ... WHERE version=5  → OK, version=6
T2: UPDATE ... WHERE version=5  → count=0 (T1이 먼저) → retry
T2: SELECT version=6, balance=99
T2: UPDATE ... WHERE version=6  → OK, version=7
```

> 10회 retry해도 매번 다른 VU에게 밀리면 `ConflictException` 500 반환.

---

## 3. 테스트 방법

### 3.1 k6 시나리오 구성

`k6/case2/scenario/run.js` 단일 파일로 4 phase를 순차 실행. variant마다 부하 30s + drain 4s + reset 1s + cool-down 4s = **slot 39s**, 총 156s.

```
Time:   0s ────────── 30s ── 34s ── 35s ── 39s ──────── 69s ──── 78s ──────── 117s ──── 156s
        ◄ naive ────►        reset cool-down                                            
                              ▲ phase 종료 후 4s 대기 → in-flight 정착 → reset이 final balance 캡처

Phase A: naive       (0–30s)
Phase B: atomic      (39–69s)
Phase C: pessimistic (78–108s)
Phase D: optimistic  (117–147s)
```

### 3.2 측정 태그 / 커스텀 메트릭


| 종류          | 메트릭 키                          | 용도                                                             |
| ----------- | ------------------------------ | -------------------------------------------------------------- |
| k6 표준       | `http_req_duration{variant:X}` | latency 분포                                                     |
| k6 표준       | `http_reqs{variant:X}`         | 시도 횟수                                                          |
| k6 표준       | `http_req_failed{variant:X}`   | 5xx 비율                                                         |
| 커스텀 Counter | `applied_true{variant:X}`      | 응답 body에 `applied:true`인 건수 → `expected_decrement`             |
| 커스텀 Counter | `final_balance{variant:X}`     | reset 시나리오가 `previousBalance`로 1회 add → 그 phase의 final balance |
| 커스텀 Trend   | `optimistic_attempts`          | optimistic 응답의 `attempts` 분포 → 경합 강도                           |


**정합성 수식**:

```
expected = applied_true{variant:X}.count
actual   = INITIAL − final_balance{variant:X}.count
lost     = expected − actual
```

### 3.3 in-flight drain (DRAIN_SEC)

phase load 종료 직후엔 아직 응답이 안 돌아온 in-flight 요청들이 남는다. 이들을 기다리지 않고 즉시 reset을 발사하면 reset이 캡처한 balance가 실제 final보다 큰 값이 되고, 늦게 commit된 차감분이 다음 phase로 새어나가 **가짜 lost update**로 잡힌다. `DRAIN_SEC`은 이 race를 막기 위한 강제 대기 시간이다.

### 3.4 실행

```bash
# API 부팅 (별도 터미널)
npm run --workspace @concurrency/api start:prod

# 부하 실행 (~156s)
k6 run k6/case2/scenario/run.js

# 비교 표 출력
node k6/case2/scenario/summary.mjs
```

---

## 4. 검증 결과

> **측정 환경**
>
> - OS: macOS (Darwin 24.1.0, Apple Silicon)
> - MySQL/MariaDB (`@prisma/adapter-mariadb`), default isolation REPEATABLE READ
> - VUs=50, PHASE_SEC=30, DRAIN_SEC=4, INITIAL=1_000_000

### 4.1 정합성 — Lost Update


| variant     | applied (=시도 성공) | actual (=INITIAL−final) | lost    | lost%      |
| ----------- | ---------------- | ----------------------- | ------- | ---------- |
| **naive**   | 427              | 12                      | **415** | **97.19%** |
| atomic      | 989              | 989                     | 0       | 0.00%      |
| pessimistic | 170              | 170                     | 0       | 0.00%      |
| optimistic  | 51               | 44                      | 7*      | 13.73%*    |


 optimistic의 lost=7은 측정 도구의 DRAIN 부족(`max latency 16.3s > DRAIN 4s`)으로 인한 in-flight leak. `DRAIN_SEC=20`으로 재실행하면 0이 됨. 진짜 race condition은 아님.

#### 시각화

```
naive       ████████████████████████████████████████  415 lost  (서버는 427번 "성공"이라 응답)
atomic      ▏                                            0 lost
pessimistic ▏                                            0 lost
optimistic  ▏                                            7 lost (측정 artifact)
            └────────────────────────────────────────────►
            0                                          500
```

**해석**: naive는 427번 차감 응답 중 **415번이 거짓말**이었다. 클라이언트는 결제 성공으로 받아들이지만 DB에는 그 차감이 반영되지 않은 상태 → 운영 도메인에서 가장 위험한 종류의 버그. 나머지 세 전략은 동일 부하에서 lost = 0.

### 4.2 Latency (`http_req_duration`)


| variant     | avg        | med     | p(95)   | p(99)       | max     |
| ----------- | ---------- | ------- | ------- | ----------- | ------- |
| **atomic**  | **1535ms** | 1393ms  | 2665ms  | **2738ms**  | 3041ms  |
| pessimistic | 2299ms     | 2004ms  | 3647ms  | 3952ms      | 4096ms  |
| naive       | 3720ms     | 3784ms  | 4697ms  | 4766ms      | 4845ms  |
| optimistic  | 10886ms    | 11961ms | 16026ms | **16229ms** | 16296ms |


```
atomic       █████████                                       1535ms avg
pessimistic  ██████████████                                  2299ms avg
naive        ███████████████████████                         3720ms avg
optimistic   ████████████████████████████████████████████   10886ms avg
             └────────────────────────────────────────────────────►
             0                                              11000ms
```

**해석**:

- **atomic이 압도적으로 빠르다** (avg 1.5s). 단일 statement라 round-trip이 최소.
- **pessimistic은 락 대기**로 atomic의 약 1.5배.
- **naive가 의외로 느린 이유**: 50 VU가 같은 row에 동시 `UPDATE`를 발사하면 InnoDB가 X-lock으로 자동 직렬화한다. `FOR UPDATE`를 안 썼을 뿐 update 자체가 row X-lock을 잡는다. 거기에 `findUnique`까지 별도 round-trip이 더해져서 누적 latency가 커진다.
- **optimistic은 retry 비용으로 한 자릿수 초**까지 늘어남. 평균 5.86회 시도 × 평균 single-attempt 시간.

### 4.3 Throughput / 실패율


| variant     | reqs (count) | rps      | applied/s | fail%      | avg attempts (optimistic) |
| ----------- | ------------ | -------- | --------- | ---------- | ------------------------- |
| **atomic**  | **990**      | **33.0** | **33.0**  | 0.00%      | —                         |
| pessimistic | 676          | 22.5     | 5.7       | **74.70%** | —                         |
| naive       | 428          | 14.3     | 14.2      | 0.00%      | —                         |
| optimistic  | 161          | 5.4      | 1.7       | **67.70%** | **5.86**                  |


```
applied/s (정확히 차감된 초당 건수)
atomic       █████████████████████████████████  33.0/s   ← 정확하고 빠름
naive        ██████████████  14.2/s                       ← "빠른 거짓말". 실제는 0.4/s가 진짜 반영
pessimistic  █████  5.7/s                                  ← 정확하지만 75% 거절
optimistic   █  1.7/s                                     ← 정확하지만 68% retry 실패
```

**해석**:

- **atomic은 정확성과 속도 양면에서 챔피언**. 0% fail, 0 lost, 33 rps. 다른 strategy를 시도할 이유가 거의 없음.
- **pessimistic은 솔직한 실패**: 676 요청 중 506(74.7%)이 `lock_wait_timeout`으로 500을 받음. 클라이언트가 명시적으로 알고 재시도할 수 있어 안전하지만 사용자 경험은 나쁘다.
- **optimistic은 50 VU 단일 row라는 극단적 경합에서 사실상 동작 불가**: 평균 5.86회 retry, 67.7%가 결국 ConflictException. 단일 hot row에는 부적합. 분산된 row 갱신에서 빛난다.
- **naive의 "높은 throughput"은 함정**: applied/s 14.2는 응답 기준이고, 실제 반영은 0.4/s에 불과(415 lost 빼면 12건). 측정 단위를 잘못 잡으면 가장 빠른 전략처럼 보일 수 있다.

---

## 5. 결론


| 가설                                           | 결과       | 비고                                          |
| -------------------------------------------- | -------- | ------------------------------------------- |
| **H1**: naive에서 lost update 대량 발생            | ✅ 강하게 검증 | 427 응답 중 415건 손실 (97.19%)                   |
| **H2**: atomic은 lost = 0, throughput 최고      | ✅ 검증     | lost 0, fail 0%, 33 rps                     |
| **H3**: pessimistic은 lost = 0, throughput 감소 | ✅ 검증     | lost 0, 단 50 VU 부하에서 fail 74.7%             |
| **H4**: optimistic은 lost = 0, 고경합 시 retry 폭증 | ✅ 검증     | applied 평균 5.86회 retry, 67.7% retry exhaust |


### 5.1 핵심 인사이트

1. **lost ≫ fail (위험도 측면)**. naive는 "성공했다"고 응답한 뒤 데이터가 사라진다. pessimistic·optimistic의 5xx는 클라이언트가 인지·재시도할 수 있지만, naive의 거짓 성공은 모니터링 지표(error rate, status code)로는 잡히지 않는다. 회계·결제·재고처럼 정확성이 critical한 도메인에서는 **lost = 0**이 절대 기준.
2. **단일 statement(atomic)가 거의 항상 정답**. `UPDATE ... SET col = col - ? WHERE id = ? AND col >= ?` 같은 DB 원자 연산은 락 비용 없이도 정합성을 보장한다. ORM이 제공하면(`{ decrement }`, raw query) 이걸 첫 선택지로.
3. **pessimistic의 비용은 throughput이 아니라 fail rate에 있다**. avg latency만 보면 atomic의 1.5배 정도지만, 실제로는 75%가 timeout으로 거절된다. "정확하긴 한데 처리 못 한 비율"이 huge.
4. **optimistic은 hot row의 적이다**. CAS는 경합이 적을 때만 retry 없이 1회로 끝난다. 단일 row에 50 VU가 몰리면 모든 시도가 충돌한다. 분산된 row 갱신(사용자별 wallet, 상품별 inventory)에서는 우수.
5. **MySQL 기본 격리(REPEATABLE READ)는 lost update를 막지 않는다**. 격리 수준 상승은 한 가지 부류의 phantom·dirty read를 막을 뿐, RMW race는 별도 메커니즘(원자 update / 락 / CAS)을 요구한다.

### 5.2 운영 적용 가이드

- **default는 atomic**: `update where { balance: { gte: amount } } data: { balance: { decrement } }` 또는 raw `UPDATE ... SET col = col - ?`.
- **read 결과로 분기 후 write 같은 다단계 로직이 필요할 때만 pessimistic**: `SELECT ... FOR UPDATE` + `update`. 단, lock_wait_timeout과 deadlock 모니터링 필수.
- **여러 row를 분산해 갱신하는 도메인에는 optimistic CAS**: 충돌 가능성이 낮으면 락 없는 retry가 가장 가볍다. 단일 hot row에는 쓰지 말 것.
- **naive(`SELECT → 계산 → UPDATE`)는 운영 코드에서 절대 금지**. ORM 사용 시 자기도 모르게 빠지기 쉬운 패턴이라 코드 리뷰·정적 분석 포인트로 가져갈 만하다.

---

## 6. 디렉토리 구조

```
k6/
├── lib/
│   └── build-summary.js              ← 공용 handleSummary 빌더 (case1과 공유)
└── case2/
    ├── README.md                     ← (이 문서)
    ├── scenario/
    │   ├── run.js                    ← k6 시나리오 (4 phase 단일 파일)
    │   └── summary.mjs               ← 정합성·latency·throughput 표 출력기
    └── result/
        ├── summary-<timestamp>.json  ← 매 실행 결과
        └── summary-latest.json       ← summary.mjs 기본 입력
```

## 7. 튜닝

```bash
# 기본
k6 run k6/case2/scenario/run.js

# DRAIN 늘려서 optimistic의 측정 artifact 제거
DRAIN_SEC=20 k6 run k6/case2/scenario/run.js

# 더 강한 부하
PHASE_SEC=60 VUS=100 k6 run k6/case2/scenario/run.js

# 과거 결과로 표만 재생성
INITIAL=1000000 PHASE_SEC=30 node k6/case2/scenario/summary.mjs \
  k6/case2/result/summary-<timestamp>.json
```


| env             | default                 | 의미                            |
| --------------- | ----------------------- | ----------------------------- |
| `BASE_URL`      | `http://localhost:3000` | API 주소                        |
| `PHASE_SEC`     | `30`                    | variant별 phase 길이(초)          |
| `VUS`           | `50`                    | 동시 VU 수                       |
| `INITIAL`       | `1000000`               | row 초기 balance                |
| `DRAIN_SEC`     | `4`                     | phase 종료 후 in-flight drain 시간 |
| `COOL_DOWN_SEC` | `4`                     | reset 후 idle 시간               |


