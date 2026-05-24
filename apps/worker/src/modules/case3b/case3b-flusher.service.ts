import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '@concurrency/database';
import { RedisService } from '@concurrency/redis';
import {
  CASE3B_REDIS_BALANCE_KEY,
  CASE3B_REDIS_FLUSH_INTERVAL_MS,
} from '@concurrency/shared';

const ACCOUNT_ID = 1n;

@Injectable()
export class Case3bFlusherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(Case3bFlusherService.name);
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private lastFlushedBalance: number | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => this.tick(), CASE3B_REDIS_FLUSH_INTERVAL_MS);
    this.logger.log(
      `🌀 case3b flusher started (interval=${CASE3B_REDIS_FLUSH_INTERVAL_MS}ms)`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const raw = await this.redis.get(CASE3B_REDIS_BALANCE_KEY);
      if (raw === null) return;
      const balance = Number(raw);
      if (!Number.isFinite(balance)) return;
      if (this.lastFlushedBalance === balance) return;

      await this.prisma.account.update({
        where: { id: ACCOUNT_ID },
        data: { balance },
      });
      this.lastFlushedBalance = balance;
    } catch (error) {
      this.logger.error('flush failed', error as Error);
    } finally {
      this.inFlight = false;
    }
  }
}
