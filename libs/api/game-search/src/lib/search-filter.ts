import { ContentType, type PlatformType, type Prisma } from '@bge/database';
import { toProtoContentType, toProtoPlatformType } from '@bge/gateway-registry';
import * as proto from '@boardgamesempire/proto-gateway';

/** A content type a search can be filtered by. Unknown names no kind of game, so it's never one. */
export type SearchableContentType = Exclude<ContentType, typeof ContentType.Unknown>;

export const SEARCHABLE_CONTENT_TYPES: readonly SearchableContentType[] = Object.values(ContentType).filter(
  (type): type is SearchableContentType => type !== ContentType.Unknown,
);

/**
 * What a search is narrowed to, in the server's terms (#713). A game matches
 * a list when it has any value the list names, and the filter when it
 * matches every list that names one. An empty, missing or null list doesn't
 * narrow: a WebSocket frame can send null, and validation lets it through.
 *
 * The publish year (#719), the player count and the play time in minutes
 * (#869) are inclusive ranges, either bound optional, and each narrows only
 * when a bound is given. A game with no known value is left out of a range
 * unless the range's include-unknown flag, such as `playTimeIncludeUnknown`,
 * is set.
 */
export interface GameSearchFilter {
  platformTypes?: PlatformType[] | null;
  contentTypes?: SearchableContentType[] | null;
  publishYearMin?: number | null;
  publishYearMax?: number | null;
  publishYearIncludeUnknown?: boolean | null;
  playerCountMin?: number | null;
  playerCountMax?: number | null;
  playerCountIncludeUnknown?: boolean | null;
  playTimeMin?: number | null;
  playTimeMax?: number | null;
  playTimeIncludeUnknown?: boolean | null;
}

/** A range's bounds as a proto range, or undefined when it gives neither. */
function rangeOf(
  minimum: number | null | undefined,
  maximum: number | null | undefined,
  includeUnknown: boolean | null | undefined,
): proto.IntRange | undefined {
  const min = minimum ?? undefined;
  const max = maximum ?? undefined;

  if (min === undefined && max === undefined) {
    return undefined;
  }

  return {
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
    ...(includeUnknown ? { includeUnknown: true } : {}),
  };
}

/** The filter's publish-year, player-count and play-time ranges, each undefined when it gives no bound. */
function filterRanges(filter: GameSearchFilter) {
  return {
    publishYear: rangeOf(filter.publishYearMin, filter.publishYearMax, filter.publishYearIncludeUnknown),
    playerCount: rangeOf(filter.playerCountMin, filter.playerCountMax, filter.playerCountIncludeUnknown),
    playTime: rangeOf(filter.playTimeMin, filter.playTimeMax, filter.playTimeIncludeUnknown),
  };
}

/** A range's match, widened to the games with no known value when the range includes unknown ones. */
const orUnknown = (
  { includeUnknown }: proto.IntRange,
  match: Prisma.GameWhereInput,
  unknown: Prisma.GameWhereInput,
): Prisma.GameWhereInput => (includeUnknown ? { OR: [match, unknown] } : match);

/**
 * Games that support every player count in `range` (#869). A bound alone is
 * one count, so a minimum of 5 means "supports 5". A null count fails its
 * comparison, so a game missing either is matched only as unknown.
 */
function supportsPlayerCount(range: proto.IntRange): Prisma.GameWhereInput {
  const lo = range.min ?? range.max;
  const hi = range.max ?? range.min;

  return orUnknown(
    range,
    { minPlayers: { lte: lo }, maxPlayers: { gte: hi } },
    { OR: [{ minPlayers: null }, { maxPlayers: null }] },
  );
}

/**
 * Games whose whole play time, in minutes, fits `range` (#869). A game with
 * one play time takes that long, so it stands in for the missing end, and
 * only a game with neither is unknown. A bound left out doesn't narrow that
 * side; with both, the game must meet each.
 */
function fitsPlayTime(range: proto.IntRange): Prisma.GameWhereInput {
  const { min, max } = range;
  const from: Prisma.GameWhereInput = {
    OR: [{ minPlayTime: { gte: min } }, { minPlayTime: null, maxPlayTime: { gte: min } }],
  };
  const upTo: Prisma.GameWhereInput = {
    OR: [{ maxPlayTime: { lte: max } }, { maxPlayTime: null, minPlayTime: { lte: max } }],
  };
  const match = min === undefined ? upTo : max === undefined ? from : { AND: [from, upTo] };

  return orUnknown(range, match, { minPlayTime: null, maxPlayTime: null });
}

/**
 * The filter as the coordinator is sent it, or undefined when it names
 * nothing. A value with no proto equivalent is sent as unspecified, which
 * matches nothing, so its list still narrows.
 */
export function toProtoSearchFilter(filter: GameSearchFilter): proto.SearchFilter | undefined {
  const platformTypes = filter.platformTypes ?? [];
  const contentTypes = filter.contentTypes ?? [];
  const { publishYear, playerCount, playTime } = filterRanges(filter);

  if (platformTypes.length === 0 && contentTypes.length === 0 && !publishYear && !playerCount && !playTime) {
    return undefined;
  }

  return {
    platformTypes: platformTypes.map(
      (type) => toProtoPlatformType(type) ?? proto.PlatformType.PLATFORM_TYPE_UNSPECIFIED,
    ),
    contentTypes: contentTypes.map((type) => toProtoContentType(type) ?? proto.ContentType.CONTENT_TYPE_UNSPECIFIED),
    ...(publishYear && { publishYear }),
    ...(playerCount && { playerCount }),
    ...(playTime && { playTime }),
  };
}

/**
 * The filter as conditions on the local search, by the same rule as every
 * DataGateway's results: a game matches platform types by the platforms it's
 * on, so one on none matches none, and a game with no known publish year,
 * player count or play time matches that range only when the range includes
 * unknown ones.
 *
 * Player count and play time read the game's own values, not the overrides
 * a platform game or a release can carry (#869). No DataGateway sends those
 * today, so import fills only the game's, and Prisma can't filter on the
 * override chain's coalesce (#896).
 */
export function localFilterConditions(filter: GameSearchFilter): Prisma.GameWhereInput[] {
  const platformTypes = filter.platformTypes ?? [];
  const contentTypes = filter.contentTypes ?? [];
  const { publishYear, playerCount, playTime } = filterRanges(filter);
  const inRange: Prisma.GameWhereInput | undefined = publishYear && {
    publishYear: {
      ...(publishYear.min === undefined ? {} : { gte: publishYear.min }),
      ...(publishYear.max === undefined ? {} : { lte: publishYear.max }),
    },
  };

  return [
    ...(contentTypes.length > 0 ? [{ contentType: { in: contentTypes } }] : []),
    ...(platformTypes.length > 0
      ? [{ platformGames: { some: { platform: { platformType: { in: platformTypes } } } } }]
      : []),
    ...(publishYear && inRange ? [orUnknown(publishYear, inRange, { publishYear: null })] : []),
    ...(playerCount ? [supportsPlayerCount(playerCount)] : []),
    ...(playTime ? [fitsPlayTime(playTime)] : []),
  ];
}
