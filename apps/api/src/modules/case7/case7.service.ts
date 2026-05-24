import {
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import pLimit from 'p-limit';
import { PrismaService } from '@concurrency/database';
import { RedisService } from '@concurrency/redis';
import type { Env } from '../../common/config/env.validation';

const ACCOUNT_ID = 1n;
const LOCK_KEY = 'case7:lock:account:1';
const LOCK_TTL_MS = 1000;
const LOCK_WAIT_TIMEOUT_MS = 5000;
const LOCK_POLL_MS = 20;

// safe release — only DEL if we still own the lock (token matches)
const REDLOCK_RELEASE_SCRIPT = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;

export type Variant =
  | 'inproc-mutex'
  | 'redis-setnx'
  | 'redlock'
  | 'db-row-lock';

export interface DecrementResult {
  before: number;
  after: number;
  applied: boolean;
  lockWaitMs: number;
  instance: string;
  variant: Variant;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

@Injectable()
export class Case7Service {
  private readonly inprocLimit = pLimit(1);
  private readonly instanceId: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    config: ConfigService<Env, true>,
  ) {
    this.instanceId =
      config.get('INSTANCE_ID', { infer: true }) ?? `pid-${process.pid}`;
  }

  async reset(initial: number) {
    const prev = await this.prisma.account.findUnique({
      where: { id: ACCOUNT_ID },
    });
    await this.prisma.account.upsert({
      where: { id: ACCOUNT_ID },
      create: { id: ACCOUNT_ID, balance: initial, version: 0 },
      update: { balance: initial, version: 0 },
    });
    await this.redis.del(LOCK_KEY);
    return {
      id: ACCOUNT_ID.toString(),
      balance: initial,
      version: 0,
      previousBalance: prev?.balance ?? null,
      instance: this.instanceId,
    };
  }

  // in-process mutex: per-instance p-limit(1).
  // 한 인스턴스 내부에서는 직렬화되지만, 인스턴스 N개는 각자 자기 limit만 들고 있어
  // critical section이 겹친다 → lost update 재현.
  async decrementInprocMutex(amount: number): Promise<DecrementResult> {
    const start = Date.now();
    return this.inprocLimit(async () => {
      const lockWaitMs = Date.now() - start;
      return this.applyDecrementNaive(amount, lockWaitMs, 'inproc-mutex');
    });
  }

  // redis SETNX: 분산 락이지만 release가 naive (소유권 검증 없는 DEL).
  // 정상 케이스에선 lost=0. 단 임계영역이 TTL을 넘기면 다른 인스턴스가 락을 가져가고,
  // 원 소유자가 finally에서 DEL → "남의 락 삭제" corner case 발생.
  async decrementRedisSetnx(amount: number): Promise<DecrementResult> {
    const start = Date.now();
    await this.acquireSetnx(start);
    const lockWaitMs = Date.now() - start;
    try {
      return await this.applyDecrementNaive(amount, lockWaitMs, 'redis-setnx');
    } finally {
      await this.redis.del(LOCK_KEY);
    }
  }

  // redlock-style (단일 노드): SET NX PX + 토큰 + Lua compare-and-delete.
  // 소유권 검증 release로 setnx의 corner case 차단.
  // 단일 노드라 multi-master quorum은 생략 — 안전 release 패턴만 차용.
  async decrementRedlock(amount: number): Promise<DecrementResult> {
    const start = Date.now();
    const token = randomUUID();
    await this.acquireRedlock(start, token);
    const lockWaitMs = Date.now() - start;
    try {
      return await this.applyDecrementNaive(amount, lockWaitMs, 'redlock');
    } finally {
      await this.redis.eval(REDLOCK_RELEASE_SCRIPT, 1, LOCK_KEY, token);
    }
  }

  // db row lock: 외부 락 매체 없이 SELECT ... FOR UPDATE.
  // 정합성은 DB가 보장. throughput 한계는 case3 pessimistic과 동일.
  async decrementDbRowLock(amount: number): Promise<DecrementResult> {
    const start = Date.now();
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: bigint; balance: number }[]>`
        SELECT id, balance FROM accounts WHERE id = ${ACCOUNT_ID} FOR UPDATE
      `;
      const lockWaitMs = Date.now() - start;
      const row = rows[0];
      if (!row) throw new NotFoundException('account not initialized');
      if (row.balance < amount) {
        return this.result(
          row.balance,
          row.balance,
          false,
          lockWaitMs,
          'db-row-lock',
        );
      }
      const updated = await tx.account.update({
        where: { id: ACCOUNT_ID },
        data: { balance: row.balance - amount },
      });
      return this.result(
        row.balance,
        updated.balance,
        true,
        lockWaitMs,
        'db-row-lock',
      );
    });
  }

  private async acquireSetnx(start: number): Promise<void> {
    while (true) {
      const ok = await this.redis.set(LOCK_KEY, '1', 'PX', LOCK_TTL_MS, 'NX');
      if (ok === 'OK') return;
      if (Date.now() - start > LOCK_WAIT_TIMEOUT_MS) {
        throw new ServiceUnavailableException(
          'redis-setnx lock wait timed out',
        );
      }
      await sleep(LOCK_POLL_MS);
    }
  }

  private async acquireRedlock(start: number, token: string): Promise<void> {
    while (true) {
      const ok = await this.redis.set(LOCK_KEY, token, 'PX', LOCK_TTL_MS, 'NX');
      if (ok === 'OK') return;
      if (Date.now() - start > LOCK_WAIT_TIMEOUT_MS) {
        throw new ServiceUnavailableException('redlock lock wait timed out');
      }
      await sleep(LOCK_POLL_MS);
    }
  }

  // intentionally naive read-modify-write so the inproc-mutex variant
  // can demonstrate lost-update across instances.
  private async applyDecrementNaive(
    amount: number,
    lockWaitMs: number,
    variant: Variant,
  ): Promise<DecrementResult> {
    const row = await this.prisma.account.findUnique({
      where: { id: ACCOUNT_ID },
    });
    if (!row) throw new NotFoundException('account not initialized');
    if (row.balance < amount) {
      return this.result(row.balance, row.balance, false, lockWaitMs, variant);
    }
    const updated = await this.prisma.account.update({
      where: { id: ACCOUNT_ID },
      data: { balance: row.balance - amount },
    });
    return this.result(row.balance, updated.balance, true, lockWaitMs, variant);
  }

  private result(
    before: number,
    after: number,
    applied: boolean,
    lockWaitMs: number,
    variant: Variant,
  ): DecrementResult {
    return {
      before,
      after,
      applied,
      lockWaitMs,
      instance: this.instanceId,
      variant,
    };
  }
}
