import type { Prisma } from '../client';
import { ContentType } from '../client';
import {
  ADD_ON_CONTENT_TYPES,
  effectiveContentType,
  isStandaloneAddOn,
  linkPlatformIds,
  readBaseGameLinks,
} from './expansion-links';

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

describe('effectiveContentType', () => {
  // A platform game's own content type wins over the game's; without one the
  // game's applies (#1391).
  it("is the platform game's own content type, else the game's (#1391)", () => {
    expect(effectiveContentType(null, ContentType.BaseGame)).toBe(ContentType.BaseGame);
    expect(effectiveContentType(ContentType.DLC, ContentType.StandaloneExpansion)).toBe(ContentType.DLC);
  });
});

describe('isStandaloneAddOn', () => {
  it('is true for a standalone expansion only, across every content type (#1391)', () => {
    for (const contentType of Object.values(ContentType)) {
      expect(isStandaloneAddOn(contentType)).toBe(contentType === ContentType.StandaloneExpansion);
    }
  });
});

describe('linkPlatformIds', () => {
  // The platforms an add-on link holds on are those both games are on, read in
  // the add-on's order (#1391).
  it("keeps the ids also in the other game's, in the given order (#1391)", () => {
    expect(linkPlatformIds(['p2', 'p1', 'p3'], ['p3', 'p2'])).toEqual(['p2', 'p3']);
  });

  it('is empty when the games share no platform (#1391)', () => {
    expect(linkPlatformIds(['p1'], [])).toEqual([]);
  });
});

describe('ADD_ON_CONTENT_TYPES', () => {
  it('is exactly the five content types that add to a base game (#1391)', () => {
    expect([...ADD_ON_CONTENT_TYPES].sort()).toEqual(
      [
        ContentType.Expansion,
        ContentType.DLC,
        ContentType.Mod,
        ContentType.StandaloneExpansion,
        ContentType.Accessory,
      ].sort(),
    );
  });
});
