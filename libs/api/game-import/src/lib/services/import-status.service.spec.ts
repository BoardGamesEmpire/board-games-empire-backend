import { DatabaseService, JobStatus, JobType, Prisma } from '@bge/database';
import { t } from '@bge/i18n';
import { paginationQuery } from '@bge/testing';
import { NotFoundException } from '@nestjs/common';
import { ImportBatchStatus } from '../interfaces/import-job.interface';
import { GameImportStatusService } from './import-status.service';

describe('GameImportStatusService', () => {
  let service: GameImportStatusService;
  /**
   * A narrow fake rather than `createMockDatabaseService()`: this suite drives
   * the service directly, and the shared mock's mapped type does not resolve
   * Prisma's generic `groupBy` into a jest mock. `$transaction` runs the
   * callback against the fake, so the batch list's one interactive transaction
   * executes; `$queryRaw` answers the `COUNT(DISTINCT batch_id)`.
   */
  let db: {
    job: { findMany: jest.Mock; groupBy: jest.Mock };
    $queryRaw: jest.Mock;
    $transaction: jest.Mock;
  };

  const startedAt = new Date('2026-07-06T10:00:00Z');
  const completedAt = new Date('2026-07-06T10:00:05Z');

  /** What `COUNT(DISTINCT batch_id)::int` comes back as. */
  const countsBatches = (total: number) => db.$queryRaw.mockResolvedValue([{ total }]);

  beforeEach(() => {
    db = {
      job: { findMany: jest.fn(), groupBy: jest.fn() },
      $queryRaw: jest.fn().mockResolvedValue([]),
      $transaction: jest.fn((run: (tx: unknown) => Promise<unknown>) => run(db)),
    };
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
        // Read-back translates from the machine-readable errorCode (not the
        // English string persisted by the worker); I18nResponseInterceptor
        // renders this marker to a locale-specific string pre-serialization.
        error: t('errors.game_import.failure.gateway_error'),
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

    beforeEach(() => countsBatches(0));

    it('returns an empty page when the user has no import batches', async () => {
      db.job.groupBy.mockResolvedValue([]);

      await expect(service.listBatchesForUser('user-7', paginationQuery())).resolves.toEqual({ rows: [], total: 0 });
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
      countsBatches(9);

      const response = await service.listBatchesForUser('user-7', paginationQuery({ page: 2, limit: 5 }));

      expect(db.job.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          by: ['batchId'],
          where: expect.objectContaining({ userId: 'user-7' }),
          skip: 5,
          take: 5,
        }),
      );
      // Defense-in-depth: the row fetch re-applies userId even though the
      // candidate batchIds already came from a user-scoped groupBy.
      expect(db.job.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ userId: 'user-7' }) }),
      );
      expect(response.rows.map((batch) => batch.batchId)).toEqual(['batch-2', 'batch-1']);
      expect(response.rows[0].status).toBe(ImportBatchStatus.Running);
      expect(response.rows[1].status).toBe(ImportBatchStatus.Completed);
      expect(response.rows[1].jobs[0]).toEqual(expect.objectContaining({ jobId: 'job-1', externalId: 'ext-1' }));
    });

    /**
     * #372: a batch is a GROUP, so `total` cannot come from a row count.
     * `COUNT(DISTINCT batch_id)` does it in the database; the alternatives — a
     * second unpaged groupBy, or `findMany({ distinct })` — would materialise
     * every batch the user has ever run in order to count them, which is the
     * unbounded read this issue exists to remove.
     */
    it('counts distinct batches rather than jobs, and reports it as total', async () => {
      db.job.groupBy.mockResolvedValue([{ batchId: 'batch-1', _max: { createdAt: startedAt } }]);
      // Two jobs in the one batch: a row count would say 2, the batch count 9.
      db.job.findMany.mockResolvedValue([
        row({ id: 'job-1', batchId: 'batch-1' }),
        row({ id: 'job-2', batchId: 'batch-1', parentJobId: 'job-1' }),
      ]);
      countsBatches(9);

      const response = await service.listBatchesForUser('user-7', paginationQuery({ limit: 5 }));

      expect(response.total).toBe(9);
      expect(response.rows).toHaveLength(1);
    });

    it('scopes the count to the caller, matching the groupBy', async () => {
      db.job.groupBy.mockResolvedValue([]);

      await service.listBatchesForUser('user-7', paginationQuery());

      const [query] = db.$queryRaw.mock.calls[0] as [Prisma.Sql];
      expect(query.values).toContain('user-7');
      expect(query.values).toContain(JobType.GameImport);
      expect(query.sql).toContain('COUNT(DISTINCT batch_id)');
    });

    /**
     * The third statement depends on the first — job rows are fetched by the
     * batchIds the groupBy resolved — so they have to share a snapshot. Under
     * separate ones a job deleted in between yields a batch with no jobs, and a
     * `total` describing a different set of batches than the rows.
     */
    it('runs the groupBy, the count and the row fetch in one REPEATABLE READ transaction', async () => {
      db.job.groupBy.mockResolvedValue([{ batchId: 'batch-1', _max: { createdAt: startedAt } }]);
      db.job.findMany.mockResolvedValue([row({ id: 'job-1', batchId: 'batch-1' })]);
      countsBatches(1);

      await service.listBatchesForUser('user-7', paginationQuery());

      expect(db.$transaction).toHaveBeenCalledTimes(1);
      const options = db.$transaction.mock.calls[0][1] as { isolationLevel?: unknown };
      expect(options).toEqual({ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    });

    // The count is taken even on an empty page, so a client that paged past the
    // end still learns how many batches there are to page back to.
    it('reports the total on a page that came back empty', async () => {
      db.job.groupBy.mockResolvedValue([]);
      countsBatches(4);

      await expect(service.listBatchesForUser('user-7', paginationQuery({ page: 99 }))).resolves.toEqual({
        rows: [],
        total: 4,
      });
    });
  });
});
