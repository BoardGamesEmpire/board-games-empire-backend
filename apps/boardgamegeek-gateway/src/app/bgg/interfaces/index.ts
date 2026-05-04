import type { BggSearchResult, BggThing } from '../../types';

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
 * Subset of the BoardGameGeek client surface area BGE actually calls.
 *
 * Defining this interface — rather than depending on the full type
 * surface of `bgg-ts-client` — keeps the gateway decoupled from
 * package-internal type churn and makes tests trivially mockable.
 */
export interface BggClientLike {
  thing: {
    query(params: BggThingQueryParams): Promise<BggThing[]>;
  };

  search: {
    query(params: BggSearchQueryParams): Promise<BggSearchResult[]>;
  };
}
