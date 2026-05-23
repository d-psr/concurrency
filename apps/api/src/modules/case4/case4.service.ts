import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@concurrency/database';
import pLimit from 'p-limit';
import { CASE4_PRISMA, type Case4Prisma } from './case4.prisma';

const HEAVY_DURATION_SEC = 0.3;
const HEAVY_CONCURRENCY = 3;

@Injectable()
export class Case4Service {
  private readonly heavyLimit = pLimit(HEAVY_CONCURRENCY);

  constructor(@Inject(CASE4_PRISMA) private readonly prisma: Case4Prisma) {}

  async heavyWithoutLimit(): Promise<{ ok: true }> {
    await this.prisma.$queryRaw(
      Prisma.sql`SELECT SLEEP(${HEAVY_DURATION_SEC})`,
    );
    return { ok: true };
  }

  async heavyWithLimit(): Promise<{ ok: true }> {
    await this.heavyLimit(() =>
      this.prisma.$queryRaw(Prisma.sql`SELECT SLEEP(${HEAVY_DURATION_SEC})`),
    );
    return { ok: true };
  }

  async probe(): Promise<{ ok: true }> {
    await this.prisma.$queryRaw(Prisma.sql`SELECT 1`);
    return { ok: true };
  }
}
