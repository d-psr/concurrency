import { Injectable } from '@nestjs/common';
import {
  CASE6_CONSUMER_MS,
  type Case6WorkPayload,
  type Case6WorkResult,
} from '@concurrency/shared';

@Injectable()
export class Case6Service {
  async work(payload: Case6WorkPayload): Promise<Case6WorkResult> {
    const startedAt = Date.now();
    await sleep(payload.workMs ?? CASE6_CONSUMER_MS);
    return { jobId: payload.jobId, startedAt, finishedAt: Date.now() };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
