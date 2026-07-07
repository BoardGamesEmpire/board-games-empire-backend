import { JobStatus } from '@bge/database';
import { ImportBatchStatus } from '../interfaces/import-job.interface';

const TERMINAL_STATUSES: readonly JobStatus[] = [JobStatus.Completed, JobStatus.Failed, JobStatus.Cancelled];

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * Rolls the per-job statuses of a batch up into a single ImportBatchStatus.
 * Non-terminal wins: any Pending/Running job keeps the batch open. Once every
 * job is terminal, the mix of outcomes decides between Completed,
 * PartiallyCompleted, Failed, and Cancelled.
 */
export function deriveBatchStatus(statuses: readonly JobStatus[]): ImportBatchStatus {
  if (statuses.length === 0) {
    throw new Error('Cannot derive a batch status from zero jobs');
  }

  if (statuses.every((status) => status === JobStatus.Pending)) {
    return ImportBatchStatus.Pending;
  }

  if (statuses.some((status) => !isTerminal(status))) {
    return ImportBatchStatus.Running;
  }

  const completed = statuses.filter((status) => status === JobStatus.Completed).length;
  if (completed === statuses.length) {
    return ImportBatchStatus.Completed;
  }
  if (completed > 0) {
    return ImportBatchStatus.PartiallyCompleted;
  }

  return statuses.every((status) => status === JobStatus.Cancelled)
    ? ImportBatchStatus.Cancelled
    : ImportBatchStatus.Failed;
}
