import type { IgdbRequest } from '../igdb/igdb.service';
import type { IGDBClient } from '../igdb/interfaces';
import { resolveLanguageIds } from '../mappers/language.mapper';
import type { IgdbGame } from '../types';

const GAMES_ENDPOINT = '/games';

/**
 * Fields sufficient to populate GameSearchData (lean search result row).
 * cover.url is included here so image URLs are available without a second
 * round-trip during search streaming.
 */
export const GAME_SEARCH_FIELDS = [
  'id',
  'cover.url',
  'first_release_date',
  'game_status',
  'game_type',
  'language_supports.language.*',
  'name',
  'parent_game',
  'platforms.name',
  'platforms.abbreviation',
  'platforms.platform_type',
  'summary',
  'total_rating',
  'url',
  'version_parent',
] as const;

/**
 * Superset of GAME_SEARCH_FIELDS carrying all relational data needed by the
 * import worker to upsert a complete game record in one pass.
 */
export const GAME_FETCH_FIELDS = [
  ...GAME_SEARCH_FIELDS,
  'age_ratings.organization',
  'age_ratings.rating_category',
  'age_ratings.synopsis',
  'collections.id',
  'collections.name',
  'franchises.id',
  'franchises.name',
  'franchises.url',
  'genres.id',
  'genres.name',
  'involved_companies.company.id',
  'involved_companies.company.name',
  'involved_companies.company.websites.url',
  'involved_companies.developer',
  'involved_companies.publisher',
  'themes.id',
  'themes.name',
  'release_dates.id',
  'release_dates.date',
  'release_dates.human',
  'release_dates.region',
  'release_dates.platform.id',
  'release_dates.platform.name',
  'release_dates.platform.abbreviation',
  'release_dates.platform.platform_type',
  'total_rating_count',
] as const;

/**
 * Search IGDB for games matching a query string.
 *
 * `version_parent = null` excludes alternate versions (regional, GOTY, etc.)
 * from search results — they clutter results without adding meaningful
 * information at the search stage.
 */
export function searchGamesRequest(query: string, limit = 20, offset = 0, locale?: string): IgdbRequest<IgdbGame[]> {
  return (client: IGDBClient) => {
    const builder = client.fields(GAME_SEARCH_FIELDS).search(query).where(`version_parent = null`);
    return includeLanguageFilter(builder, locale)
      .limit(limit)
      .offset(offset)
      .request<IgdbGame>(GAMES_ENDPOINT)
      .then((response) => response.data);
  };
}

function includeLanguageFilter(builder: IGDBClient, locale?: string): IGDBClient {
  if (!locale) {
    return builder;
  }

  const languageIds = resolveLanguageIds(locale);
  if (languageIds.length === 0) {
    return builder;
  }

  return builder.where(`language_supports.language = (${languageIds.join(',')}) | language_supports.language = null`);
}

/**
 * Fetch a single game by its IGDB numeric id, returning full GameData fields.
 */
export function fetchGameRequest(externalId: string, locale?: string): IgdbRequest<IgdbGame[]> {
  return (client: IGDBClient) => {
    const builder = client.fields(GAME_FETCH_FIELDS).where(`id = '${externalId}'`);
    return includeLanguageFilter(builder, locale)
      .limit(1)
      .request<IgdbGame>(GAMES_ENDPOINT)
      .then((response) => response.data);
  };
}

/**
 * Fetch all expansions and DLC for a base game.
 *
 * The combined `parent_game | version_parent` filter captures:
 *   - DLC (category 1): parent_game set
 *   - Expansions (category 2): parent_game set
 *   - Standalone expansions (category 4): version_parent set
 */
export function fetchExpansionsRequest(baseExternalId: string, locale?: string): IgdbRequest<IgdbGame[]> {
  return (client: IGDBClient) => {
    const builder = client
      .fields(GAME_SEARCH_FIELDS)
      .where(`parent_game = '${baseExternalId}' | version_parent = '${baseExternalId}'`);

    return includeLanguageFilter(builder, locale)
      .limit(50)
      .request<IgdbGame>(GAMES_ENDPOINT)
      .then((response) => response.data);
  };
}
