import { MutationEvent } from '@bge/actor-context';
import { ResourceType, type Job } from '@bge/database';
import { ImportEvents } from '../constants/queue.constants';
import type { PlatformGameRef } from '../interfaces/import-job.interface';
import type { ImportErrorCode } from '../utils/sanitize-import-error';

/**
 * Domain mutation events for import Job rows (#57 emit-site migration).
 *
 * Every event here records a guarded status transition on a BGE `Job` row
 * (subject `ResourceType.Job`, subjectId = the Job row id) and is emitted only
 * AFTER the transition write wins. Payloads carry ROW STATE (before/after
 * snapshots) plus listener-facing context fields; the acting actor, source,
 * and correlationId live in CLS — populated per BullMQ job by
 * `ActorAwareWorkerHost` and propagated through EventEmitter2 into listeners —
 * and are never carried on the payload. All events are audited by default;
 * only before/after reach the audit row, so context fields stay out of
 * persistence.
 *
 * `ImportEvents.BatchComplete` is deliberately NOT migrated: it is an
 * aggregate signal over many rows (each individually audited here), so it
 * stays a plain payload the audit listener ignores — see
 * `ImportBatchCompletionService`.
 */

type ImportJobStatusSnapshot = Readonly<Pick<Job, 'id' | 'status'>>;

/**
 * Listener-facing context shared by every import job event — display /
 * routing data, not row state, so it is never persisted to audit rows.
 */
export interface ImportJobEventContext {
  batchId: string;
  gatewayId: string;
  externalId: string;
  isExpansion: boolean;
}

/** First Pending → Running transition of a fetch job's backing Job row. */
export class ImportJobStartedEvent extends MutationEvent<Job> {
  static readonly eventName = ImportEvents.JobStarted;

  declare readonly before: ImportJobStatusSnapshot;
  declare readonly after: ImportJobStatusSnapshot;

  readonly subject = ResourceType.Job;
  readonly subjectId: string;

  readonly batchId: string;
  readonly gatewayId: string;
  readonly externalId: string;
  readonly isExpansion: boolean;

  constructor(
    before: ImportJobStatusSnapshot,
    after: ImportJobStatusSnapshot,
    context: ImportJobEventContext,
    initiatedAt: Date,
  ) {
    super(before, after, initiatedAt);
    this.subjectId = after.id;
    this.batchId = context.batchId;
    this.gatewayId = context.gatewayId;
    this.externalId = context.externalId;
    this.isExpansion = context.isExpansion;
  }
}

/**
 * `gameId` is narrowed to non-null: the completion write always stamps the
 * imported game's id onto the Job row.
 */
type ImportJobCompletedSnapshot = Readonly<Pick<Job, 'id' | 'status'> & { gameId: string }>;

export interface ImportJobCompletedContext extends ImportJobEventContext {
  gameTitle: string;
  thumbnail: string | null;
  /** True when the Game row was created for the first time (not a re-import). */
  gameCreated: boolean;
  /** True when this specific gatewayId+externalId GameSource was new. */
  sourceCreated: boolean;
  platformGames: PlatformGameRef[];
  /** Resolved DB id of the base game — only set for expansion imports. */
  baseGameId?: string;
}

/** Running → Completed transition of an import job's Job row. */
export class ImportJobCompletedEvent extends MutationEvent<Job> {
  static readonly eventName = ImportEvents.JobCompleted;

  declare readonly before: ImportJobStatusSnapshot;
  declare readonly after: ImportJobCompletedSnapshot;

  readonly subject = ResourceType.Job;
  readonly subjectId: string;

  readonly batchId: string;
  readonly gatewayId: string;
  readonly externalId: string;
  readonly isExpansion: boolean;
  readonly gameTitle: string;
  readonly thumbnail: string | null;
  readonly gameCreated: boolean;
  readonly sourceCreated: boolean;
  readonly platformGames: PlatformGameRef[];
  readonly baseGameId?: string;

  constructor(
    before: ImportJobStatusSnapshot,
    after: ImportJobCompletedSnapshot,
    context: ImportJobCompletedContext,
    initiatedAt: Date,
  ) {
    super(before, after, initiatedAt);
    this.subjectId = after.id;
    this.batchId = context.batchId;
    this.gatewayId = context.gatewayId;
    this.externalId = context.externalId;
    this.isExpansion = context.isExpansion;
    this.gameTitle = context.gameTitle;
    this.thumbnail = context.thumbnail;
    this.gameCreated = context.gameCreated;
    this.sourceCreated = context.sourceCreated;
    this.platformGames = context.platformGames;
    this.baseGameId = context.baseGameId;
  }
}

/**
 * Sanitized failure classification persisted to `Job.result` on terminal
 * failure — the SAME object the guarded transition wrote, so the audit row,
 * the webhook, the REST status endpoint, and the ImportFailed notification
 * can never disagree. The raw error text (gRPC transport detail, internal
 * hostnames, Prisma text) lives only in the `Job.error` DB column and
 * operator logs; it must never appear on this event.
 */
type FailedJobResult = { errorCode: ImportErrorCode; error: string };

type ImportJobFailedSnapshot = Readonly<Pick<Job, 'id' | 'status'> & { result: FailedJobResult }>;

/**
 * Prior status is genuinely unknown at the shared emit point (both callers'
 * guarded transitions accept Pending OR Running without reading the row), so
 * the before side records only the row identity — never a fabricated status.
 */
type ImportJobFailedBeforeSnapshot = Readonly<Pick<Job, 'id'>>;

/** Terminal → Failed transition of a job's Job row. */
export class ImportJobFailedEvent extends MutationEvent<Job> {
  static readonly eventName = ImportEvents.JobFailed;

  declare readonly before: ImportJobFailedBeforeSnapshot;
  declare readonly after: ImportJobFailedSnapshot;

  readonly subject = ResourceType.Job;
  readonly subjectId: string;

  readonly batchId: string;
  readonly gatewayId: string;
  readonly externalId: string;
  readonly isExpansion: boolean;

  constructor(
    before: ImportJobFailedBeforeSnapshot,
    after: ImportJobFailedSnapshot,
    context: ImportJobEventContext,
    initiatedAt: Date,
  ) {
    super(before, after, initiatedAt);
    this.subjectId = after.id;
    this.batchId = context.batchId;
    this.gatewayId = context.gatewayId;
    this.externalId = context.externalId;
    this.isExpansion = context.isExpansion;
  }
}
