import { defer, from } from 'rxjs';
import { map, mergeMap, skip, take, toArray } from 'rxjs/operators';
import type { BggRequest } from '../bgg/bgg.service';
import { BggThingType, DEFAULT_BGG_SEARCH_TYPES, DEFAULT_SEARCH_LIMIT } from '../constants';
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
}

/**
 * Search BGG for things matching a free-text query.
 *
 * BGG's `/search` endpoint does not paginate server-side; `limit` is
 * applied client-side after the response is received.
 *
 * The `defer` wrapper ensures the underlying HTTP call is re-issued on
 * each subscription — required so `BggService.call` can retry a 429
 * cleanly by re-subscribing.
 */
export function searchGamesRequest(
  query: string,
  limit: number = DEFAULT_SEARCH_LIMIT,
  offset = 0,
  types: readonly BggThingType[] = DEFAULT_BGG_SEARCH_TYPES,
): BggRequest<BggSearchItem[]> {
  return (client) =>
    defer(() =>
      client.search.query({
        query,
        type: normalizeTypes(types),
      }),
    ).pipe(
      map((result) => result.flatMap((result) => result.items)),
      mergeMap((items) => {
        const kindaOffset = offset ?? 0;
        const actualOffset = kindaOffset > items.length ? kindaOffset - items.length : kindaOffset;

        return from(items).pipe(skip(actualOffset));
      }),
      take(limit),
      toArray(),
    );
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
