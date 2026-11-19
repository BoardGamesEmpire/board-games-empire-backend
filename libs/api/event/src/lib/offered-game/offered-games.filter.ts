import type { ContentType, Prisma } from '@bge/database';
import { gameRangeConditions } from '@bge/game-search';
import { escapeLikePattern } from '@bge/shared';
import type { ListOfferedGamesQueryDto } from './dto/list-offered-games.query.dto';

type EntryWhere = Prisma.EventAttendeeGameListWhereInput;

/** An include list of content types as `in`, or an exclude list as `notIn` (#1391). */
type ContentTypeFilter = { in: ContentType[] } | { notIn: ContentType[] };

/** `platformGame` on the offered entry's platform game (#1391). */
const onPlatformGame = (platformGame: Prisma.PlatformGameWhereInput): EntryWhere => ({
  collection: { is: { platformGame: { is: platformGame } } },
});

/** `game` on the offered entry's game. */
const onGame = (game: Prisma.GameWhereInput): EntryWhere => onPlatformGame({ game: { is: game } });

/**
 * An include list as `in`, and its exclude list as `NOT … in`, each present
 * only when given. Every column filtered this way (the attendee, the medium
 * and the platform type) is required, so `NOT … in` has no NULL row to drop
 * silently.
 *
 * Content type isn't filtered this way. The offered copy's content type is
 * its platform game's own when it has one, and that column is nullable
 * (#1391), so its include and exclude conditions come from
 * {@link effectiveContentTypeWhere}.
 */
function facet<T>(
  include: readonly T[] | undefined,
  exclude: readonly T[] | undefined,
  where: (values: T[]) => EntryWhere,
): EntryWhere[] {
  return [
    ...(include?.length ? [where([...include])] : []),
    ...(exclude?.length ? [{ NOT: where([...exclude]) }] : []),
  ];
}

/**
 * A platform game whose content type matches `filter`: its own, or its game's
 * when it has none of its own (#1391).
 *
 * The exclude, `{ notIn: types }`, is its own positive condition, never `NOT`
 * of the include. The platform game's column is nullable, and a `NOT` over a
 * comparison with NULL is unknown, not true, so it could drop every entry with
 * no content type of its own. Here no `NOT` sits above one: for an entry with
 * no content type of its own, the first arm never matches and the second arm
 * decides, on the game's column, which is required.
 */
function effectiveContentTypeWhere(filter: ContentTypeFilter): Prisma.PlatformGameWhereInput {
  return { OR: [{ contentType: filter }, { contentType: null, game: { is: { contentType: filter } } }] };
}

/**
 * The conditions the offered-games query puts on an event's offered entries,
 * to be ANDed (#1187).
 *
 * - Platform type is the offered copy's platform, not every platform the
 *   game is on, as a search reads it.
 * - Content type is the offered copy's platform game's own, else its game's
 *   (#1391). A search reads the game's alone.
 * - The ranges are the game search's rules (`gameRangeConditions`), on the
 *   entry's game.
 * - Each whitespace-separated word of `q` must appear in the title or the
 *   subtitle, ignoring case, with LIKE wildcards escaped, so `100%` finds
 *   only `100%`. A query of only spaces narrows nothing.
 */
export function offeredGamesFilter(query: ListOfferedGamesQueryDto): EntryWhere[] {
  const terms = (query.q ?? '').split(/\s+/).filter((term) => term !== '');

  return [
    ...facet(query.attendeeIds, query.excludeAttendeeIds, (ids) => ({ attendeeId: { in: ids } })),
    ...facet(query.platformTypes, query.excludePlatformTypes, (types) => ({
      collection: { is: { platformGame: { is: { platform: { is: { platformType: { in: types } } } } } } },
    })),
    ...facet(query.mediums, query.excludeMediums, (mediums) => ({ collection: { is: { medium: { in: mediums } } } })),
    ...(query.contentTypes?.length ? [onPlatformGame(effectiveContentTypeWhere({ in: query.contentTypes }))] : []),
    ...(query.excludeContentTypes?.length
      ? [onPlatformGame(effectiveContentTypeWhere({ notIn: query.excludeContentTypes }))]
      : []),
    ...gameRangeConditions(query).map(onGame),
    ...terms.map((term) => {
      const escaped = escapeLikePattern(term);

      return onGame({
        OR: [
          { title: { contains: escaped, mode: 'insensitive' } },
          { subtitle: { contains: escaped, mode: 'insensitive' } },
        ],
      });
    }),
  ];
}
