import { Action, DatabaseService, JobStatus, JobType, Prisma, ResourceType } from '@bge/database';
import { t } from '@bge/i18n';
import { AbilityService, resolveScopeSubjectId, ScopeComposer } from '@bge/permissions';
import type { PaginatedRows, PaginationQueryDto } from '@bge/shared';
import { Injectable, NotFoundException } from '@nestjs/common';
import type { ImportBatchStatusResponseDto, ImportJobStatusDto } from '../dto/import-status.dto';
import type { PersistedJobFailure, PersistedJobResult } from '../interfaces/import-job.interface';
import { deriveBatchStatus } from '../utils/batch-status';
import { importErrorMarker } from '../utils/sanitize-import-error';

/**
 * Deliberately omits Job.error: that column holds the raw failure text
 * (gRPC transport detail, Prisma error text, internal hostnames) written for
 * operator debugging only. GET /games/import/:batchId is not owner-scoped,
 * so it must serve only the sanitized {errorCode, error} the processors
 * persist into `result` on failure — never selecting the raw column makes
 * that a structural guarantee rather than a per-call discipline.
 */
const JOB_SELECT = {
  id: true,
  batchId: true,
  status: true,
  parentJobId: true,
  gameId: true,
  result: true,
  payload: true,
  startedAt: true,
  completedAt: true,
} satisfies Prisma.JobSelect;

type JobRow = Prisma.JobGetPayload<{ select: typeof JOB_SELECT }>;

/**
 * The user's import batches, one row each: every batch has exactly one base
 * job (`parentJobId: null`), which the coordinator creates when the import is
 * enqueued. Expansion jobs join the batch later, as the base job spawns them.
 * The parent foreign key cascades, so deleting a base job deletes its
 * expansions rather than leaving each one parentless, and so a base job.
 *
 * So a page of base jobs is a page of batches, and counting them counts
 * batches. Both are plain Prisma reads, which is what lets the page and its
 * `total` take one composed `where` (#515): `total` used to be a raw
 * `COUNT(DISTINCT batch_id)`, which no ceiling could reach.
 */
const batchBaseJobs = (userId: string) =>
  ({ userId, type: JobType.GameImport, batchId: { not: null }, parentJobId: null }) satisfies Prisma.JobWhereInput;

/**
 * Base job first (parentJobId null), then expansions. The expansions of a batch
 * are created together, after their base, so createdAt does not order them
 * among themselves; id breaks ties deterministically.
 */
const BATCH_JOB_ORDER = [
  { parentJobId: { sort: 'asc', nulls: 'first' } },
  { id: 'asc' },
] satisfies Prisma.JobOrderByWithRelationInput[];

/**
 * Read side of the async import flow: resolves batchIds (returned by
 * POST /games/import) to the per-job states persisted on the Job rows,
 * plus a derived batch rollup. Runs in the API process against Postgres
 * only — the polling hot path touches neither Redis nor the coordinator,
 * and queries are covered by the Job.batchId / Job.[userId, type] indexes.
 */
@Injectable()
export class GameImportStatusService {
  constructor(
    private readonly db: DatabaseService,
    private readonly abilityService: AbilityService,
    private readonly scopeComposer: ScopeComposer,
  ) {}

  /**
   * Every job of one import batch. Not scoped to the acting user: any
   * signed-in user may poll any batch, and a session's `Job` ceiling admits
   * every import job. The ceiling still clips the read (#515), so an actor it
   * admits none of the batch's jobs to gets the same 404 as an unknown batch.
   */
  async getBatchStatus(batchId: string): Promise<ImportBatchStatusResponseDto> {
    const jobs = await this.db.job.findMany({
      where: this.scopeComposer.compose(ResourceType.Job, Action.read, { batchId, type: JobType.GameImport }),
      orderBy: BATCH_JOB_ORDER,
      select: JOB_SELECT,
    });

    if (jobs.length === 0) {
      throw new NotFoundException(t('errors.game_import.batch_not_found', { batchId }));
    }

    return this.toBatchDto(batchId, jobs);
  }

  /**
   * The initiating user's import batches, most recently started first.
   * This is how a client recovers batch/job ids it no longer holds
   * (page refresh, reinstall) — the create-time response is the only
   * other place they appear.
   *
   * The scope is the acting user's base import jobs, and the `Job` ceiling
   * clips it (#515). For a session nothing changes. For an API key scoped to
   * some jobs, the page lists only the batches whose base job the key may
   * read, each with only the jobs it may read, and `total` counts just those
   * batches. A key that admits an expansion but not its base job lists no
   * batch for it, so the narrowing fails closed.
   *
   * `resolveScopeSubjectId` refuses `plugin`, `system` and `external` actors:
   * "my imports" has no meaning without a user, and the refusal must never
   * soften into an empty page. PROVISIONAL — #395.
   */
  async listBatchesForUser(pagination: PaginationQueryDto): Promise<PaginatedRows<ImportBatchStatusResponseDto>> {
    const userId = resolveScopeSubjectId(this.abilityService);
    const baseJobs = this.scopeComposer.compose(ResourceType.Job, Action.read, batchBaseJobs(userId));

    /**
     * All three statements run in ONE interactive REPEATABLE READ transaction,
     * rather than the array form the other paginated reads use, because the
     * third depends on the first: the job rows are fetched by the batchIds the
     * page resolved. Under separate snapshots a job deleted between them would
     * yield a batch with no jobs. One snapshot removes the possibility instead
     * of tolerating it, and it is also what makes `total` describe the same set
     * of batches the rows came from.
     */
    return this.db.$transaction(
      async (tx) => {
        const bases = await tx.job.findMany({
          where: baseJobs,
          select: { batchId: true },
          // The base job is the batch's first row, so its createdAt is when the
          // batch started. `id` breaks ties, so batches started in the same
          // millisecond hold their place across page boundaries.
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: pagination.skip,
          take: pagination.pageSize,
        });

        const total = await tx.job.count({ where: baseJobs });
        const batchIds = bases.map((base) => base.batchId).filter((id): id is string => id !== null);

        if (batchIds.length === 0) {
          return { rows: [], total };
        }

        // userId is redundant today — batchId is a fresh UUID minted per enqueue
        // call and never shared across users — but costs nothing and guards
        // against ever mixing another user's rows into this user-scoped view.
        const rows = await tx.job.findMany({
          where: this.scopeComposer.compose(ResourceType.Job, Action.read, {
            batchId: { in: batchIds },
            type: JobType.GameImport,
            userId,
          }),
          orderBy: BATCH_JOB_ORDER,
          select: JOB_SELECT,
        });

        const rowsByBatch = new Map<string, JobRow[]>();
        for (const row of rows) {
          if (row.batchId === null) {
            continue;
          }
          const bucket = rowsByBatch.get(row.batchId) ?? [];
          bucket.push(row);
          rowsByBatch.set(row.batchId, bucket);
        }

        // batchIds carries the page's order. Every id came from a base job the
        // ceiling admitted in this same snapshot, and the job fetch is clipped
        // by the same ceiling, so each lookup holds at least that base job.
        return {
          rows: batchIds.map((batchId) => this.toBatchDto(batchId, rowsByBatch.get(batchId) ?? [])),
          total,
        };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        // The array form the sibling reads use takes no timeout; the callback
        // form inherits Prisma's 5s default, which this read has to raise. It
        // was two untimed queries before #372, so a user with a long import
        // history — exactly the caller this recovery route exists for — would
        // trade a slow response for a P2028 500.
        //
        // The ceiling stays on the request path rather than being removed with
        // the transaction, and that is the trade being made: an interactive
        // transaction holds a pooled connection and an open snapshot for as
        // long as it runs. Dropping it would return the count to a separate
        // snapshot from the page, which is the defect the transaction is here
        // for. So the hold is accepted and bounded instead. 15s is a ceiling,
        // not a budget — the read is a paged, indexed scan of the user's base
        // jobs plus a count of them. Whether that holds for a user's whole
        // history is #411's to measure.
        timeout: 15_000,
      },
    );
  }

  private toBatchDto(batchId: string, jobs: JobRow[]): ImportBatchStatusResponseDto {
    const basePayload = (jobs.find((job) => job.parentJobId === null)?.payload ?? {}) as { correlationId?: string };

    return {
      batchId,
      correlationId: basePayload.correlationId ?? '',
      status: deriveBatchStatus(jobs.map((job) => job.status)),
      jobs: jobs.map((job) => this.toJobDto(job)),
    };
  }

  private toJobDto(job: JobRow): ImportJobStatusDto {
    const payload = (job.payload ?? {}) as { externalId?: string; expansionExternalIds?: string[] };
    const result = (job.result ?? undefined) as Partial<PersistedJobResult & PersistedJobFailure> | undefined;

    return {
      jobId: job.id,
      status: job.status as JobStatus,
      isExpansion: job.parentJobId !== null,
      parentJobId: job.parentJobId,
      // Present on base rows (the coordinator snapshots the requested set on the
      // base payload). Lets the graph show expansions not yet spawned — or never
      // spawned, if the base failed — as pending/skipped nodes off the base.
      requestedExpansions: payload.expansionExternalIds,
      externalId: payload.externalId ?? '',
      gameId: job.gameId ?? result?.gameId,
      gameTitle: result?.gameTitle,
      thumbnail: result?.thumbnail,
      platformGames: result?.platformGames,
      errorCode: result?.errorCode,
      // Translated from the machine-readable `errorCode`, not the English `error`
      // the worker persisted at failure time, so it renders in the reader's
      // locale. Marker cast to the DTO's string field: I18nResponseInterceptor
      // renders it to a string before serialization, so the wire value is a string.
      error: result?.errorCode ? (importErrorMarker(result.errorCode) as unknown as string) : undefined,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
    };
  }
}
