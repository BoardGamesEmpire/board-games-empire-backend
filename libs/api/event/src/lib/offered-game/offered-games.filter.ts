import type { Prisma } from '@bge/database';
import { gameRangeConditions } from '@bge/game-search';
import { escapeLikePattern } from '@bge/shared';
import type { ListOfferedGamesQueryDto } from './dto/list-offered-games.query.dto';

type EntryWhere = Prisma.EventAttendeeGameListWhereInput;

/** `game` on the offered entry's game. */
const onGame = (game: Prisma.GameWhereInput): EntryWhere => ({
  collection: { is: { platformGame: { is: { game: { is: game } } } } },
});

/**
 * An include list as `in`, and its exclude list as `NOT … in`, each present
 * only when given. Every column filtered this way (the attendee, the medium,
 * the platform type and the content type) is required, so `NOT … in` has no
 * NULL row to drop silently.
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
 * The conditions the offered-games query puts on an event's offered entries,
 * to be ANDed (#1187).
 *
 * - Platform type is the offered copy's platform, not every platform the
 *   game is on, as a search reads it.
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
    ...facet(query.contentTypes, query.excludeContentTypes, (types) => onGame({ contentType: { in: types } })),
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
