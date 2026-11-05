import type { Prisma } from '../client';
import { readBaseGameLinks } from './expansion-links';

/** A stand-in for the where the caller composes for the base games. */
const BASE_WHERE: Prisma.GameWhereInput = { id: 'sentinel-base-game-where' };

describe('readBaseGameLinks', () => {
  const stubDb = (rows: unknown[] = []) => {
    const findMany = jest.fn().mockResolvedValue(rows);

    return { db: { gameExpansion: { findMany } } as never as Parameters<typeof readBaseGameLinks>[0], findMany };
  };

  // The caller's where is the only thing that decides which base games show:
  // a link to a game the actor may not see must not name it (#1069). It sits
  // in the read's own where, where the CASL extension sees a deny-all. The
  // order is the detail route's, title then id, so a list row and the detail
  // name an expansion's base games in the same order (#1069).
  it("reads the links of the given expansions whose base game passes the caller's where, in base game title then id order (#1069)", async () => {
    const { db, findMany } = stubDb();

    await readBaseGameLinks(db, ['e1', 'e2'], BASE_WHERE);

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({
      where: { expansionGameId: { in: ['e1', 'e2'] }, baseGame: { is: BASE_WHERE } },
      select: { expansionGameId: true, baseGameId: true, isStandalone: true },
      orderBy: [{ baseGame: { title: 'asc' } }, { baseGameId: 'asc' }],
    });
  });

  // An expansion can attach to several base games and be standalone for one
  // and not another, so each link keeps its own value (#1069).
  it('groups them by expansion, each link naming its base game and keeping its own isStandalone (#1069)', async () => {
    const { db } = stubDb([
      { expansionGameId: 'e1', baseGameId: 'b1', isStandalone: false },
      { expansionGameId: 'e1', baseGameId: 'b2', isStandalone: true },
    ]);

    const links = await readBaseGameLinks(db, ['e1', 'e2'], BASE_WHERE);

    expect(links.get('e1')).toEqual([
      { gameId: 'b1', isStandalone: false },
      { gameId: 'b2', isStandalone: true },
    ]);
    expect(links.has('e2')).toBe(false);
  });

  // An empty page has nothing to link, and `in: []` would still cost a round trip.
  it('issues no query for an empty id list (#1069)', async () => {
    const { db, findMany } = stubDb();

    const links = await readBaseGameLinks(db, [], BASE_WHERE);

    expect(findMany).not.toHaveBeenCalled();
    expect(links.size).toBe(0);
  });
});
