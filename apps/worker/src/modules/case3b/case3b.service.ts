import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@concurrency/database';
import type { Case3bDecrementResult } from '@concurrency/shared';

const ACCOUNT_ID = 1n;

@Injectable()
export class Case3bService {
  constructor(private readonly prisma: PrismaService) {}

  async decrement(amount: number): Promise<Case3bDecrementResult> {
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
}
