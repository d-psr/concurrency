import { Injectable } from '@nestjs/common';
import {
  CASE6_CONSUMER_MS,
  CASE6_POLICIES,
  type Case6EnqueueResponse,
  type Case6Policy,
  type Case6Stats,
} from '@concurrency/shared';
import { InMemoryQueueService } from './in-memory-queue.service';
import { RmqService } from './rmq.service';
import { StatsService } from './stats.service';

@Injectable()
export class Case6Service {
  constructor(
    private readonly queue: InMemoryQueueService,
    private readonly rmq: RmqService,
    private readonly statsService: StatsService,
  ) {}

  enqueue(policy: Case6Policy): Promise<Case6EnqueueResponse> {
    if (policy === 'prefetch-tune') {
      return this.rmq.enqueue(CASE6_CONSUMER_MS);
    }
    return this.queue.enqueue(policy, CASE6_CONSUMER_MS);
  }

  stats(): Case6Stats {
    const queueDepths = {} as Record<Case6Policy, number>;
    const oldestAges = {} as Record<Case6Policy, number | null>;
    for (const policy of CASE6_POLICIES) {
      if (policy === 'prefetch-tune') {
        queueDepths[policy] = this.rmq.queueDepth();
        oldestAges[policy] = null;
      } else {
        queueDepths[policy] = this.queue.queueDepth(policy);
        oldestAges[policy] = this.queue.oldestAge(policy);
      }
    }
    return this.statsService.snapshot(queueDepths, oldestAges);
  }

  reset(): Case6Stats {
    const before = this.stats();
    this.queue.reset();
    this.statsService.reset();
    return before;
  }
}
