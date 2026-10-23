import type * as proto from '@boardgamesempire/proto-gateway';
import { defer } from 'rxjs';
import { map } from 'rxjs/operators';
import type { BggRequest } from '../bgg/bgg.service';
import { BggThingType, DEFAULT_BGG_SEARCH_TYPES, DEFAULT_SEARCH_LIMIT } from '../constants';
import { toPublishYear } from '../mappers/game.mapper';
import type { BggSearchItem, BggThing } from '../types';

/**
 * Common options for `/thing` endpoint requests.
 */
export interface ThingFetchOptions {
  /**
   * `stats=1` enables the `statistics.ratings` block — required for
   * full GameData mapping but unnecessary for lean expansion search
   * frames.
   */
  stats?: 0 | 1;

  /**
   * Restricts the response to the given thing types. BGG requires this
   * to disambiguate ids that exist across multiple domains.
   */
  types: readonly BggThingType[];

  /**
   * Request edition/version data (BGG `versions=1`).
   */
  versions?: 0 | 1;
}

/**
 * Search BGG for things matching a free-text query, keeping the thing types
 * in `keep`, and the games published within `publishYear` when it's given.
 *
 * BGG is always asked for base games and expansions together. Asked for base
 * games alone, it returns expansions labelled as base games; asked for both,
 * it answers an expansion twice, once under each label. So the items are
 * collapsed to one per game, then filtered to `keep` and to the publish year,
 * and only then paged, so that `offset` and `limit` count distinct games that
 * match (#777, #719).
 *
 * BGG's `/search` endpoint does not paginate server-side; `offset` and
 * `limit` are applied client-side after the response is received.
 *
 * The `defer` wrapper ensures the underlying HTTP call is re-issued on
 * each subscription — required so `BggService.call` can retry a 429
 * cleanly by re-subscribing.
 */
export function searchGamesRequest(
  query: string,
  limit: number = DEFAULT_SEARCH_LIMIT,
  offset = 0,
  keep: readonly BggThingType[] = DEFAULT_BGG_SEARCH_TYPES,
  publishYear?: proto.IntRange,
): BggRequest<BggSearchItem[]> {
  const kept = new Set<string>(keep);
  const inYearRange = publishYearMatcher(publishYear);

  return (client) =>
    defer(() =>
      client.search.query({
        query,
        type: [...DEFAULT_BGG_SEARCH_TYPES],
      }),
    ).pipe(
      map((results) =>
        collapseSearchItems(results.flatMap((result) => result.items))
          .filter((item) => kept.has(item.type) && inYearRange(item))
          .slice(offset, offset + limit),
      ),
    );
}

/**
 * Whether an item falls within a publish-year range, both bounds inclusive.
 * An item with no year, which BGG writes as 0, matches only when the range
 * includes unknown ones. A range with no bound matches every item, as the
 * server reads it (#719).
 */
function publishYearMatcher(range: proto.IntRange | undefined): (item: BggSearchItem) => boolean {
  const min = range?.min ?? undefined;
  const max = range?.max ?? undefined;

  if (min === undefined && max === undefined) {
    return () => true;
  }

  return (item) => {
    const year = toPublishYear(item.yearpublished);

    if (year === undefined) {
      return range?.includeUnknown === true;
    }

    return (min === undefined || year >= min) && (max === undefined || year <= max);
  };
}

/**
 * One entry per BGG id, at the position of that id's first copy. An id is an
 * expansion when any copy is labelled one, since BGG also answers expansions
 * as base games (#777). Otherwise it keeps its first copy's type.
 */
export function collapseSearchItems(items: readonly BggSearchItem[]): BggSearchItem[] {
  const byId = new Map<number, BggSearchItem>();

  for (const item of items) {
    const first = byId.get(item.id);

    if (!first) {
      byId.set(item.id, item);
    } else if (item.type === BggThingType.BoardGameExpansion && first.type !== BggThingType.BoardGameExpansion) {
      byId.set(item.id, { ...first, type: BggThingType.BoardGameExpansion });
    }
  }

  return [...byId.values()];
}

/**
 * Fetch a single BGG thing by numeric id, or `undefined` when the id is
 * not present in BGG's catalog.
 */
export function fetchThingRequest(id: number, options: ThingFetchOptions): BggRequest<BggThing | undefined> {
  return (client) =>
    defer(() =>
      client.thing.query({
        id,
        type: normalizeTypes(options.types),
        stats: options.stats,
        versions: options.versions,
      }),
    ).pipe(map((results) => results[0]));
}

/**
 * Fetch a batch of BGG things by ids in a single request.
 *
 * The caller is responsible for keeping `ids.length` at or below
 * `MAX_THINGS_PER_BATCH` — splitting larger lists is the orchestrator's
 * job (in the gateway service), so each batch can flow through its own
 * `BggService.call()` for independent retry treatment.
 */
export function fetchThingsRequest(ids: readonly number[], options: ThingFetchOptions): BggRequest<BggThing[]> {
  return (client) =>
    defer(() =>
      client.thing.query({
        id: [...ids],
        type: normalizeTypes(options.types),
        stats: options.stats,
        versions: options.versions,
      }),
    );
}

/**
 * BGG accepts either a single string or an array for the `type`
 * parameter. We pick the more compact form when only one type is
 * needed.
 */
function normalizeTypes(types: readonly BggThingType[]): BggThingType | BggThingType[] {
  return types.length === 1 ? types[0] : [...types];
}

/**
 * Validate and parse a stringified BGG thing id from the proto request
 * envelope into a positive integer.
 *
 * Errors are thrown synchronously for use inside `defer(() => ...)`
 * factories — they will surface as Observable errors rather than
 * unhandled exceptions when the request is subscribed.
 */
export function parseExternalId(externalId: string): number {
  const id = Number(externalId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`Invalid BGG externalId: '${externalId}' — expected positive integer`);
  }
  return id;
}

/**
 * Pure helper. Splits an array into fixed-size chunks. Returns `[]` for
 * empty input.
 */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) {
    throw new Error(`chunk size must be positive, got ${size}`);
  }
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
