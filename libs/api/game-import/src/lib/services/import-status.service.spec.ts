import { Action, DatabaseService, JobStatus, JobType, Prisma, ResourceType } from '@bge/database';
import { t } from '@bge/i18n';
import { AbilityService, ScopeComposer } from '@bge/permissions';
import {
  createMockAbilityService,
  MOCK_RESOURCE_CONDITION,
  paginationQuery,
  type MockAbilityService,
} from '@bge/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ImportBatchStatus } from '../interfaces/import-job.interface';
import { GameImportStatusService } from './import-status.service';

const ME = 'user-7';
const COND = MOCK_RESOURCE_CONDITION;

describe('GameImportStatusService', () => {
  let service: GameImportStatusService;
  /**
   * A narrow fake rather than `createMockDatabaseService()`: this suite drives
   * the service directly. `$transaction` runs the callback against the fake,
   * so the batch list's one interactive transaction executes.
   */
  let db: {
    job: { findMany: jest.Mock; count: jest.Mock };
    $transaction: jest.Mock;
  };
  let ability: MockAbilityService;
  let compose: jest.SpyInstance;

  const startedAt = new Date('2026-07-06T10:00:00Z');
  const completedAt = new Date('2026-07-06T10:00:05Z');

  beforeEach(() => {
    db = {
      job: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
      $transaction: jest.fn((run: (tx: unknown) => Promise<unknown>) => run(db)),
    };
    ability = createMockAbilityService();
    ability.getActingUserId.mockReturnValue(ME);
    // The REAL composer, over the mocked ability service, so the where clauses
    // asserted below are the merge the reads actually run.
    const scopeComposer = new ScopeComposer(ability as unknown as AbilityService);
    compose = jest.spyOn(scopeComposer, 'compose');
    service = new GameImportStatusService(
      db as unknown as DatabaseService,
      ability as unknown as AbilityService,
      scopeComposer,
    );
  });

  afterEach(() => jest.clearAllMocks());

  /**
   * #515. A batch's jobs are read through the `Job` read ceiling, so an actor
   * whose ceiling admits none of them gets the same 404 as an unknown batch.
   * Any signed-in user may still poll any batch: a session's ceiling admits
   * every import job.
   */
  it("asks the composer for the batch's import jobs", async () => {
    db.job.findMany.mockResolvedValue([]);

    await service.getBatchStatus('batch-1').catch(() => undefined);

    expect(compose).toHaveBeenCalledWith(ResourceType.Job, Action.read, {
      batchId: 'batch-1',
      type: JobType.GameImport,
    });
  });

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
        where: { batchId: 'batch-1', type: JobType.GameImport, AND: [COND] },
        // Expansion rows are created after their base, but createdAt does not
        // order them among themselves, so base-first ordering comes from
        // parentJobId nulls-first and id breaks the rest.
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

  /**
   * #515. A batch is the set of jobs sharing a `batchId`, and every batch has
   * exactly one base job (`parentJobId: null`), created when the import is
   * enqueued. So the page is a page of base jobs, and `total` is a count of
   * them: both are plain Prisma reads, so both take the composed `where`. The
   * count used to be raw SQL, which could not, so an API key scoped to one
   * import learned how many imports its owner had run.
   */
  describe('listBatchesForUser', () => {
    const BASE_JOBS = { userId: ME, type: JobType.GameImport, batchId: { not: null }, parentJobId: null };

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

    /**
     * Answers the two `findMany` calls by shape, not by order: the page asks
     * for base jobs (its `where` names `parentJobId`), and the batch fetch asks
     * for every job of the page's batches. A stub keyed on call order would
     * keep passing if a third read were added between them.
     */
    const stubJobs = ({ bases, jobs = [] }: { bases: { batchId: string }[]; jobs?: unknown[] }) => {
      db.job.findMany.mockImplementation((args: { where: Record<string, unknown> }) =>
        Promise.resolve(JSON.stringify(args.where).includes('parentJobId') ? bases : jobs),
      );
    };

    const pageCall = () => db.job.findMany.mock.calls[0][0];
    const batchFetchCall = () => db.job.findMany.mock.calls[1][0];

    it("asks the composer for the acting user's base import jobs, one per batch", async () => {
      await service.listBatchesForUser(paginationQuery());

      expect(compose).toHaveBeenCalledWith(ResourceType.Job, Action.read, BASE_JOBS);
    });

    // Newest start first. The base job is created when the import is enqueued
    // and its expansions only once it has run, so ordering by the base job is
    // ordering by when the batch started. The old order was the batch's newest
    // job, which moved a batch up the list when its expansions spawned.
    it('pages the base jobs by when their batch started, newest first', async () => {
      await service.listBatchesForUser(paginationQuery({ page: 2, limit: 5 }));

      expect(pageCall()).toEqual(
        expect.objectContaining({
          where: { ...BASE_JOBS, AND: [COND] },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: 5,
          take: 5,
        }),
      );
    });

    // `total` is what the envelope pages towards, so it must count exactly the
    // set the page is cut from: a count over a wider `where` advertises pages
    // that come back empty.
    it('counts the same composed base jobs it pages, and reports that as total', async () => {
      stubJobs({ bases: [{ batchId: 'batch-1' }], jobs: [row({ id: 'job-1' })] });
      db.job.count.mockResolvedValue(9);

      const response = await service.listBatchesForUser(paginationQuery({ limit: 5 }));

      expect(db.job.count).toHaveBeenCalledWith({ where: pageCall().where });
      expect(response.total).toBe(9);
    });

    it('returns an empty page, and fetches no jobs, when the user has no import batches', async () => {
      await expect(service.listBatchesForUser(paginationQuery())).resolves.toEqual({ rows: [], total: 0 });
      expect(db.job.findMany).toHaveBeenCalledTimes(1);
    });

    // The ceiling clips each batch's jobs too, not only which batches appear:
    // a key scoped to one base job lists that batch with that job alone.
    it("fetches the page's jobs through the composed ceiling", async () => {
      stubJobs({
        bases: [{ batchId: 'batch-2' }, { batchId: 'batch-1' }],
        jobs: [row({ id: 'job-1', batchId: 'batch-1' }), row({ id: 'job-2', batchId: 'batch-2' })],
      });

      await service.listBatchesForUser(paginationQuery());

      expect(compose).toHaveBeenCalledWith(ResourceType.Job, Action.read, {
        batchId: { in: ['batch-2', 'batch-1'] },
        type: JobType.GameImport,
        userId: ME,
      });
      expect(batchFetchCall()).toEqual(
        expect.objectContaining({
          where: { batchId: { in: ['batch-2', 'batch-1'] }, type: JobType.GameImport, userId: ME, AND: [COND] },
          orderBy: [{ parentJobId: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
        }),
      );
    });

    it('returns the batches in page order with derived rollups', async () => {
      stubJobs({
        bases: [{ batchId: 'batch-2' }, { batchId: 'batch-1' }],
        jobs: [
          row({ id: 'job-1', batchId: 'batch-1' }),
          row({ id: 'job-2', batchId: 'batch-2', status: JobStatus.Running, gameId: null, completedAt: null }),
        ],
      });
      db.job.count.mockResolvedValue(2);

      const response = await service.listBatchesForUser(paginationQuery());

      expect(response.rows.map((batch) => batch.batchId)).toEqual(['batch-2', 'batch-1']);
      expect(response.rows[0].status).toBe(ImportBatchStatus.Running);
      expect(response.rows[1].status).toBe(ImportBatchStatus.Completed);
      expect(response.rows[1].jobs[0]).toEqual(expect.objectContaining({ jobId: 'job-1', externalId: 'ext-1' }));
    });

    // PROVISIONAL (#395). "My imports" has no meaning for an actor with no user
    // behind it, and the refusal must not soften into an empty page.
    it('refuses an actor kind with no user behind it, with a message about reading', async () => {
      ability.getActingUserId.mockImplementation(() => {
        throw new ForbiddenException(t('errors.actor_context.not_user_attributable', { kind: 'plugin' }));
      });

      const rejection: unknown = await service.listBatchesForUser(paginationQuery()).catch((error: unknown) => error);

      expect(rejection).toBeInstanceOf(ForbiddenException);
      expect((rejection as ForbiddenException).getResponse()).toEqual(t('common.forbidden.access'));
      expect(db.job.findMany).not.toHaveBeenCalled();
    });

    /**
     * The callback form inherits Prisma's 5s default. This read was two untimed
     * queries before #372, so leaving the default would turn a slow response
     * into a P2028 500 for the user with the longest import history — the one
     * this recovery route exists for.
     */
    it('raises the interactive transaction timeout above Prisma’s 5s default', async () => {
      await service.listBatchesForUser(paginationQuery());

      const options = db.$transaction.mock.calls[0][1] as { timeout?: number };
      expect(options.timeout).toBeGreaterThan(5000);
    });

    /**
     * The third statement depends on the first — job rows are fetched by the
     * batchIds the page resolved — so they have to share a snapshot. Under
     * separate ones a job deleted in between yields a batch with no jobs, and a
     * `total` describing a different set of batches than the rows.
     */
    it('runs the page, the count and the job fetch in one REPEATABLE READ transaction', async () => {
      stubJobs({ bases: [{ batchId: 'batch-1' }], jobs: [row({ id: 'job-1' })] });

      await service.listBatchesForUser(paginationQuery());

      expect(db.$transaction).toHaveBeenCalledTimes(1);
      expect(db.job.findMany).toHaveBeenCalledTimes(2);
      expect(db.job.count).toHaveBeenCalledTimes(1);
      const options = db.$transaction.mock.calls[0][1] as { isolationLevel?: unknown };
      // The timeout is asserted on its own above; this pins the isolation level.
      expect(options).toMatchObject({ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    });

    // The count is taken even on an empty page, so a client that paged past the
    // end still learns how many batches there are to page back to.
    it('reports the total on a page that came back empty', async () => {
      db.job.count.mockResolvedValue(4);

      await expect(service.listBatchesForUser(paginationQuery({ page: 99 }))).resolves.toEqual({
        rows: [],
        total: 4,
      });
    });
  });
});
