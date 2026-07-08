import { JobStatus } from '@bge/database';
import { ImportBatchStatus } from '../interfaces/import-job.interface';
import { deriveBatchStatus, isTerminal } from './batch-status';

describe('batch-status', () => {
  describe('isTerminal', () => {
    it.each([
      [JobStatus.Completed, true],
      [JobStatus.Failed, true],
      [JobStatus.Cancelled, true],
      [JobStatus.Pending, false],
      [JobStatus.Running, false],
    ])('%s → %s', (status, expected) => {
      expect(isTerminal(status)).toBe(expected);
    });
  });

  describe('deriveBatchStatus', () => {
    it('throws on an empty batch', () => {
      expect(() => deriveBatchStatus([])).toThrow(/zero jobs/);
    });

    it.each<[JobStatus[], ImportBatchStatus]>([
      [[JobStatus.Pending, JobStatus.Pending], ImportBatchStatus.Pending],
      [[JobStatus.Pending, JobStatus.Running], ImportBatchStatus.Running],
      [[JobStatus.Running], ImportBatchStatus.Running],
      // A batch stays open while any job is non-terminal, even with failures.
      [[JobStatus.Failed, JobStatus.Running], ImportBatchStatus.Running],
      [[JobStatus.Completed, JobStatus.Pending], ImportBatchStatus.Running],
      [[JobStatus.Completed], ImportBatchStatus.Completed],
      [[JobStatus.Completed, JobStatus.Completed], ImportBatchStatus.Completed],
      [[JobStatus.Completed, JobStatus.Failed], ImportBatchStatus.PartiallyCompleted],
      [[JobStatus.Completed, JobStatus.Cancelled], ImportBatchStatus.PartiallyCompleted],
      [[JobStatus.Failed], ImportBatchStatus.Failed],
      [[JobStatus.Failed, JobStatus.Cancelled], ImportBatchStatus.Failed],
      [[JobStatus.Cancelled, JobStatus.Cancelled], ImportBatchStatus.Cancelled],
    ])('%j → %s', (statuses, expected) => {
      expect(deriveBatchStatus(statuses)).toBe(expected);
    });
  });
});
