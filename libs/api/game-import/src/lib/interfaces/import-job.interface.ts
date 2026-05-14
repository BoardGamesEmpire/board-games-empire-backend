import type { InitiatorType } from '@bge/database';

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
}

export interface ExpansionImportJobPayload extends GameImportJobPayload {
  /**
   * externalId of the base game on the same platform.
   * Used to resolve the base Game.id via GameSource after the parent job completes.
   */
  baseGameExternalId: string;
}

export interface ImportJobResult {
  /**
   * True when the Game row was created for the first time (not a re-import)
   */
  gameCreated: boolean;

  gameId: string;

  /**
   * True when this specific gatewayId+externalId GameSource was new
   */
  sourceCreated: boolean;

  /**
   * Resolved DB id of the base game — only set for expansion imports
   */
  baseGameId?: string;
}

export interface ImportJobCompletedEvent {
  /**
   * Expansion imports will include the baseGameId
   */
  baseGameId?: string;

  batchId: string;
  correlationId: string;
  externalId: string;
  gameCreated: boolean;
  gameId: string;
  gameTitle: string;
  gatewayId: string;
  isExpansion: boolean;
  jobId: string;
  sourceCreated: boolean;
  thumbnail: string | null;
  userId: string | null;
}

export interface ImportJobFailedEvent {
  batchId: string;
  correlationId: string;
  error: string;
  jobId: string;
}
