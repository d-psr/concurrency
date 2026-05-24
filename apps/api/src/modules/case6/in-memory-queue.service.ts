import {
  HttpException,
  HttpStatus,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  CASE6_CONSUMER_MS,
  CASE6_QUEUE_MAX,
  type Case6EnqueueResponse,
  type Case6Policy,
} from '@concurrency/shared';
import { StatsService } from './stats.service';

type InMemoryPolicy = Exclude<Case6Policy, 'prefetch-tune'>;

type Job = {
  jobId: string;
  enqueuedAt: number;
  workMs: number;
  resolve: (response: Case6EnqueueResponse) => void;
};

type PolicyQueue = {
  policy: InMemoryPolicy;
  jobs: Job[];
  waiter: ((job: Job) => void) | null;
  stopped: boolean;
};

@Injectable()
export class InMemoryQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly queues: Record<InMemoryPolicy, PolicyQueue> = {
    unbounded: this.emptyQueue('unbounded'),
    'drop-oldest': this.emptyQueue('drop-oldest'),
    'reject-429': this.emptyQueue('reject-429'),
  };

  constructor(private readonly stats: StatsService) {}

  onModuleInit(): void {
    for (const policy of Object.keys(this.queues) as InMemoryPolicy[]) {
      void this.runConsumer(this.queues[policy]);
    }
  }

  onModuleDestroy(): void {
    for (const q of Object.values(this.queues)) q.stopped = true;
  }

  enqueue(policy: InMemoryPolicy, workMs: number): Promise<Case6EnqueueResponse> {
    const q = this.queues[policy];
    const depth = q.jobs.length;

    if (policy === 'reject-429' && depth >= CASE6_QUEUE_MAX) {
      this.stats.recordRejected(policy);
      throw new HttpException(
        {
          policy,
          queueDepth: depth,
          oldestAgeMs: this.oldestAge(policy),
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return new Promise<Case6EnqueueResponse>((resolve) => {
      const job: Job = {
        jobId: randomUUID(),
        enqueuedAt: Date.now(),
        workMs,
        resolve,
      };

      if (policy === 'drop-oldest' && q.jobs.length >= CASE6_QUEUE_MAX) {
        const victim = q.jobs.shift()!;
        this.stats.recordDropped(policy);
        victim.resolve({
          policy,
          status: 'dropped',
          jobId: victim.jobId,
          enqueuedAt: victim.enqueuedAt,
          startedAt: null,
          finishedAt: null,
          waitMs: null,
          workMs: victim.workMs,
          queueDepthAtEnqueue: CASE6_QUEUE_MAX,
        });
      }

      q.jobs.push(job);
      this.stats.recordEnqueued(policy);

      if (q.waiter) {
        const wake = q.waiter;
        q.waiter = null;
        const next = q.jobs.shift()!;
        wake(next);
      }
    }).then((response) => ({
      ...response,
      queueDepthAtEnqueue: depth,
    }));
  }

  queueDepth(policy: InMemoryPolicy): number {
    return this.queues[policy].jobs.length;
  }

  oldestAge(policy: InMemoryPolicy): number | null {
    const first = this.queues[policy].jobs[0];
    return first ? Date.now() - first.enqueuedAt : null;
  }

  reset(): void {
    for (const policy of Object.keys(this.queues) as InMemoryPolicy[]) {
      const q = this.queues[policy];
      for (const job of q.jobs) {
        job.resolve({
          policy,
          status: 'dropped',
          jobId: job.jobId,
          enqueuedAt: job.enqueuedAt,
          startedAt: null,
          finishedAt: null,
          waitMs: null,
          workMs: job.workMs,
          queueDepthAtEnqueue: 0,
        });
      }
      q.jobs = [];
    }
  }

  private async runConsumer(q: PolicyQueue): Promise<void> {
    while (!q.stopped) {
      const job = await this.take(q);
      if (!job) return;
      const startedAt = Date.now();
      await sleep(job.workMs ?? CASE6_CONSUMER_MS);
      const finishedAt = Date.now();
      this.stats.recordProcessed(q.policy, startedAt - job.enqueuedAt);
      job.resolve({
        policy: q.policy,
        status: 'processed',
        jobId: job.jobId,
        enqueuedAt: job.enqueuedAt,
        startedAt,
        finishedAt,
        waitMs: startedAt - job.enqueuedAt,
        workMs: job.workMs,
        queueDepthAtEnqueue: 0,
      });
    }
  }

  private take(q: PolicyQueue): Promise<Job | null> {
    if (q.stopped) return Promise.resolve(null);
    const next = q.jobs.shift();
    if (next) return Promise.resolve(next);
    return new Promise<Job | null>((resolve) => {
      q.waiter = resolve as (job: Job) => void;
    });
  }

  private emptyQueue(policy: InMemoryPolicy): PolicyQueue {
    return { policy, jobs: [], waiter: null, stopped: false };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
