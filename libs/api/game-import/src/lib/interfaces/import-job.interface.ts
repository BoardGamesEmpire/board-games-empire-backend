import type { InitiatorType } from '@bge/database';
import type { ImportErrorCode } from '../utils/sanitize-import-error';

/**
 * Common fields shared by every job in the import flow. The DB Job row
 * is the user-facing tracking entity; one row per game-being-imported
 * (base + each expansion).
 */
interface JobContext {
  /**
   * Groups base + all expansion children
   */
  batchId: string;

  /**
   * Socket.io room and tracing correlation
   */
  correlationId: string;

  /**
   * BGE Job.id — drives status updates and WS events
   */
  jobId: string;

  initiatorType: InitiatorType;
  gatewayId: string;
  userId: string | null;
}

/**
 * Payload for GameFetch / ExpansionFetch jobs. Carries only what the
 * fetch processor needs to make the gateway call. The processor's
 * return value (GameData) is read by the parent import job via
 * getChildrenValues().
 */
export interface GameFetchJobPayload extends JobContext {
  externalId: string;
  locale?: string;
}

export interface ExpansionFetchJobPayload extends GameFetchJobPayload {
  baseGameExternalId: string;
}

/**
 * Payload for GameImport / ExpansionImport jobs. Notably does NOT
 * carry GameData — the import processor reads it from its fetch
 * child's return value.
 */
export interface GameImportJobPayload extends JobContext {
  externalId: string;

  /**
   * External ids of expansions to co-import once this base game persists.
   * Base jobs only. The base import processor spawns one expansion flow per id
   * *after* the base source exists, so expansions never run before their base
   * (the ordering bug this replaces). Empty/absent on expansion jobs.
   */
  expansionExternalIds?: string[];

  /**
   * Locale forwarded to the expansion fetch jobs this base spawns. Base jobs
   * only; expansion fetch payloads carry their own locale directly.
   */
  locale?: string;
}

export interface ExpansionImportJobPayload extends GameImportJobPayload {
  /**
   * externalId of the base game on the same platform.
   * Used to resolve the base Game.id via GameSource after the parent job completes.
   */
  baseGameExternalId: string;
}

/**
 * PlatformGame ids created/resolved for the imported game — one per
 * platform the gateway reported. Collections (and everything else
 * downstream of the client's "add to collection" step) key on
 * PlatformGame.id, so the import pipeline surfaces them rather than
 * forcing clients to re-derive them from gameId.
 */
export interface PlatformGameRef {
  platformId: string;
  platformGameId: string;
}

export interface ImportJobResult {
  /**
   * True when the Game row was created for the first time (not a re-import)
   */
  gameCreated: boolean;

  gameId: string;

  platformGames: PlatformGameRef[];

  /**
   * True when this specific gatewayId+externalId GameSource was new
   */
  sourceCreated: boolean;

  /**
   * Resolved DB id of the base game — only set for expansion imports
   */
  baseGameId?: string;
}

/**
 * Shape persisted to Job.result on completion — the durable summary the
 * REST status endpoint (GET /games/import/:batchId) returns to clients.
 */
export interface PersistedJobResult {
  gameId: string;
  gameTitle: string;
  thumbnail: string | null;
  platformGames: PlatformGameRef[];
}

/**
 * Shape persisted to Job.result on terminal failure — sanitized code +
 * static message, safe for the REST status endpoint. `GET
 * /games/import/:batchId` is deliberately not owner-scoped (imported games
 * are public), so its audience is exactly as broad as a webhook
 * subscriber's; the raw `Job.error` column (which can carry gRPC transport
 * detail, internal hostnames, Prisma error text) is written for operator
 * debugging only and must never be serialized into an API response.
 */
export interface PersistedJobFailure {
  errorCode: ImportErrorCode;
  error: string;
}

/**
 * Emitted once per batch when every Job row in the batch has reached a
 * terminal status. Emission is best-effort-exactly-once: two jobs
 * finishing concurrently in different processes can both observe the
 * batch as terminal and double-emit; webhook delivery dedups via the
 * batchId occurrenceId, in-process listeners must tolerate a duplicate.
 */
export interface ImportBatchCompletedEvent {
  batchId: string;
  baseJobId: string;
  correlationId: string;
  status: ImportBatchStatus;
  counts: ImportBatchCounts;
  userId: string | null;
}

export interface ImportBatchCounts {
  total: number;
  completed: number;
  failed: number;
  cancelled: number;
}

/**
 * Batch-level rollup derived from the statuses of a batch's Job rows.
 * Terminal states: Completed, PartiallyCompleted, Failed, Cancelled.
 */
export enum ImportBatchStatus {
  /** No job has started yet */
  Pending = 'Pending',
  /** At least one job is still Pending/Running */
  Running = 'Running',
  /** Every job completed successfully */
  Completed = 'Completed',
  /** All jobs terminal; some completed, some failed/cancelled */
  PartiallyCompleted = 'PartiallyCompleted',
  /** All jobs terminal; none completed, at least one failed */
  Failed = 'Failed',
  /** Every job was cancelled */
  Cancelled = 'Cancelled',
}
