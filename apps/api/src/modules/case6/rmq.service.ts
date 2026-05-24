import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import { randomUUID } from 'node:crypto';
import {
  CASE6_RMQ_CLIENT,
  CASE6_WORK_PATTERN,
  type Case6EnqueueResponse,
  type Case6WorkPayload,
  type Case6WorkResult,
} from '@concurrency/shared';
import { StatsService } from './stats.service';

@Injectable()
export class RmqService {
  private inflight = 0;

  constructor(
    @Inject(CASE6_RMQ_CLIENT) private readonly client: ClientProxy,
    private readonly stats: StatsService,
  ) {}

  async enqueue(workMs: number): Promise<Case6EnqueueResponse> {
    const policy = 'prefetch-tune' as const;
    const payload: Case6WorkPayload = {
      jobId: randomUUID(),
      workMs,
      enqueuedAt: Date.now(),
    };
    const depth = this.inflight;
    this.inflight += 1;
    this.stats.recordEnqueued(policy);

    try {
      const result = await firstValueFrom(
        this.client.send<Case6WorkResult, Case6WorkPayload>(
          CASE6_WORK_PATTERN,
          payload,
        ),
      );
      const waitMs = result.startedAt - payload.enqueuedAt;
      this.stats.recordProcessed(policy, waitMs);
      return {
        policy,
        status: 'processed',
        jobId: payload.jobId,
        enqueuedAt: payload.enqueuedAt,
        startedAt: result.startedAt,
        finishedAt: result.finishedAt,
        waitMs,
        workMs,
        queueDepthAtEnqueue: depth,
      };
    } finally {
      this.inflight -= 1;
    }
  }

  queueDepth(): number {
    return this.inflight;
  }
}
