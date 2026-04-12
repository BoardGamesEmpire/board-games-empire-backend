import type { Job } from '@bge/database';
import { InitiatorType, JobStatus, JobType } from '@bge/database';
import { sequence } from './sequence.js';

export function makeJob(overrides: Partial<Job> = {}): Job {
  const n = sequence();
  return {
    id: `job-${n}`,
    type: JobType.GameImport,
    status: JobStatus.Pending,
    initiatorType: InitiatorType.User,
    userId: null,
    gameId: null,
    batchId: null,
    bullmqJobId: null,
    payload: null,
    result: null,
    error: null,
    note: null,
    parentJobId: null,
    scheduledAt: null,
    startedAt: null,
    completedAt: null,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}
