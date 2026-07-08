import { DatabaseService, JobStatus, JobType } from '@bge/database';
import { NotFoundException } from '@nestjs/common';
import { ImportBatchStatus } from '../interfaces/import-job.interface';
import { GameImportStatusService } from './import-status.service';

describe('GameImportStatusService', () => {
  let service: GameImportStatusService;
  let db: { job: { findMany: jest.Mock; groupBy: jest.Mock } };

  const startedAt = new Date('2026-07-06T10:00:00Z');
  const completedAt = new Date('2026-07-06T10:00:05Z');

  beforeEach(() => {
    db = { job: { findMany: jest.fn(), groupBy: jest.fn() } };
    service = new GameImportStatusService(db as unknown as DatabaseService);
  });

  afterEach(() => jest.clearAllMocks());

  it('throws NotFound for an unknown batchId', async () => {
    db.job.findMany.mockResolvedValue([]);

    await expect(service.getBatchStatus('nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('maps Job rows to per-job DTOs with a derived batch rollup', async () => {
    const platformGames = [{ platformId: 'plat-1', platformGameId: 'pg-1' }];
    db.job.findMany.mockResolvedValue([
      {
        id: 'base-job',
        status: JobStatus.Completed,
        parentJobId: null,
        gameId: 'game-1',
        result: { gameId: 'game-1', gameTitle: 'Catan', thumbnail: 'http://x/y.png', platformGames },
        payload: { correlationId: 'corr-1', externalId: 'ext-1', expansionExternalIds: ['ext-2'] },
        startedAt,
        completedAt,
      },
      {
        id: 'exp-job',
        status: JobStatus.Running,
        parentJobId: 'base-job',
        gameId: null,
        result: null,
        payload: { correlationId: 'corr-1', externalId: 'ext-2' },
        startedAt,
        completedAt: null,
      },
    ]);

    const response = await service.getBatchStatus('batch-1');

    expect(db.job.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { batchId: 'batch-1', type: JobType.GameImport },
        // createdAt is identical across a batch (single insert transaction),
        // so base-first ordering must come from parentJobId nulls-first.
        orderBy: [{ parentJobId: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
      }),
    );
    expect(response).toEqual({
      batchId: 'batch-1',
      correlationId: 'corr-1',
      status: ImportBatchStatus.Running,
      jobs: [
        {
          jobId: 'base-job',
          status: JobStatus.Completed,
          isExpansion: false,
          parentJobId: null,
          requestedExpansions: ['ext-2'],
          externalId: 'ext-1',
          gameId: 'game-1',
          gameTitle: 'Catan',
          thumbnail: 'http://x/y.png',
          platformGames,
          errorCode: undefined,
          error: undefined,
          startedAt,
          completedAt,
        },
        {
          jobId: 'exp-job',
          status: JobStatus.Running,
          isExpansion: true,
          parentJobId: 'base-job',
          requestedExpansions: undefined,
          externalId: 'ext-2',
          gameId: undefined,
          gameTitle: undefined,
          thumbnail: undefined,
          platformGames: undefined,
          errorCode: undefined,
          error: undefined,
          startedAt,
          completedAt: null,
        },
      ],
    });
  });

  it('surfaces the sanitized failure classification, never a raw Job.error column value', async () => {
    db.job.findMany.mockResolvedValue([
      {
        id: 'base-job',
        status: JobStatus.Failed,
        parentJobId: null,
        gameId: null,
        result: { errorCode: 'GATEWAY_ERROR', error: 'Fetching game data from the gateway failed.' },
        payload: { correlationId: 'corr-1', externalId: 'ext-1' },
        startedAt,
        completedAt: null,
      },
    ]);

    const response = await service.getBatchStatus('batch-1');

    expect(response.status).toBe(ImportBatchStatus.Failed);
    expect(response.jobs[0]).toEqual(
      expect.objectContaining({
        status: JobStatus.Failed,
        errorCode: 'GATEWAY_ERROR',
        error: 'Fetching game data from the gateway failed.',
      }),
    );
  });

  describe('listBatchesForUser', () => {
    const row = (over: Partial<Record<string, unknown>>) => ({
      id: 'job-x',
      batchId: 'batch-1',
      status: JobStatus.Completed,
      parentJobId: null,
      gameId: 'game-1',
      result: null,
      payload: { correlationId: 'corr-1', externalId: 'ext-1' },
      startedAt,
      completedAt,
      ...over,
    });

    it('returns an empty list when the user has no import batches', async () => {
      db.job.groupBy.mockResolvedValue([]);

      await expect(service.listBatchesForUser('user-7', { offset: 0 })).resolves.toEqual({ batches: [] });
      expect(db.job.findMany).not.toHaveBeenCalled();
    });

    it('returns the user batches in recency order with derived rollups', async () => {
      // groupBy delivers recency order: batch-2 (newer) before batch-1.
      db.job.groupBy.mockResolvedValue([
        { batchId: 'batch-2', _max: { createdAt: new Date('2026-07-06T11:00:00Z') } },
        { batchId: 'batch-1', _max: { createdAt: new Date('2026-07-06T10:00:00Z') } },
      ]);
      db.job.findMany.mockResolvedValue([
        row({ id: 'job-1', batchId: 'batch-1' }),
        row({ id: 'job-2', batchId: 'batch-2', status: JobStatus.Running, gameId: null, completedAt: null }),
      ]);

      const response = await service.listBatchesForUser('user-7', { offset: 5, limit: 10 });

      expect(db.job.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          by: ['batchId'],
          where: expect.objectContaining({ userId: 'user-7' }),
          skip: 5,
          take: 10,
        }),
      );
      // Defense-in-depth: the row fetch re-applies userId even though the
      // candidate batchIds already came from a user-scoped groupBy.
      expect(db.job.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ userId: 'user-7' }) }),
      );
      expect(response.batches.map((batch) => batch.batchId)).toEqual(['batch-2', 'batch-1']);
      expect(response.batches[0].status).toBe(ImportBatchStatus.Running);
      expect(response.batches[1].status).toBe(ImportBatchStatus.Completed);
      expect(response.batches[1].jobs[0]).toEqual(expect.objectContaining({ jobId: 'job-1', externalId: 'ext-1' }));
    });
  });
});
