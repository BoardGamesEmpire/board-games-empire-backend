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
 */
export interface GameSearchFilter {
  platformTypes?: PlatformType[] | null;
  contentTypes?: SearchableContentType[] | null;
}

/**
 * The filter as the coordinator is sent it, or undefined when it names
 * nothing. A value with no proto equivalent is sent as unspecified, which
 * matches nothing, so its list still narrows.
 */
export function toProtoSearchFilter(filter: GameSearchFilter): proto.SearchFilter | undefined {
  const platformTypes = filter.platformTypes ?? [];
  const contentTypes = filter.contentTypes ?? [];

  if (platformTypes.length === 0 && contentTypes.length === 0) {
    return undefined;
  }

  return {
    platformTypes: platformTypes.map(
      (type) => toProtoPlatformType(type) ?? proto.PlatformType.PLATFORM_TYPE_UNSPECIFIED,
    ),
    contentTypes: contentTypes.map((type) => toProtoContentType(type) ?? proto.ContentType.CONTENT_TYPE_UNSPECIFIED),
  };
}

/**
 * The filter as conditions on the local search, by the same rule as every
 * DataGateway's results: a game matches platform types by the platforms it's
 * on, so one on none matches none.
 */
export function localFilterConditions(filter: GameSearchFilter): Prisma.GameWhereInput[] {
  const platformTypes = filter.platformTypes ?? [];
  const contentTypes = filter.contentTypes ?? [];

  return [
    ...(contentTypes.length > 0 ? [{ contentType: { in: contentTypes } }] : []),
    ...(platformTypes.length > 0
      ? [{ platformGames: { some: { platform: { platformType: { in: platformTypes } } } } }]
      : []),
  ];
}
