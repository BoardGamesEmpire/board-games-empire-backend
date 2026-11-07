import type { JobsOptions } from 'bullmq';

/**
 * Retry and retention for every extended network job (#497). A rebuild that
 * fails is retried before the daily rebuild has to repair its rows: when the
 * database connection drops, say, or when a user is deleted while it runs, so
 * that a pair it writes names a user who is gone. The last failures are kept
 * for an operator to read.
 */
export const EXTENDED_NETWORK_JOB_RETRY = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: true,
  removeOnFail: 50,
} as const satisfies JobsOptions;
