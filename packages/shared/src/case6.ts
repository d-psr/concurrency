export const CASE6_QUEUE_MAX = 100;
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

// status 의미:
//   processed — consumer가 정상 처리
//   dropped   — 정책(drop-oldest)에 의해 큐에서 밀려남
//   aborted   — /case6/reset에 의해 펜딩 상태에서 강제 종료 (정책 측정에서 제외)
export type Case6EnqueueResponse = {
  policy: Case6Policy;
  status: 'processed' | 'dropped' | 'aborted';
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
  aborted: number;
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
