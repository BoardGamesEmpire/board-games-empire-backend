import { DatabaseService, JobStatus, JobType, Prisma } from '@bge/database';
import { t, type I18nPath } from '@bge/i18n';
import type { PaginationQueryDto } from '@bge/shared';
import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  ImportBatchListResponseDto,
  ImportBatchStatusResponseDto,
  ImportJobStatusDto,
} from '../dto/import-status.dto';
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

const DEFAULT_LIST_LIMIT = 20;

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
  async listBatchesForUser(userId: string, pagination: PaginationQueryDto): Promise<ImportBatchListResponseDto> {
    const groups = await this.db.job.groupBy({
      by: ['batchId'],
      where: { userId, type: JobType.GameImport, batchId: { not: null } },
      _max: { createdAt: true },
      // batchId tiebreaker: batches sharing a _max(createdAt) would otherwise
      // shift across page boundaries between requests.
      orderBy: [{ _max: { createdAt: 'desc' } }, { batchId: 'desc' }],
      skip: pagination.offset,
      take: pagination.limit ?? DEFAULT_LIST_LIMIT,
    });

    const batchIds = groups.map((group) => group.batchId).filter((id): id is string => id !== null);
    if (batchIds.length === 0) {
      return { batches: [] };
    }

    // userId is redundant today — batchId is a fresh UUID minted per enqueue
    // call and never shared across users — but costs nothing and guards
    // against ever mixing another user's rows into this user-scoped view.
    const rows = await this.db.job.findMany({
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

    // batchIds carries the recency ordering from the groupBy.
    return {
      batches: batchIds
        .map((batchId) => ({ batchId, jobs: rowsByBatch.get(batchId) ?? [] }))
        .filter(({ jobs }) => jobs.length > 0)
        .map(({ batchId, jobs }) => this.toBatchDto(batchId, jobs)),
    };
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
