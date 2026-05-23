import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '@concurrency/database';

const ACCOUNT_ID = 1n;
const OPTIMISTIC_MAX_RETRIES = 10;

type DecrementResult = {
  before: number;
  after: number;
  applied: boolean;
  attempts?: number;
};

@Injectable()
export class Case3Service {
  constructor(private readonly prisma: PrismaService) {}

  async reset(initial: number) {
    const prev = await this.prisma.account.findUnique({
      where: { id: ACCOUNT_ID },
    });
    await this.prisma.account.upsert({
      where: { id: ACCOUNT_ID },
      create: { id: ACCOUNT_ID, balance: initial, version: 0 },
      update: { balance: initial, version: 0 },
    });
    return {
      id: ACCOUNT_ID.toString(),
      balance: initial,
      version: 0,
      previousBalance: prev?.balance ?? null,
    };
  }

  async decrementNaive(amount: number): Promise<DecrementResult> {
    const row = await this.prisma.account.findUnique({
      where: { id: ACCOUNT_ID },
    });
    if (!row) throw new NotFoundException('account not initialized');
    if (row.balance < amount) {
      return { before: row.balance, after: row.balance, applied: false };
    }
    const updated = await this.prisma.account.update({
      where: { id: ACCOUNT_ID },
      data: { balance: row.balance - amount },
    });
    return { before: row.balance, after: updated.balance, applied: true };
  }

  async decrementAtomic(amount: number): Promise<DecrementResult> {
    const result = await this.prisma.account.updateMany({
      where: { id: ACCOUNT_ID, balance: { gte: amount } },
      data: { balance: { decrement: amount } },
    });
    const row = await this.prisma.account.findUnique({
      where: { id: ACCOUNT_ID },
    });
    if (!row) throw new NotFoundException('account not initialized');
    if (result.count === 0) {
      return { before: row.balance, after: row.balance, applied: false };
    }
    return { before: row.balance + amount, after: row.balance, applied: true };
  }

  async decrementPessimistic(amount: number): Promise<DecrementResult> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: bigint; balance: number }[]>`
        SELECT id, balance FROM accounts WHERE id = ${ACCOUNT_ID} FOR UPDATE
      `;
      const row = rows[0];
      if (!row) throw new NotFoundException('account not initialized');
      if (row.balance < amount) {
        return { before: row.balance, after: row.balance, applied: false };
      }
      const updated = await tx.account.update({
        where: { id: ACCOUNT_ID },
        data: { balance: row.balance - amount },
      });
      return { before: row.balance, after: updated.balance, applied: true };
    });
  }

  async decrementOptimistic(amount: number): Promise<DecrementResult> {
    for (let attempt = 1; attempt <= OPTIMISTIC_MAX_RETRIES; attempt++) {
      const row = await this.prisma.account.findUnique({
        where: { id: ACCOUNT_ID },
      });
      if (!row) throw new NotFoundException('account not initialized');
      if (row.balance < amount) {
        return {
          before: row.balance,
          after: row.balance,
          applied: false,
          attempts: attempt,
        };
      }
      const result = await this.prisma.account.updateMany({
        where: { id: ACCOUNT_ID, version: row.version },
        data: {
          balance: row.balance - amount,
          version: { increment: 1 },
        },
      });
      if (result.count === 1) {
        return {
          before: row.balance,
          after: row.balance - amount,
          applied: true,
          attempts: attempt,
        };
      }
    }
    throw new ConflictException('optimistic update exhausted retries');
  }
}
