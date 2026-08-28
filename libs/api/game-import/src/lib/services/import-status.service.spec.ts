import { DatabaseService, JobStatus, JobType, Prisma } from '@bge/database';
import { t } from '@bge/i18n';
import { paginationQuery } from '@bge/testing';
import { NotFoundException } from '@nestjs/common';
import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
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

    /**
     * The one statement in this service whose identifiers are physical rather
     * than derived by Prisma: it names `jobs`, `batch_id`, `user_id` and the
     * `job_types` enum directly. A `@@map` or enum rename in
     * `prisma/models/system/job.prisma` would compile, satisfy every other test
     * here, and 500 the route at runtime — so the names are read back out of the
     * schema rather than trusted.
     *
     * The pattern is the raw-lock pin in `household-member.service.spec.ts`,
     * itself #248's rule applied to source instead of models. Executing the
     * statement against a real Postgres is the complementary guard and belongs
     * with the e2e harness's `readShippedSql` machinery (#405).
     */
    describe('the identifiers the raw count hardcodes', () => {
      const JOB_MODEL = 'system/job.prisma';

      const findSchemaDir = (): string => {
        let dir = __dirname;

        for (let depth = 0; depth < 10; depth += 1) {
          const candidate = join(dir, 'prisma', 'models');

          try {
            if (statSync(candidate).isDirectory()) {
              return candidate;
            }
          } catch {
            // Not this level; keep walking toward the workspace root.
          }

          dir = resolve(dir, '..');
        }

        throw new Error('Could not locate prisma/models by walking up from the spec directory');
      };

      const schema = () => readFileSync(join(findSchemaDir(), JOB_MODEL), 'utf8');

      const block = (source: string, kind: 'model' | 'enum', name: string): string => {
        const body = new RegExp(`${kind}\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(source)?.[1];
        expect(body).toBeDefined();

        return body as string;
      };

      /** `@@map` name, or the declared name when unmapped. */
      const mapped = (source: string, kind: 'model' | 'enum', name: string): string =>
        /@@map\("([^"]+)"\)/.exec(block(source, kind, name))?.[1] ?? name;

      /** `@map` name for one field, or the field name when unmapped. */
      const column = (source: string, model: string, field: string): string => {
        const line = new RegExp(`^\\s*${field}\\b.*$`, 'm').exec(block(source, 'model', model))?.[0] ?? '';

        return /@map\("([^"]+)"\)/.exec(line)?.[1] ?? field;
      };

      const capturedSql = async (): Promise<string> => {
        db.job.groupBy.mockResolvedValue([]);
        await service.listBatchesForUser('user-7', paginationQuery());

        const [query] = db.$queryRaw.mock.calls[0] as [Prisma.Sql];

        return query.sql;
      };

      it('names only the table, columns and enum the Job model maps to', async () => {
        const sql = await capturedSql();
        const source = schema();

        // Word-boundary matched, so `jobs` cannot be satisfied by a longer
        // identifier that merely contains it.
        for (const identifier of [
          mapped(source, 'model', 'Job'),
          mapped(source, 'enum', 'JobType'),
          column(source, 'Job', 'batchId'),
          column(source, 'Job', 'userId'),
        ]) {
          expect(sql).toMatch(new RegExp(`\\b${identifier}\\b`));
        }
      });

      // The enum literal is bound as a parameter and cast, so a renamed VALUE
      // (as opposed to the enum type) fails at runtime too. Pinned separately
      // because it travels in `values`, not in the statement text.
      it('binds a JobType value the schema still declares', async () => {
        await capturedSql();

        const [query] = db.$queryRaw.mock.calls[0] as [Prisma.Sql];
        expect(query.values).toContain(JobType.GameImport);
        expect(block(schema(), 'enum', 'JobType')).toMatch(new RegExp(`\\b${JobType.GameImport}\\b`));
      });
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
    /**
     * The callback form inherits Prisma's 5s default. This read was two untimed
     * queries before #372, so leaving the default would turn a slow response
     * into a P2028 500 for the user with the longest import history — the one
     * this recovery route exists for.
     */
    it('raises the interactive transaction timeout above Prisma’s 5s default', async () => {
      db.job.groupBy.mockResolvedValue([]);

      await service.listBatchesForUser('user-7', paginationQuery());

      const options = db.$transaction.mock.calls[0][1] as { timeout?: number };
      expect(options.timeout).toBeGreaterThan(5000);
    });

    it('runs the groupBy, the count and the row fetch in one REPEATABLE READ transaction', async () => {
      db.job.groupBy.mockResolvedValue([{ batchId: 'batch-1', _max: { createdAt: startedAt } }]);
      db.job.findMany.mockResolvedValue([row({ id: 'job-1', batchId: 'batch-1' })]);
      countsBatches(1);

      await service.listBatchesForUser('user-7', paginationQuery());

      expect(db.$transaction).toHaveBeenCalledTimes(1);
      const options = db.$transaction.mock.calls[0][1] as { isolationLevel?: unknown };
      // The timeout is asserted on its own above; this pins the isolation level.
      expect(options).toMatchObject({ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
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
