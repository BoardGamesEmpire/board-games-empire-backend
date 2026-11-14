import type { Prisma } from '../client';

/**
 * The platform games of `platformGames` that the wishlist named by
 * `wishlistWhere` holds, directly or through their game, or `null` when no
 * wishlist matches `wishlistWhere` (#1241).
 *
 * - `null`, not an empty set, when the wishlist itself can't be read: an API
 *   key whose list grant is pinned to one custom list, or a user with no
 *   wishlist row. "Not on your wishlist" would claim a wishlist was checked.
 * - A wishlisted game marks every platform game of that game in the input; a
 *   wishlisted platform game marks only itself.
 * - `wishlistWhere` is a list `where` already composed under the list read
 *   ceiling. It sits in the wishlist read's own top-level `where`, where the
 *   CASL extension hoists a deny-all out, so it fails closed. The entry read
 *   then names that wishlist by id, with no list filter inside it. This helper
 *   holds no permission logic.
 * - An empty input reads nothing and answers an empty set.
 */
export async function readWishlistedPlatformGames(
  db: Pick<Prisma.TransactionClient, 'list' | 'listEntry'>,
  platformGames: readonly { readonly id: string; readonly gameId: string }[],
  wishlistWhere: Prisma.ListWhereInput,
): Promise<ReadonlySet<string> | null> {
  if (platformGames.length === 0) {
    return new Set();
  }

  const wishlist = await db.list.findFirst({ where: wishlistWhere, select: { id: true } });

  if (!wishlist) {
    return null;
  }

  const platformGameIds = platformGames.map(({ id }) => id);
  const gameIds = [...new Set(platformGames.map(({ gameId }) => gameId))];

  const entries = await db.listEntry.findMany({
    where: {
      listId: wishlist.id,
      OR: [{ platformGameId: { in: platformGameIds } }, { gameId: { in: gameIds } }],
    },
    select: { platformGameId: true, gameId: true },
  });

  const heldPlatformGameIds = new Set(
    entries.flatMap(({ platformGameId }) => (platformGameId ? [platformGameId] : [])),
  );
  const heldGameIds = new Set(entries.flatMap(({ gameId }) => (gameId ? [gameId] : [])));

  return new Set(
    platformGames
      .filter(({ id, gameId }) => heldPlatformGameIds.has(id) || heldGameIds.has(gameId))
      .map(({ id }) => id),
  );
}
