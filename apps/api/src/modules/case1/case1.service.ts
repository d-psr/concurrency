import { Injectable } from '@nestjs/common';
import { PrismaService } from '@concurrency/database';
import * as bcrypt from 'bcrypt';
import pLimit from 'p-limit';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

const BCRYPT_COST = 12;
const BCRYPT_CONCURRENCY = 3;
const TMP_FILE = path.resolve(__dirname, '../../../../../tmp/tmp.bin');

@Injectable()
export class Case1Service {
  private readonly bcryptLimit = pLimit(BCRYPT_CONCURRENCY);

  constructor(private readonly prisma: PrismaService) {}

  async hashAndInsertWithoutLimit(password: string): Promise<{ id: string }> {
    const hash = await bcrypt.hash(password, BCRYPT_COST);
    const created = await this.prisma.credential.create({
      data: { bcrypt: hash },
    });
    return { id: created.id.toString() };
  }

  async hashAndInsertWithLimit(password: string): Promise<{ id: string }> {
    const hash = await this.bcryptLimit(() =>
      bcrypt.hash(password, BCRYPT_COST),
    );
    const created = await this.prisma.credential.create({
      data: { bcrypt: hash },
    });
    return { id: created.id.toString() };
  }

  async fileIo(): Promise<{ bytes: number }> {
    const data = await fs.readFile(TMP_FILE);
    return { bytes: data.byteLength };
  }
}
