import type { BggLinkType, BggNameType, BggThingType } from '../constants';

/**
 * Shapes returned by the BoardGameGeek XML API 2, as `parseThings` and
 * `parseSearch` read them. Only fields requested or consumed by BGE are
 * typed here. The full schema is documented at:
 *
 * @see https://boardgamegeek.com/wiki/page/BGG_XML_API2
 */

/**
 * Text as BGG sent it: still entity-encoded, and never turned into a number
 * or a boolean, so a game titled "007" keeps its name (#863). The mappers
 * pass it through `decodeText` or `decodeDescription` before sending it
 * (#716).
 */
export type BggText = string;

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

  value: BggText;
}

/**
 * `link` element. Represents a relationship to another BGG thing
 * (category, mechanic, designer, expansion, etc.).
 */
export interface BggLink {
  type: BggLinkType | string;
  id: number;

  /** Absent when BGG sends a link with no `value` attribute. */
  value?: BggText;

  /**
   * BGG returns `inbound="true"` when the link points back at this thing
   * from the related thing — used to distinguish "this game IS an expansion
   * of X" (inbound=true) from "this game HAS X as an expansion"
   * (inbound undefined / false). The string as BGG sent it.
   */
  inbound?: string;
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
 * `links` and `names` are absent when the answer has no such element.
 */
export interface BggThing {
  id: number;
  type: BggThingType | string;

  thumbnail?: string;
  image?: string;
  description?: BggText;

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
   * Primary + alternate names, each with its type, in the order BGG sent
   * them. Consumers pick the entry with `type === 'primary'` for display,
   * falling back to the first entry, since BGG's order is no promise
   * (#1082). An alternate name of "0" is kept (#863).
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

  /**
   * Populated when the thing endpoint is called with `versions=1`.
   * Absent or empty when the request did not request versions or when
   * the underlying thing has no published versions on BGG.
   */
  versions?: BggVersion[];
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
   * The name search matched, which can be an alternate one. A search result
   * carries a single `name` element rather than an array.
   */
  name?: BggText;

  yearpublished?: number;
}

export interface BggSearchResult {
  total: number;

  /** Absent when nothing matched: BGG's answer has no `<item>` (#967). */
  items?: BggSearchItem[];
}

/**
 * `version` element returned when the thing endpoint is called with
 * `versions=1`. Each version represents a published edition of the
 * underlying boardgame thing.
 *
 * The `links` array carries language and publisher associations specific
 * to this edition. BGG returns `0` as the sentinel for unknown numeric
 * fields (yearpublished, dimensions) — consumers must coerce.
 */
export interface BggVersion {
  depth: number;
  id: number;
  length: number;
  links: BggLink[];
  name: BggText;
  /** No mapper reads it yet. */
  productcode: BggText;
  type: BggThingType | string;
  weight: number;
  width: number;
  yearpublished: number;
}
