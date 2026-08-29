import { DatabaseService, JobStatus, JobType, Prisma } from '@bge/database';
import { t, type I18nPath } from '@bge/i18n';
import type { PaginatedRows, PaginationQueryDto } from '@bge/shared';
import { Injectable, NotFoundException } from '@nestjs/common';
import type { ImportBatchStatusResponseDto, ImportJobStatusDto } from '../dto/import-status.dto';
import type { PersistedJobFailure, PersistedJobResult } from '../interfaces/import-job.interface';
import { deriveBatchStatus } from '../utils/batch-status';
import { ImportErrorCode } from '../utils/sanitize-import-error';

/**
 * Maps the stable failure classification to its catalog key. The read-back
 * endpoint translates from the machine-readable `errorCode` (not the English
 * `error` string persisted at failure time in the worker), so the message is
 * localized per HTTP request by `I18nResponseInterceptor`. The worker-emitted
 * surfaces (notification, webhook) still carry the static English copy — see
 * #188 for finishing those.
 */
const IMPORT_FAILURE_MESSAGE_KEYS = {
  [ImportErrorCode.NotFound]: 'errors.game_import.failure.not_found',
  [ImportErrorCode.GatewayError]: 'errors.game_import.failure.gateway_error',
  [ImportErrorCode.InternalError]: 'errors.game_import.failure.internal_error',
  [ImportErrorCode.BaseImportFailed]: 'errors.game_import.failure.base_import_failed',
} as const satisfies Record<ImportErrorCode, I18nPath>;

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
 * The user's import batches: every GameImport job of theirs that belongs to a
 * batch. The scope of the page.
 *
 * It is NOT the only statement of that predicate, and saying otherwise would be
 * the more dangerous comment: `countBatchesForUser` re-states it in raw SQL,
 * because a `COUNT(DISTINCT …)` cannot be expressed as a Prisma `where`. So the
 * two are coupled by agreement rather than by construction — add a clause here
 * and `total` keeps counting batches the page can no longer reach.
 *
 * Exported for the regression test that holds them in step: it reads the keys
 * of this object and requires the raw statement to constrain each one, so a new
 * clause fails until the SQL grows it too.
 */
export const BATCH_SCOPE = (userId: string) =>
  ({ userId, type: JobType.GameImport, batchId: { not: null } }) satisfies Prisma.JobWhereInput;

/**
 * Base job first (parentJobId null), then expansions. All rows of a batch are
 * created in one transaction and share an identical createdAt (Postgres holds
 * CURRENT_TIMESTAMP constant within a transaction), so createdAt cannot order
 * them; id breaks ties deterministically.
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
  constructor(private readonly db: DatabaseService) {}

  async getBatchStatus(batchId: string): Promise<ImportBatchStatusResponseDto> {
    const jobs = await this.db.job.findMany({
      where: { batchId, type: JobType.GameImport },
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
   */
  async listBatchesForUser(
    userId: string,
    pagination: PaginationQueryDto,
  ): Promise<PaginatedRows<ImportBatchStatusResponseDto>> {
    /**
     * All three statements run in ONE interactive REPEATABLE READ transaction,
     * rather than the array form the other paginated reads use, because the
     * third depends on the first: the job rows are fetched by the batchIds the
     * groupBy resolved. Under separate snapshots a job deleted between them
     * would yield a batch with no jobs — the case the old code carried a
     * `jobs.length > 0` filter for. One snapshot removes the possibility
     * instead of tolerating it, and it is also what makes `total` describe the
     * same set of batches the rows came from.
     */
    return this.db.$transaction(
      async (tx) => {
        const groups = await tx.job.groupBy({
          by: ['batchId'],
          where: BATCH_SCOPE(userId),
          _max: { createdAt: true },
          // batchId tiebreaker: batches sharing a _max(createdAt) would otherwise
          // shift across page boundaries between requests.
          orderBy: [{ _max: { createdAt: 'desc' } }, { batchId: 'desc' }],
          skip: pagination.skip,
          take: pagination.pageSize,
        });

        const total = await this.countBatchesForUser(tx, userId);
        const batchIds = groups.map((group) => group.batchId).filter((id): id is string => id !== null);

        if (batchIds.length === 0) {
          return { rows: [], total };
        }

        // userId is redundant today — batchId is a fresh UUID minted per enqueue
        // call and never shared across users — but costs nothing and guards
        // against ever mixing another user's rows into this user-scoped view.
        const rows = await tx.job.findMany({
          where: { batchId: { in: batchIds }, type: JobType.GameImport, userId },
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

        // batchIds carries the recency ordering from the groupBy. Every id came
        // from a group of at least one job in this same snapshot, so each lookup
        // is non-empty by construction.
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
        // snapshot from the groups, which is the defect the transaction is
        // here for, and would bring back the empty-batch case the removed
        // `jobs.length > 0` filter used to paper over. So the hold is accepted
        // and bounded instead. 15s is a ceiling, not a budget — the read is a
        // paged groupBy plus an indexed count. What actually makes this route
        // scale with a user's whole history is the groupBy itself, which is
        // #411, and the number here is a guess until that is measured.
        timeout: 15_000,
      },
    );
  }

  /**
   * How many import batches the user has, for the envelope's `total`.
   *
   * Raw SQL because a batch is a GROUP, not a row: `groupBy` has no
   * count-of-groups, and the alternatives both scale with the user's whole
   * history rather than with a page — a second unpaged `groupBy`, or a
   * `findMany({ distinct })`, each materialise every batch the user has ever
   * run in order to count them, which is the unbounded read #372 exists to
   * remove. `COUNT(DISTINCT batch_id)` does it in the database, over the
   * `Job.[userId, type]` index.
   *
   * Cast to `int` in SQL: Postgres `COUNT` is `bigint`, which the driver hands
   * back as a JS BigInt, and `Math.ceil(total / pageSize)` on a BigInt throws.
   */
  private async countBatchesForUser(tx: Pick<DatabaseService, '$queryRaw'>, userId: string): Promise<number> {
    // Hand-written twin of {@link BATCH_SCOPE}: user, job type, and "belongs to
    // a batch". Any clause added there has to be added here, or `total` and the
    // page describe different sets — the spec enforces the pairing.
    const counted = await tx.$queryRaw<{ total: number }[]>(Prisma.sql`
      SELECT COUNT(DISTINCT batch_id)::int AS total
      FROM jobs
      WHERE user_id = ${userId}
        AND type = CAST(${JobType.GameImport} AS job_types)
        AND batch_id IS NOT NULL
    `);

    // A COUNT always returns exactly one row; the tuple type above is a claim
    // the compiler cannot check, so the absence is handled rather than asserted.
    return counted[0]?.total ?? 0;
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
      // Marker cast to the DTO's string field: I18nResponseInterceptor renders it
      // to a localized string before serialization, so the wire value is a string.
      error: result?.errorCode ? (t(IMPORT_FAILURE_MESSAGE_KEYS[result.errorCode]) as unknown as string) : undefined,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
    };
  }
}
