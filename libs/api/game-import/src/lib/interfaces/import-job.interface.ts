import type { InitiatorType } from '@bge/database';
import type { GameData } from '@board-games-empire/proto-gateway';

/**
 * Payload stored in BullMQ for a base game import.
 * GameData is JSON-safe (no int64 fields in the proto).
 */
export interface GameImportJobPayload {
  /**
   * Groups base + all its expansion children
   */
  batchId: string;

  /**
   * Socket.io room to route WS progress events
   */
  correlationId: string;

  /**
   * BGE Job.id — used to update status and drive WS events
   */
  jobId: string;

  initiatorType: InitiatorType;
  gatewayId: string;

  /**
   * Full GameData proto payload, serialized as plain JSON
   */
  gameData: GameData;

  userId: string | null;
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
