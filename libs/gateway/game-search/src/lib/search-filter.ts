import { SearchFilterAxis } from '@bge/database';
import {
  type CoverageFilter,
  toCoverageFilter,
  toStoredContentType,
  toStoredPlatformType,
} from '@bge/gateway-registry';
import type * as proto from '@boardgamesempire/proto-gateway';

/**
 * An inclusive range a search filter narrows by, with at least one bound: a
 * publish year (#719), a player count or a play time in minutes (#869). A
 * game with no known value matches it only when `includeUnknown`.
 */
export interface RangeFilter {
  readonly min?: number;
  readonly max?: number;
  readonly includeUnknown: boolean;
}

/**
 * A search's filter as the server matches results against it: the coverage
 * axes, which also route the search, and the ranges, which narrow it. A range
 * doesn't route the search, but player count and play time skip a DataGateway
 * that can't apply them (#869).
 */
export interface ResultFilter extends CoverageFilter {
  readonly publishYear?: RangeFilter;
  readonly playerCount?: RangeFilter;
  readonly playTime?: RangeFilter;
}

/** A list's values, each once, in one order, so that a search reads the same however they were listed. */
const normalized = <T extends string>(values: readonly T[] | undefined): T[] => [...new Set(values ?? [])].sort();

/**
 * A number as sent, or undefined when it's missing: the gRPC loader can hand
 * over null for an unset field. It reads a range's bounds and a game's player
 * counts and play times alike.
 */
const numberOrAbsent = (value: number | undefined): number | undefined =>
  typeof value === 'number' ? value : undefined;

/**
 * A range in the server's terms, or undefined when it names no bound: a range
 * with neither narrows nothing, whatever it says of unknown values.
 */
function toRangeFilter(range: proto.IntRange | undefined): RangeFilter | undefined {
  const min = numberOrAbsent(range?.min);
  const max = numberOrAbsent(range?.max);

  if (min === undefined && max === undefined) {
    return undefined;
  }

  return {
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
    includeUnknown: range?.includeUnknown === true,
  };
}

/** A search request's filter as results are matched against it. */
export function toResultFilter(filter: proto.SearchFilter | undefined): ResultFilter {
  const publishYear = toRangeFilter(filter?.publishYear);
  const playerCount = toRangeFilter(filter?.playerCount);
  const playTime = toRangeFilter(filter?.playTime);

  return {
    ...toCoverageFilter(filter),
    ...(publishYear && { publishYear }),
    ...(playerCount && { playerCount }),
    ...(playTime && { playTime }),
  };
}

/** A range as a DataGateway is sent it: its bounds, with `includeUnknown` only when set. */
const toSentRange = ({ min, max, includeUnknown }: RangeFilter): proto.IntRange => ({
  ...(min === undefined ? {} : { min }),
  ...(max === undefined ? {} : { max }),
  ...(includeUnknown ? { includeUnknown: true } : {}),
});

/** A player-count range with both bounds, a bound alone standing for both (#869). */
const bothBounds = ({ min, max, includeUnknown }: RangeFilter): RangeFilter => ({
  min: min ?? max,
  max: max ?? min,
  includeUnknown,
});

/**
 * The part of a search's filter a DataGateway is sent: the axes its search
 * narrows by, and no others (#713). Undefined when that leaves nothing to
 * narrow by. A publish year (#719), a player count or a play time (#869) is
 * sent as its bounds, with `includeUnknown` only when set, so a range reads
 * the same however it was written.
 *
 * A player count is sent with both bounds (#869). A bound alone is one count,
 * so `{ min: 5 }`, `{ max: 5 }` and `{ min: 5, max: 5 }` are one search: sent
 * alike, they key one cache entry and cost one upstream call, and every
 * DataGateway receives both bounds rather than reading a bound alone its own
 * way. A play time is sent as given: a bound it leaves out doesn't narrow
 * that side, so it stays out.
 */
export function filterFor(
  filter: proto.SearchFilter | undefined,
  filterableAxes: readonly SearchFilterAxis[],
): proto.SearchFilter | undefined {
  const declared = (axis: SearchFilterAxis, range: proto.IntRange | undefined) =>
    filterableAxes.includes(axis) ? toRangeFilter(range) : undefined;

  const platformTypes = filterableAxes.includes(SearchFilterAxis.PlatformType) ? normalized(filter?.platformTypes) : [];
  const contentTypes = filterableAxes.includes(SearchFilterAxis.ContentType) ? normalized(filter?.contentTypes) : [];
  const publishYear = declared(SearchFilterAxis.PublishYear, filter?.publishYear);
  const playerCount = declared(SearchFilterAxis.PlayerCount, filter?.playerCount);
  const playTime = declared(SearchFilterAxis.PlayTime, filter?.playTime);

  if (platformTypes.length === 0 && contentTypes.length === 0 && !publishYear && !playerCount && !playTime) {
    return undefined;
  }

  return {
    platformTypes,
    contentTypes,
    ...(publishYear && { publishYear: toSentRange(publishYear) }),
    ...(playerCount && { playerCount: toSentRange(bothBounds(playerCount)) }),
    ...(playTime && { playTime: toSentRange(playTime) }),
  };
}

/**
 * The ranges a DataGateway can't apply (#869): each of player count and play
 * time that the search names, keeping no unknown values, and that the
 * DataGateway doesn't declare. Declaring one promises that its results carry
 * the value and that its search narrows by it. Without that, the server can't
 * count on any result passing, so asking would spend an upstream call on
 * results it would likely drop. Publish year is never named:
 * one that doesn't narrow by year still sends each result's year, and the
 * server checks it on the way out.
 */
export function unfilterableAxes(
  filter: ResultFilter,
  filterableAxes: readonly SearchFilterAxis[],
): SearchFilterAxis[] {
  const ranges = [
    [SearchFilterAxis.PlayerCount, filter.playerCount],
    [SearchFilterAxis.PlayTime, filter.playTime],
  ] as const;

  return ranges
    .filter(([axis, range]) => range !== undefined && !range.includeUnknown && !filterableAxes.includes(axis))
    .map(([axis]) => axis);
}

/** Whether a publish year falls in `range`; only a missing year is unknown. */
const inYearRange = (year: number | undefined, { min, max, includeUnknown }: RangeFilter): boolean =>
  typeof year === 'number' ? (min === undefined || year >= min) && (max === undefined || year <= max) : includeUnknown;

/**
 * Whether a game supports every player count in `range` (#869). A game
 * night's range is everyone who might come, so a bound alone is one count: a
 * minimum of 5 means "supports 5", not "5 or more". A game missing either of
 * its counts is unknown.
 */
const supportsPlayerCount = (
  minPlayers: number | undefined,
  maxPlayers: number | undefined,
  { min, max, includeUnknown }: RangeFilter,
): boolean => {
  const gameMin = numberOrAbsent(minPlayers);
  const gameMax = numberOrAbsent(maxPlayers);

  if (gameMin === undefined || gameMax === undefined) {
    return includeUnknown;
  }

  const lo = min ?? max;
  const hi = max ?? min;

  return (lo === undefined || gameMin <= lo) && (hi === undefined || hi <= gameMax);
};

/**
 * Whether a game's whole play time, in minutes, fits `range` (#869). A game
 * with one time plays that long, so it stands for both ends; only a game with
 * neither is unknown. Unlike a player count, a bound left out doesn't narrow
 * that side.
 */
const fitsPlayTime = (
  minPlaytime: number | undefined,
  maxPlaytime: number | undefined,
  { min, max, includeUnknown }: RangeFilter,
): boolean => {
  const gameMin = numberOrAbsent(minPlaytime) ?? numberOrAbsent(maxPlaytime);
  const gameMax = numberOrAbsent(maxPlaytime) ?? numberOrAbsent(minPlaytime);

  if (gameMin === undefined || gameMax === undefined) {
    return includeUnknown;
  }

  return (min === undefined || min <= gameMin) && (max === undefined || gameMax <= max);
};

/**
 * Whether a DataGateway's result matches a search's filter, as the server
 * judges it whatever the DataGateway narrowed (#713): by its content type, by
 * the platform types of its available platforms, by its publish year (#719),
 * and by its player counts and play time (#869). A value with no stored
 * equivalent never matches, so a game whose content type is unspecified
 * matches no content types, and one without platforms matches no platform
 * types. A game whose publish year, player counts or play time is unknown
 * matches that range only when the range includes unknown ones.
 */
export function matchesFilter(game: proto.GameSearchData, filter: ResultFilter): boolean {
  const { platformTypes, contentTypes, publishYear, playerCount, playTime } = filter;

  if (contentTypes) {
    const contentType = toStoredContentType(game.contentType);
    if (contentType === undefined || !contentTypes.has(contentType)) {
      return false;
    }
  }

  if (platformTypes) {
    const onNamedPlatform = (game.availablePlatforms ?? []).some((platform) => {
      const platformType = toStoredPlatformType(platform.platformType);
      return platformType !== undefined && platformTypes.has(platformType);
    });

    if (!onNamedPlatform) {
      return false;
    }
  }

  return (
    (publishYear === undefined || inYearRange(game.yearPublished, publishYear)) &&
    (playerCount === undefined || supportsPlayerCount(game.minPlayers, game.maxPlayers, playerCount)) &&
    (playTime === undefined || fitsPlayTime(game.minPlaytime, game.maxPlaytime, playTime))
  );
}
