import type { InitiatorType } from '@bge/database';
import type { ImportErrorCode } from '../utils/sanitize-import-error';

/**
 * Why an import job is in its import batch (#971). Whether its game is an
 * expansion is a separate matter, read from its content type and its base
 * games.
 */
export enum ImportJobOrigin {
  /** The game the import request asked for. */
  Requested = 'Requested',
  /** An expansion chosen with the requested game. */
  ChosenExpansion = 'ChosenExpansion',
  /** A base game the server added because a game in the batch needed it. */
  AddedBaseGame = 'AddedBaseGame',
}

/**
 * Common fields shared by every job in the import flow. The DB Job row
 * is the user-facing tracking entity; one row per game-being-imported
 * (the requested game, each chosen expansion, and any added base game).
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

  gatewayId: string;
  initiatorType: InitiatorType;

  /**
   * BGE Job.id — drives status updates and WS events
   */
  jobId: string;

  /** Why the job is in its batch. Also stored on its Job row's payload. */
  origin: ImportJobOrigin;

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
  requestedExternalId: string;
}

/**
 * Payload for GameImport / ExpansionImport jobs. Notably does NOT
 * carry GameData — the import processor reads it from its fetch
 * child's return value.
 */
export interface GameImportJobPayload extends JobContext {
  /**
   * External ids of expansions to co-import once this base game persists.
   * Base jobs only. The base import processor spawns one expansion flow per id
   * *after* the base source exists, so expansions never run before their base
   * (the ordering bug this replaces). Empty/absent on expansion jobs.
   */
  expansionExternalIds?: string[];

  externalId: string;

  /**
   * Locale forwarded to the expansion fetch jobs this base spawns. Base jobs
   * only; expansion fetch payloads carry their own locale directly.
   */
  locale?: string;
}

export interface ExpansionImportJobPayload extends GameImportJobPayload {
  /**
   * External id of the requested game this expansion was chosen with, on the
   * same DataGateway. Linked as its base game only when the DataGateway names
   * none (#971).
   */
  requestedExternalId: string;
}

/**
 * PlatformGame ids created/resolved for the imported game — one per
 * platform the gateway reported. Collections (and everything else
 * downstream of the client's "add to collection" step) key on
 * PlatformGame.id, so the import pipeline surfaces them rather than
 * forcing clients to re-derive them from gameId.
 */
export interface PlatformGameRef {
  platformGameId: string;
  platformId: string;
}

export interface ImportJobResult {
  /**
   * The base games the game is linked to, in the order its DataGateway named
   * them. Empty for a game linked to none (#971).
   */
  baseGameIds: string[];

  /**
   * External id of the base game to add to the import batch: set when the
   * game needs a base game and none of those its DataGateway names is in the
   * game catalog (#971).
   */
  baseGameToAdd?: string;

  /**
   * True when the Game row was created for the first time (not a re-import)
   */
  gameCreated: boolean;

  gameId: string;

  /**
   * True when the game is an add-on (an expansion, DLC, mod, standalone
   * expansion or accessory) with a base game: linked to one, or missing the
   * one it needs and adding it to the batch (#971).
   */
  isExpansion: boolean;

  platformGames: PlatformGameRef[];

  /**
   * True when this specific gatewayId+externalId GameSource was new
   */
  sourceCreated: boolean;
}

/**
 * Shape persisted to Job.result on completion — the durable summary the
 * REST status endpoint (GET /games/import/:batchId) returns to clients.
 */
export interface PersistedJobResult {
  gameId: string;
  gameTitle: string;
  platformGames: PlatformGameRef[];
  thumbnail: string | null;
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
  error: string;
  errorCode: ImportErrorCode;
}

/**
 * Emitted once per batch when every Job row in the batch has reached a
 * terminal status. Emission is best-effort-exactly-once: two jobs
 * finishing concurrently in different processes can both observe the
 * batch as terminal and double-emit; webhook delivery dedups via the
 * batchId occurrenceId, in-process listeners must tolerate a duplicate.
 */
export interface ImportBatchCompletedEvent {
  baseJobId: string;
  batchId: string;
  correlationId: string;
  counts: ImportBatchCounts;
  status: ImportBatchStatus;
  userId: string | null;
}

export interface ImportBatchCounts {
  cancelled: number;
  completed: number;
  failed: number;
  total: number;
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
