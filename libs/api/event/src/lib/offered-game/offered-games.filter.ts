import type { ContentType, Prisma } from '@bge/database';
import { gameRangeConditions } from '@bge/game-search';
import { escapeLikePattern } from '@bge/shared';
import type { ListOfferedGamesQueryDto } from './dto/list-offered-games.query.dto';

type EntryWhere = Prisma.EventAttendeeGameListWhereInput;

/** `platformGame` on the offered entry's platform game. */
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
 * (#1391), so it has its own include and exclude conditions:
 * {@link effectiveContentTypeIn} and {@link effectiveContentTypeNotIn}.
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
 * A platform game whose content type is one of `types`: its own, or its
 * game's when it has none of its own (#1391).
 */
function effectiveContentTypeIn(types: ContentType[]): Prisma.PlatformGameWhereInput {
  return {
    OR: [{ contentType: { in: types } }, { contentType: null, game: { is: { contentType: { in: types } } } }],
  };
}

/**
 * A platform game whose content type is none of `types`: its own, or its
 * game's when it has none of its own (#1391).
 *
 * This is its own positive condition, never `NOT` of
 * {@link effectiveContentTypeIn}. The platform game's column is nullable, and
 * a `NOT` over a comparison with NULL is unknown, not true, so it could drop
 * every entry with no content type of its own. Here no `NOT` sits above one:
 * for an entry with no content type of its own, the `notIn` arm never matches
 * and the second arm decides, on the game's column, which is required.
 */
function effectiveContentTypeNotIn(types: ContentType[]): Prisma.PlatformGameWhereInput {
  return {
    OR: [{ contentType: { notIn: types } }, { contentType: null, game: { is: { contentType: { notIn: types } } } }],
  };
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
    ...(query.contentTypes?.length ? [onPlatformGame(effectiveContentTypeIn(query.contentTypes))] : []),
    ...(query.excludeContentTypes?.length
      ? [onPlatformGame(effectiveContentTypeNotIn(query.excludeContentTypes))]
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
