export const CASE6_QUEUE_MAX = 1000;
export const CASE6_CONSUMER_MS = 100;
export const CASE6_PREFETCH = 1;
export const CASE6_STATS_WINDOW = 1000;

export const CASE6_RMQ_QUEUE = 'case6.work.queue';
export const CASE6_RMQ_CLIENT = 'CASE6_RMQ_CLIENT';
export const CASE6_WORK_PATTERN = 'case6.work';

export const CASE6_POLICIES = [
  'unbounded',
  'drop-oldest',
  'reject-429',
  'prefetch-tune',
] as const;
export type Case6Policy = (typeof CASE6_POLICIES)[number];

export type Case6WorkPayload = {
  jobId: string;
  workMs: number;
  enqueuedAt: number;
};

export type Case6WorkResult = {
  jobId: string;
  startedAt: number;
  finishedAt: number;
};

export type Case6EnqueueResponse = {
  policy: Case6Policy;
  status: 'processed' | 'dropped';
  jobId: string;
  enqueuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  waitMs: number | null;
  workMs: number;
  queueDepthAtEnqueue: number;
};

export type Case6PolicyStats = {
  queueDepth: number;
  enqueued: number;
  processed: number;
  dropped: number;
  rejected: number;
  oldestAgeMs: number | null;
  avgWaitMs: number;
  p95WaitMs: number;
};

export type Case6Stats = {
  byPolicy: Record<Case6Policy, Case6PolicyStats>;
  rss: number;
  heapUsed: number;
  uptimeMs: number;
};
