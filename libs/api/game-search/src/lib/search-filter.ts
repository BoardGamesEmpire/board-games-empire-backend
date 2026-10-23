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
 * The publish year is an inclusive range, either bound optional, and narrows
 * only when a bound is given (#719). A game with no known year is left out
 * unless `publishYearIncludeUnknown` is set.
 */
export interface GameSearchFilter {
  platformTypes?: PlatformType[] | null;
  contentTypes?: SearchableContentType[] | null;
  publishYearMin?: number | null;
  publishYearMax?: number | null;
  publishYearIncludeUnknown?: boolean | null;
}

/** The publish-year bounds a filter gives, as a proto range, or undefined when it gives none. */
function publishYearRange(filter: GameSearchFilter): proto.IntRange | undefined {
  const min = filter.publishYearMin ?? undefined;
  const max = filter.publishYearMax ?? undefined;

  if (min === undefined && max === undefined) {
    return undefined;
  }

  return {
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
    ...(filter.publishYearIncludeUnknown ? { includeUnknown: true } : {}),
  };
}

/**
 * The filter as the coordinator is sent it, or undefined when it names
 * nothing. A value with no proto equivalent is sent as unspecified, which
 * matches nothing, so its list still narrows.
 */
export function toProtoSearchFilter(filter: GameSearchFilter): proto.SearchFilter | undefined {
  const platformTypes = filter.platformTypes ?? [];
  const contentTypes = filter.contentTypes ?? [];
  const publishYear = publishYearRange(filter);

  if (platformTypes.length === 0 && contentTypes.length === 0 && publishYear === undefined) {
    return undefined;
  }

  return {
    platformTypes: platformTypes.map(
      (type) => toProtoPlatformType(type) ?? proto.PlatformType.PLATFORM_TYPE_UNSPECIFIED,
    ),
    contentTypes: contentTypes.map((type) => toProtoContentType(type) ?? proto.ContentType.CONTENT_TYPE_UNSPECIFIED),
    ...(publishYear && { publishYear }),
  };
}

/**
 * The filter as conditions on the local search, by the same rule as every
 * DataGateway's results: a game matches platform types by the platforms it's
 * on, so one on none matches none, and a game with no publish year matches a
 * year range only when the range includes unknown ones.
 */
export function localFilterConditions(filter: GameSearchFilter): Prisma.GameWhereInput[] {
  const platformTypes = filter.platformTypes ?? [];
  const contentTypes = filter.contentTypes ?? [];
  const publishYear = publishYearRange(filter);
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
    ...(inRange ? [publishYear?.includeUnknown ? { OR: [inRange, { publishYear: null }] } : inRange] : []),
  ];
}
