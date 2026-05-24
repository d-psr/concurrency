import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from '@concurrency/database';
import { RedisService } from '@concurrency/redis';
import {
  CASE3B_CLIENT,
  CASE3B_DECREMENT_PATTERN,
  CASE3B_REDIS_BALANCE_KEY,
  CASE3B_REDIS_DECREMENT_LUA,
  type Case3bDecrementPayload,
  type Case3bDecrementResult,
} from '@concurrency/shared';

const ACCOUNT_ID = 1n;

@Injectable()
export class Case3bService {
  constructor(
    @Inject(CASE3B_CLIENT) private readonly client: ClientProxy,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async reset(initial: number) {
    const prevRow = await this.prisma.account.findUnique({
      where: { id: ACCOUNT_ID },
    });
    const prevRedisRaw = await this.redis.get(CASE3B_REDIS_BALANCE_KEY);
    const previousBalanceRedis =
      prevRedisRaw === null ? null : Number(prevRedisRaw);

    await this.prisma.account.upsert({
      where: { id: ACCOUNT_ID },
      create: { id: ACCOUNT_ID, balance: initial, version: 0 },
      update: { balance: initial, version: 0 },
    });
    await this.redis.set(CASE3B_REDIS_BALANCE_KEY, initial);

    return {
      id: ACCOUNT_ID.toString(),
      balance: initial,
      redisKey: CASE3B_REDIS_BALANCE_KEY,
      previousBalanceDb: prevRow?.balance ?? null,
      previousBalanceRedis,
    };
  }

  async decrementQueue(amount: number): Promise<Case3bDecrementResult> {
    const payload: Case3bDecrementPayload = { amount };
    return firstValueFrom(
      this.client.send<Case3bDecrementResult, Case3bDecrementPayload>(
        CASE3B_DECREMENT_PATTERN,
        payload,
      ),
    );
  }

  async decrementRedis(amount: number): Promise<Case3bDecrementResult> {
    const raw = (await this.redis.eval(
      CASE3B_REDIS_DECREMENT_LUA,
      1,
      CASE3B_REDIS_BALANCE_KEY,
      amount,
    )) as [number, number, number];

    const [before, after, applied] = raw;
    if (before === -1 && after === -1) {
      throw new NotFoundException(
        'redis balance not seeded; call /case3b/reset first',
      );
    }
    return { before, after, applied: applied === 1 };
  }
}
