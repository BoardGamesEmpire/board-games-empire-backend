import type { BggLinkType, BggNameType, BggThingType } from '../constants';

/**
 * Shapes returned by the BoardGameGeek XML API 2 (after JSON conversion by
 * the underlying client library). Only fields requested or consumed by
 * BGE are typed here. The full schema is documented at:
 *
 * @see https://boardgamegeek.com/wiki/page/BGG_XML_API2
 */

/**
 * `name` element. A thing carries one primary name and zero or more
 * alternate names (translations / regional editions).
 */
export interface BggName {
  type: BggNameType | string;
  /**
   * Sort index used by BGG to alphabetize titles (ignoring leading articles).
   * Optional because BGG does not always populate it on alternate names.
   */
  sortindex?: number;
  value: string;
}

/**
 * `link` element. Represents a relationship to another BGG thing
 * (category, mechanic, designer, expansion, etc.).
 */
export interface BggLink {
  type: BggLinkType | string;
  id: number;
  value: string;
  /**
   * BGG returns `inbound="true"` when the link points back at this thing
   * from the related thing — used to distinguish "this game IS an expansion
   * of X" (inbound=true) from "this game HAS X as an expansion"
   * (inbound undefined / false).
   *
   * Some client libraries surface this as a boolean, others as the raw
   * string. Treat both shapes as truthy when present.
   */
  inbound?: boolean | string;
}

/**
 * Aggregated community ratings nested inside `BggStatistics`.
 * All values are optional — BGG omits them for unrated items.
 */
export interface BggRatings {
  /**
   * Raw average rating (1.0–10.0).
   */
  average?: number;
  /**
   * Bayesian-adjusted rating used for the BGG ranking.
   */
  bayesaverage?: number;
  /**
   * Total number of user ratings on file.
   */
  usersrated?: number;
  /**
   * Community-voted complexity (1.0–5.0).
   */
  averageweight?: number;
  /**
   * Number of users who voted on complexity.
   */
  numweights?: number;
}

export interface BggStatistics {
  ratings?: BggRatings;
}

/**
 * Item returned by the `/thing` endpoint.
 *
 * `links` and `names` default to empty arrays when not present in the
 * response; consumers should still tolerate the optional shape because
 * some client libraries omit empty collections entirely.
 */
export interface BggThing {
  id: number;
  type: BggThingType | string;

  thumbnail?: string;
  image?: string;
  description?: string;

  yearpublished?: number;
  minplayers?: number;
  maxplayers?: number;

  /**
   * BGG `playingtime` is the canonical play-time. `minplaytime`
   * and `maxplaytime` are sometimes populated for variable-length games.
   */
  playingtime?: number;
  minplaytime?: number;
  maxplaytime?: number;

  minage?: number;

  /**
   * Primary + alternate names. Consumers should pick the entry with
   * `type === 'primary'` for display, falling back to the first entry.
   */
  names?: BggName[];

  /**
   * Relational links — categories, mechanics, designers, expansions, etc.
   */
  links?: BggLink[];

  /**
   * Community statistics. Only populated when the request was made with
   * `stats=1`.
   */
  statistics?: BggStatistics;
}

/**
 * Item returned by the `/search` endpoint.
 *
 * Search results are intentionally lean — only enough data to render a
 * search result card client-side and trigger a follow-up `thing` query
 * for full details.
 */
export interface BggSearchItem {
  id: number;
  type: BggThingType | string;

  /**
   * Search results carry a single `name` element rather than an array.
   */
  name?: string;

  /**
   * Some client libraries surface search results with a `names` array
   * instead of a flat `name`. Both shapes are tolerated.
   */
  names?: BggName[];

  yearpublished?: number;
}

export interface BggSearchResult {
  total: number;
  items: BggSearchItem[];
}
