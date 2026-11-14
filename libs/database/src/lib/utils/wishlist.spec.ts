import type { Prisma } from '../client';
import { readWishlistedPlatformGames } from './wishlist';

/** A stand-in for the wishlist where a service composes under the list read ceiling. */
const WISHLIST_WHERE: Prisma.ListWhereInput = { id: 'sentinel-wishlist-where' };

describe('readWishlistedPlatformGames', () => {
  const stubDb = (rows: unknown[] = [], wishlist: { id: string } | null = { id: 'wishlist-1' }) => {
    const findFirst = jest.fn().mockResolvedValue(wishlist);
    const findMany = jest.fn().mockResolvedValue(rows);

    return {
      db: { list: { findFirst }, listEntry: { findMany } } as never as Parameters<
        typeof readWishlistedPlatformGames
      >[0],
      findFirst,
      findMany,
    };
  };

  // A wishlisted game matches every platform game of that game; a wishlisted
  // platform game matches only itself (#1241).
  it('marks a platform game wishlisted directly or through its game, and nothing else (#1241)', async () => {
    const { db, findFirst, findMany } = stubDb([
      { platformGameId: 'pg1', gameId: null },
      { platformGameId: null, gameId: 'g2' },
    ]);

    const result = await readWishlistedPlatformGames(
      db,
      [
        { id: 'pg1', gameId: 'g1' },
        { id: 'pg2', gameId: 'g2' },
        { id: 'pg3', gameId: 'g2' },
        { id: 'pg4', gameId: 'g4' },
      ],
      WISHLIST_WHERE,
    );

    expect([...(result ?? [])].sort()).toEqual(['pg1', 'pg2', 'pg3']);
    // The ceiling-composed where sits in the wishlist read's own top-level
    // where; the entry read names the wishlist by id, with no list filter (#1241).
    expect(findFirst).toHaveBeenCalledWith({ where: WISHLIST_WHERE, select: { id: true } });
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        listId: 'wishlist-1',
        OR: [{ platformGameId: { in: ['pg1', 'pg2', 'pg3', 'pg4'] } }, { gameId: { in: ['g1', 'g2', 'g4'] } }],
      },
      select: { platformGameId: true, gameId: true },
    });
  });

  // An API key whose list grant is pinned to one custom list, or a user with
  // no wishlist row, reads no wishlist. Every row then says "not yours to
  // know", not "not on your wishlist" (#1241).
  it('answers null, not an empty set, when no wishlist is readable, and reads no entries (#1241)', async () => {
    const { db, findFirst, findMany } = stubDb([], null);

    const result = await readWishlistedPlatformGames(db, [{ id: 'pg1', gameId: 'g1' }], WISHLIST_WHERE);

    expect(result).toBeNull();
    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(findMany).not.toHaveBeenCalled();
  });

  // `in: []` would still cost a round trip (#1241).
  it('reads nothing for an empty input (#1241)', async () => {
    const { db, findFirst, findMany } = stubDb();

    const result = await readWishlistedPlatformGames(db, [], WISHLIST_WHERE);

    expect(result?.size).toBe(0);
    expect(findFirst).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
  });
});
