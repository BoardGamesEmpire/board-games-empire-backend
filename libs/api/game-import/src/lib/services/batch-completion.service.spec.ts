import { MutationEvent } from '@bge/actor-context';
import { DatabaseService, JobStatus } from '@bge/database';
import { WebhookEventType } from '@bge/webhooks';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ImportEvents } from '../constants/queue.constants';
import { ImportBatchStatus } from '../interfaces/import-job.interface';
import { ImportBatchCompletionService } from './batch-completion.service';

describe('ImportBatchCompletionService', () => {
  let service: ImportBatchCompletionService;
  let db: { job: { findMany: jest.Mock; count: jest.Mock } };
  let events: { emit: jest.Mock };

  const baseRow = (status: JobStatus) => ({
    id: 'base-job',
    status,
    parentJobId: null,
    userId: 'user-7',
    payload: { correlationId: 'corr-1' },
  });
  const expansionRow = (status: JobStatus, id = 'exp-job') => ({
    id,
    status,
    parentJobId: 'base-job',
    userId: 'user-7',
    payload: { correlationId: 'corr-1' },
  });

  beforeEach(() => {
    db = { job: { findMany: jest.fn(), count: jest.fn().mockResolvedValue(0) } };
    events = { emit: jest.fn() };
    service = new ImportBatchCompletionService(db as unknown as DatabaseService, events as unknown as EventEmitter2);
  });

  afterEach(() => jest.clearAllMocks());

  it('stays silent while any job is non-terminal, without fetching rows', async () => {
    db.job.count.mockResolvedValue(1);

    await service.checkAndEmit('batch-1');

    expect(db.job.findMany).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('stays silent for an unknown batch', async () => {
    db.job.findMany.mockResolvedValue([]);

    await service.checkAndEmit('batch-1');

    expect(events.emit).not.toHaveBeenCalled();
  });

  it('emits BatchComplete plus the webhook envelope once all jobs are terminal', async () => {
    db.job.findMany.mockResolvedValue([
      baseRow(JobStatus.Completed),
      expansionRow(JobStatus.Failed),
      expansionRow(JobStatus.Completed, 'exp-job-2'),
    ]);

    await service.checkAndEmit('batch-1');

    expect(events.emit).toHaveBeenCalledWith(
      ImportEvents.BatchComplete,
      expect.objectContaining({
        batchId: 'batch-1',
        baseJobId: 'base-job',
        correlationId: 'corr-1',
        status: ImportBatchStatus.PartiallyCompleted,
        counts: { total: 3, completed: 2, failed: 1, cancelled: 0 },
        userId: 'user-7',
      }),
    );
    expect(events.emit).toHaveBeenCalledWith(
      WebhookEventType.ImportBatchCompleted,
      expect.objectContaining({
        subjectId: 'base-job',
        householdId: null,
        occurrenceId: 'batch-1',
        data: expect.objectContaining({ batchId: 'batch-1', status: ImportBatchStatus.PartiallyCompleted }),
      }),
    );

    // Aggregate signal: deliberately a plain payload, not a MutationEvent —
    // the audit listener ignores it (each Job transition is audited itself).
    const batchCall = events.emit.mock.calls.find(([name]) => name === ImportEvents.BatchComplete);
    expect(batchCall![1]).not.toBeInstanceOf(MutationEvent);
  });

  it('never throws into the caller when the query fails', async () => {
    db.job.findMany.mockRejectedValue(new Error('db down'));

    await expect(service.checkAndEmit('batch-1')).resolves.toBeUndefined();
    expect(events.emit).not.toHaveBeenCalled();
  });
});
