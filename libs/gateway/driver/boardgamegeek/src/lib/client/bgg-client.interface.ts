import type { Observable } from 'rxjs';
import type { BggSearchResult, BggThing } from '../types';

/**
 * Parameters for the BGG `/thing` endpoint.
 *
 * `id` accepts a single id or a comma-separated list (BGG returns up to
 * 20 things per call before throttling). `stats=1` enables the
 * `statistics.ratings` block. `type` filters which subtype of thing is
 * accepted — useful when querying an id that exists in multiple domains.
 */
export interface BggThingQueryParams {
  id: number | number[];
  type?: string | string[];
  stats?: 0 | 1;
  versions?: 0 | 1;
}

/**
 * Parameters for the BGG `/search` endpoint.
 *
 * `query` is the free-text search term. `type` restricts results to the
 * given thing type(s); BGG returns BoardGame + BoardGameExpansion +
 * VideoGame + RPG mixed otherwise. `exact=1` switches to an exact-name
 * match (useful for disambiguation flows).
 */
export interface BggSearchQueryParams {
  query: string;
  type?: string | string[];
  exact?: 0 | 1;
}

/**
 * The BGG queries the driver makes. `createBggClient` answers them over the
 * fetch the driver is handed, and tests stand in for it. A query's signal
 * aborts the call (#1082).
 */
export interface BggClientLike {
  thing: {
    query(params: BggThingQueryParams, signal?: AbortSignal): Promise<BggThing[]>;
  };

  search: {
    query(params: BggSearchQueryParams, signal?: AbortSignal): Promise<BggSearchResult[]>;
  };
}

/**
 * A unit of work that takes the BGG client and produces an Observable of
 * its result. Request factories must be lazy — each subscription
 * (initial or retry) re-invokes the underlying client method, typically
 * via an internal `defer(() => client.method(...))`.
 */
export type BggRequest<T> = (client: BggClientLike) => Observable<T>;
