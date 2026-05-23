import { Injectable, OnModuleDestroy } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import Piscina from 'piscina';
import * as path from 'node:path';

const BCRYPT_COST = 12;
const WORKER_POOL_SIZE = 4;

@Injectable()
export class Case2Service implements OnModuleDestroy {
  private readonly workerPool = new Piscina({
    filename: path.resolve(__dirname, 'worker/bcrypt-worker.js'),
    maxThreads: WORKER_POOL_SIZE,
  });

  syncHash(password: string): { hash: string } {
    const hash = bcrypt.hashSync(password, BCRYPT_COST);
    return { hash };
  }

  async asyncHash(password: string): Promise<{ hash: string }> {
    const hash = await bcrypt.hash(password, BCRYPT_COST);
    return { hash };
  }

  async workerHash(password: string): Promise<{ hash: string }> {
    const hash = await this.workerPool.run(password);
    return { hash };
  }

  health(): { ok: true; at: number } {
    return { ok: true, at: Date.now() };
  }

  async onModuleDestroy(): Promise<void> {
    await this.workerPool.destroy();
  }
}
