import { Injectable } from '@nestjs/common';
import {
  CASE6_POLICIES,
  CASE6_STATS_WINDOW,
  type Case6Policy,
  type Case6PolicyStats,
  type Case6Stats,
} from '@concurrency/shared';

type Counters = {
  enqueued: number;
  processed: number;
  dropped: number;
  rejected: number;
  waitWindow: number[];
  waitSum: number;
  waitCount: number;
};

@Injectable()
export class StatsService {
  private readonly startedAt = Date.now();
  private readonly counters: Record<Case6Policy, Counters> = this.initCounters();

  recordEnqueued(policy: Case6Policy): void {
    this.counters[policy].enqueued += 1;
  }

  recordProcessed(policy: Case6Policy, waitMs: number): void {
    const c = this.counters[policy];
    c.processed += 1;
    c.waitSum += waitMs;
    c.waitCount += 1;
    c.waitWindow.push(waitMs);
    if (c.waitWindow.length > CASE6_STATS_WINDOW) c.waitWindow.shift();
  }

  recordDropped(policy: Case6Policy): void {
    this.counters[policy].dropped += 1;
  }

  recordRejected(policy: Case6Policy): void {
    this.counters[policy].rejected += 1;
  }

  reset(): void {
    for (const policy of CASE6_POLICIES) {
      this.counters[policy] = this.emptyCounter();
    }
  }

  snapshot(
    queueDepths: Record<Case6Policy, number>,
    oldestAges: Record<Case6Policy, number | null>,
  ): Case6Stats {
    const byPolicy = {} as Record<Case6Policy, Case6PolicyStats>;
    for (const policy of CASE6_POLICIES) {
      const c = this.counters[policy];
      byPolicy[policy] = {
        queueDepth: queueDepths[policy],
        enqueued: c.enqueued,
        processed: c.processed,
        dropped: c.dropped,
        rejected: c.rejected,
        oldestAgeMs: oldestAges[policy],
        avgWaitMs: c.waitCount === 0 ? 0 : c.waitSum / c.waitCount,
        p95WaitMs: this.p95(c.waitWindow),
      };
    }
    const mem = process.memoryUsage();
    return {
      byPolicy,
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      uptimeMs: Date.now() - this.startedAt,
    };
  }

  private p95(window: number[]): number {
    if (window.length === 0) return 0;
    const sorted = [...window].sort((a, b) => a - b);
    const idx = Math.floor(sorted.length * 0.95);
    return sorted[Math.min(idx, sorted.length - 1)];
  }

  private initCounters(): Record<Case6Policy, Counters> {
    const out = {} as Record<Case6Policy, Counters>;
    for (const policy of CASE6_POLICIES) out[policy] = this.emptyCounter();
    return out;
  }

  private emptyCounter(): Counters {
    return {
      enqueued: 0,
      processed: 0,
      dropped: 0,
      rejected: 0,
      waitWindow: [],
      waitSum: 0,
      waitCount: 0,
    };
  }
}
