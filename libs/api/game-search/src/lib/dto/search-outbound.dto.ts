export interface WsSearchResultPayload {
  correlationId: string;
  games: WsGameSearchResult[];

  /**
   * gatewayId or 'local'
   */
  source: string;
}

export interface WsPlatformData {
  externalId: string | undefined;
  name: string;
  abbreviation?: string;
  platformType: string;
}

export interface WsLanguageData {
  iso6393: string;
  iso6391?: string;
  name: string;
}

export interface WsReleaseData {
  externalId: string;
  platform: WsPlatformData;
  status: string;
  releaseDate?: string;
  languages: WsLanguageData[];
}

export interface WsGameSearchResult {
  availableReleases: WsReleaseData[];
  averageRating?: number;
  baseGameExternalId?: string;
  contentType: string;
  externalId: string;

  /**
   * local DB Game.id when inSystem = true
   */
  gameId?: string;

  /**
   * Deduplication metadata resolved by coordinator
   */
  inSystem: boolean;

  maxPlayers?: number;
  minPlayers?: number;
  platforms: WsPlatformData[];
  sourceUrl?: string;
  thumbnailUrl?: string;
  title: string;
  yearPublished?: number;
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
  message: string;
  source: string;
}

export interface WsRateLimitedPayload {
  correlationId: string;
  message: string;
  source: string;
  retryAfter: number; // seconds
}

export interface WsSourceUnavailablePayload {
  correlationId: string;
  source: string;
}
