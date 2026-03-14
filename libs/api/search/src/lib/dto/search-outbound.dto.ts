export interface WsSearchResultPayload {
  correlationId: string;
  source: string; // gatewayId or 'local'
  games: WsGameSearchResult[];
}

export interface WsGameSearchResult {
  externalId: string;
  title: string;
  contentType: string;
  yearPublished?: number;
  thumbnailUrl?: string;
  sourceUrl?: string;
  averageRating?: number;
  minPlayers?: number;
  maxPlayers?: number;
  baseGameExternalId?: string;
  // Deduplication metadata resolved by coordinator
  inSystem: boolean;
  gameId?: string; // local DB Game.id when inSystem = true
}

export interface WsSourceDonePayload {
  correlationId: string;
  source: string;
}

export interface WsSearchDonePayload {
  correlationId: string;
}

export interface WsSearchErrorPayload {
  correlationId: string;
  source: string;
  message: string;
}

export interface WsRateLimitedPayload {
  correlationId: string;
  source: string;
  retryAfter: number; // seconds
  message: string;
}

export interface WsSourceUnavailablePayload {
  correlationId: string;
  source: string;
}
