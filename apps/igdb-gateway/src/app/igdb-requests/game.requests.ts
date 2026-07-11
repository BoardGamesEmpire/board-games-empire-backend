import { GameType } from '../constants';
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
  'cover.url',
  'expansions',
  'first_release_date',
  'game_status',
  'game_type',
  'id',
  'language_supports.language.*',
  'name',
  'parent_game',
  'platforms.abbreviation',
  'platforms.name',
  'platforms.platform_type',
  'standalone_expansions',
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
 * Escapes a user-supplied search term for the apicalypse `search "<q>"` clause.
 *
 * The builder interpolates the raw string between double quotes, so an
 * unescaped `"` closes the string early — turning a valid query into an IGDB
 * 400 (and, worse, allowing arbitrary apicalypse clauses to be injected).
 * Backslashes are escaped first so the quote-escaping backslash can't itself
 * be consumed.
 */
function escapeSearchQuery(query: string): string {
  return query.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Search IGDB for games matching a query string.
 *
 * `version_parent = null` excludes alternate versions (regional, GOTY, etc.)
 * from search results — they clutter results without adding meaningful
 * information at the search stage.
 */
export function searchGamesRequest(query: string, limit = 20, offset = 0, locale?: string): IgdbRequest<IgdbGame[]> {
  return (client: IGDBClient) => {
    const builder = client.fields(GAME_SEARCH_FIELDS).search(escapeSearchQuery(query));
    return includeLanguageFilter(builder, locale, `version_parent = null & game_type != ${GameType.Update}`)
      .limit(limit)
      .offset(offset)
      .request<IgdbGame>(GAMES_ENDPOINT)
      .then((response) => response.data);
  };
}

/**
 * Applies the mandatory `whereQuery` (e.g. `id = '...'`) and, when a locale
 * resolves to known IGDB language IDs, an additional language-support filter.
 *
 * The `whereQuery` is always preserved: an unmapped locale (e.g. 'fr-CA',
 * 'en-AU') simply contributes no language clause. Previously an empty language
 * result short-circuited and dropped `whereQuery` entirely, which let the
 * mandatory id/parent_game filter fall away — fetching an arbitrary game or
 * returning up to 50 unrelated expansions.
 */
function includeLanguageFilter(builder: IGDBClient, locale?: string, whereQuery?: string): IGDBClient {
  const languageIds = locale ? resolveLanguageIds(locale) : [];

  const clauses = [whereQuery];
  if (languageIds.length > 0) {
    clauses.push(`(language_supports.language = (${languageIds.join(',')}) | language_supports.language = null)`);
  }

  const where = clauses.filter(Boolean).join(' & ');

  return where ? builder.where(where) : builder;
}

/**
 * Fetch a single game by its IGDB numeric id, returning full GameData fields.
 */
export function fetchGameRequest(externalId: string, locale?: string): IgdbRequest<IgdbGame[]> {
  return (client: IGDBClient) => {
    const builder = client.fields(GAME_FETCH_FIELDS);
    return includeLanguageFilter(builder, locale, `id = '${externalId}'`)
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
    const builder = client.fields(GAME_SEARCH_FIELDS);

    return includeLanguageFilter(
      builder,
      locale,
      `(parent_game = '${baseExternalId}' | version_parent = '${baseExternalId}')`,
    )
      .limit(50)
      .request<IgdbGame>(GAMES_ENDPOINT)
      .then((response) => response.data);
  };
}
