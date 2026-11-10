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
  /**
   * Canonical IETF BCP 47 tag ("en-US", "zh-Hant") — the system's preferred
   * language identifier. Always present for local results; may be absent on
   * results from gateways that only publish names or ISO codes.
   */
  tag?: string;
  iso6393?: string;
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

  /**
   * Every base game the DataGateway says this add-on fits, primary first.
   * Empty for a game that names none, and on a result from the game catalog
   * itself (#971).
   */
  baseGameExternalIds: string[];
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

  /**
   * Play time in minutes (#869). A game may carry just one of the two, and
   * that one is then its whole play time.
   */
  maxPlayTime?: number;
  minPlayTime?: number;

  platforms: WsPlatformData[];
  sourceUrl?: string;

  /**
   * Markdown, converted by the coordinator from the DataGateway's content
   * format (#714). Results from the game catalog have none: the server doesn't store it (#862).
   */
  summary?: string;

  /**
   * The game's thumbnail. No DataGateway sends alt text for it, so the title
   * labels it (#880).
   */
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

/**
 * A DataGateway the search's filter skipped (#869): it can't filter by a
 * player-count or play-time range the search gave without keeping unknown
 * values, so it wasn't asked. It is that DataGateway's last frame.
 */
export interface WsSourceUnfilterablePayload {
  correlationId: string;
  source: string;
}
