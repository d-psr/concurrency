import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@concurrency/database';
import { RedisService } from '@concurrency/redis';
import { CASE5_PRISMA, type Case5Prisma } from './case5.prisma';

export const CASE5_TTL_SEC = 5;
export const CASE5_DB_DELAY_MS = 200;
export const CASE5_SEED_PRODUCT_ID = 1;
export const CASE5_REDIS_LOCK_TTL_MS = 500;
export const CASE5_REDIS_POLL_MS = 20;
export const CASE5_XFETCH_BETA = 1.0;

export type ProductSource = 'cache' | 'db' | 'stale';

export interface ProductResult {
  id: number;
  name: string;
  price: number;
  version: number;
  fetchedAt: number;
  source: ProductSource;
}

interface InProcEntry {
  value: ProductResult;
  expiresAt: number;
}

interface XfetchEntry {
  value: ProductResult;
  delta: number;
  expiresAt: number;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

@Injectable()
export class Case5Service {
  private readonly logger = new Logger(Case5Service.name);
  private readonly naiveCache = new Map<number, InProcEntry>();
  private readonly singleCache = new Map<number, InProcEntry>();
  private readonly singleInFlight = new Map<number, Promise<ProductResult>>();

  constructor(
    @Inject(CASE5_PRISMA) private readonly prisma: Case5Prisma,
    private readonly redis: RedisService,
  ) {}

  async reset(): Promise<{ ok: true; id: number }> {
    await this.prisma.product.upsert({
      where: { id: CASE5_SEED_PRODUCT_ID },
      create: {
        id: CASE5_SEED_PRODUCT_ID,
        name: `product-${CASE5_SEED_PRODUCT_ID}`,
        price: 1000,
        version: 0,
      },
      update: { price: 1000, version: { increment: 1 } },
    });

    this.naiveCache.clear();
    this.singleCache.clear();
    this.singleInFlight.clear();

    await this.redis.del(
      this.redisLockCacheKey(CASE5_SEED_PRODUCT_ID),
      this.redisLockKey(CASE5_SEED_PRODUCT_ID),
      this.xfetchCacheKey(CASE5_SEED_PRODUCT_ID),
      this.xfetchLockKey(CASE5_SEED_PRODUCT_ID),
    );

    return { ok: true, id: CASE5_SEED_PRODUCT_ID };
  }

  async getNaive(id: number): Promise<ProductResult> {
    const now = Date.now();
    const entry = this.naiveCache.get(id);
    if (entry && entry.expiresAt > now) {
      return { ...entry.value, source: 'cache' };
    }
    const fresh = await this.fetchFromBackend(id);
    this.naiveCache.set(id, {
      value: fresh,
      expiresAt: Date.now() + CASE5_TTL_SEC * 1000,
    });
    return fresh;
  }

  getSingleflight(id: number): Promise<ProductResult> {
    const now = Date.now();
    const entry = this.singleCache.get(id);
    if (entry && entry.expiresAt > now) {
      return Promise.resolve({ ...entry.value, source: 'cache' });
    }

    const existing = this.singleInFlight.get(id);
    if (existing) {
      return existing.then((value) => ({ ...value, source: 'cache' }));
    }

    const promise = this.fetchFromBackend(id)
      .then((fresh) => {
        this.singleCache.set(id, {
          value: fresh,
          expiresAt: Date.now() + CASE5_TTL_SEC * 1000,
        });
        return fresh;
      })
      .finally(() => {
        this.singleInFlight.delete(id);
      });

    this.singleInFlight.set(id, promise);
    return promise;
  }

  async getRedisLock(id: number): Promise<ProductResult> {
    const cacheKey = this.redisLockCacheKey(id);
    const lockKey = this.redisLockKey(id);

    const cached = await this.redis.get(cacheKey);
    if (cached) {
      return { ...(JSON.parse(cached) as ProductResult), source: 'cache' };
    }

    const acquired = await this.redis.set(
      lockKey,
      '1',
      'PX',
      CASE5_REDIS_LOCK_TTL_MS,
      'NX',
    );
    if (acquired === 'OK') {
      try {
        const fresh = await this.fetchFromBackend(id);
        await this.redis.set(
          cacheKey,
          JSON.stringify(fresh),
          'EX',
          CASE5_TTL_SEC,
        );
        return fresh;
      } finally {
        await this.redis.del(lockKey);
      }
    }

    const deadline = Date.now() + CASE5_REDIS_LOCK_TTL_MS + 200;
    while (Date.now() < deadline) {
      await sleep(CASE5_REDIS_POLL_MS);
      const polled = await this.redis.get(cacheKey);
      if (polled) {
        return { ...(JSON.parse(polled) as ProductResult), source: 'cache' };
      }
    }

    // lock holder stalled past TTL — degrade to direct fetch
    const fallback = await this.fetchFromBackend(id);
    return { ...fallback, source: 'stale' };
  }

  async getXfetch(id: number): Promise<ProductResult> {
    const cacheKey = this.xfetchCacheKey(id);
    const cached = await this.redis.get(cacheKey);
    const now = Date.now();

    if (cached) {
      const entry = JSON.parse(cached) as XfetchEntry;
      const xfetchTime =
        now - entry.delta * CASE5_XFETCH_BETA * Math.log(Math.random());
      const shouldRefresh = xfetchTime >= entry.expiresAt;

      if (shouldRefresh) {
        const acquired = await this.redis.set(
          this.xfetchLockKey(id),
          '1',
          'PX',
          CASE5_REDIS_LOCK_TTL_MS,
          'NX',
        );
        if (acquired === 'OK') {
          void this.refreshXfetch(id).catch((err) => {
            this.logger.error(`xfetch refresh failed: ${String(err)}`);
          });
        }
      }

      return {
        ...entry.value,
        source: now >= entry.expiresAt ? 'stale' : 'cache',
      };
    }

    // cold cache — coordinate via lock to avoid thundering herd on first hit
    const lockKey = this.xfetchLockKey(id);
    const acquired = await this.redis.set(
      lockKey,
      '1',
      'PX',
      CASE5_REDIS_LOCK_TTL_MS,
      'NX',
    );
    if (acquired === 'OK') {
      return this.refreshXfetch(id);
    }

    const deadline = Date.now() + CASE5_REDIS_LOCK_TTL_MS + 200;
    while (Date.now() < deadline) {
      await sleep(CASE5_REDIS_POLL_MS);
      const polled = await this.redis.get(cacheKey);
      if (polled) {
        const entry = JSON.parse(polled) as XfetchEntry;
        return { ...entry.value, source: 'cache' };
      }
    }

    const fallback = await this.fetchFromBackend(id);
    return { ...fallback, source: 'stale' };
  }

  private async refreshXfetch(id: number): Promise<ProductResult> {
    const cacheKey = this.xfetchCacheKey(id);
    const lockKey = this.xfetchLockKey(id);
    const start = Date.now();
    try {
      const fresh = await this.fetchFromBackend(id);
      const delta = Date.now() - start;
      const expiresAt = Date.now() + CASE5_TTL_SEC * 1000;
      const entry: XfetchEntry = { value: fresh, delta, expiresAt };
      await this.redis.set(
        cacheKey,
        JSON.stringify(entry),
        'PX',
        CASE5_TTL_SEC * 2 * 1000,
      );
      return fresh;
    } finally {
      await this.redis.del(lockKey);
    }
  }

  private async fetchFromBackend(id: number): Promise<ProductResult> {
    const seconds = CASE5_DB_DELAY_MS / 1000;
    await this.prisma.$queryRaw(Prisma.sql`SELECT SLEEP(${seconds})`);
    const row = await this.prisma.product.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundException(`product ${id} not found`);
    }
    return {
      id: Number(row.id),
      name: row.name,
      price: row.price,
      version: row.version,
      fetchedAt: Date.now(),
      source: 'db',
    };
  }

  private redisLockCacheKey(id: number): string {
    return `case5:redis-lock:${id}`;
  }

  private redisLockKey(id: number): string {
    return `case5:redis-lock:lock:${id}`;
  }

  private xfetchCacheKey(id: number): string {
    return `case5:xfetch:${id}`;
  }

  private xfetchLockKey(id: number): string {
    return `case5:xfetch:lock:${id}`;
  }
}
