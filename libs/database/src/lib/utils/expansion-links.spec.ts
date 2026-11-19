import type { Prisma } from '../client';
import { ContentType } from '../client';
import type { PlatformGameInView } from './expansion-links';
import {
  ADD_ON_CONTENT_TYPES,
  effectiveContentType,
  isStandaloneAddOn,
  linkPlatformIds,
  readBaseGameLinks,
  readBaseGameLinksOnPlatform,
} from './expansion-links';

/** A stand-in for the where the caller composes for the base games. */
const BASE_WHERE: Prisma.GameWhereInput = { id: 'sentinel-base-game-where' };

/** Add-ons as a caller passes them: each game's id and content type. */
const EXPANSION = { id: 'e1', contentType: ContentType.Expansion };
const DLC = { id: 'e2', contentType: ContentType.DLC };
const STANDALONE = { id: 's1', contentType: ContentType.StandaloneExpansion };

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

    await readBaseGameLinks(db, [EXPANSION, DLC], BASE_WHERE);

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({
      where: { expansionGameId: { in: ['e1', 'e2'] }, baseGame: { is: BASE_WHERE } },
      select: { expansionGameId: true, baseGameId: true },
      orderBy: [{ baseGame: { title: 'asc' } }, { baseGameId: 'asc' }],
    });
  });

  // A page can hold one game twice, and `in` needs it once.
  it('names a game given twice once in the read (#1391)', async () => {
    const { db, findMany } = stubDb();

    await readBaseGameLinks(db, [EXPANSION, DLC, EXPANSION], BASE_WHERE);

    expect(findMany.mock.calls[0][0].where.expansionGameId).toEqual({ in: ['e1', 'e2'] });
  });

  it('groups them by expansion, each link naming its base game (#1069)', async () => {
    const { db } = stubDb([
      { expansionGameId: 'e1', baseGameId: 'b1' },
      { expansionGameId: 'e1', baseGameId: 'b2' },
    ]);

    const links = await readBaseGameLinks(db, [EXPANSION, DLC], BASE_WHERE);

    expect(links.get('e1')?.map(({ gameId }) => gameId)).toEqual(['b1', 'b2']);
    expect(links.has('e2')).toBe(false);
  });

  // `isStandalone` is a property of the add-on, not of one link: it follows
  // the add-on's content type, so no two links of an add-on differ (#1391).
  it("gives every link of an add-on its content type's isStandalone (#1391)", async () => {
    const { db } = stubDb([
      { expansionGameId: 's1', baseGameId: 'b1' },
      { expansionGameId: 's1', baseGameId: 'b2' },
      { expansionGameId: 'e2', baseGameId: 'b1' },
    ]);

    const links = await readBaseGameLinks(db, [STANDALONE, DLC], BASE_WHERE);

    expect(links.get('s1')).toEqual([
      { gameId: 'b1', isStandalone: true },
      { gameId: 'b2', isStandalone: true },
    ]);
    expect(links.get('e2')).toEqual([{ gameId: 'b1', isStandalone: false }]);
  });

  // An empty page has nothing to link, and `in: []` would still cost a round trip.
  it('issues no query for an empty id list (#1069)', async () => {
    const { db, findMany } = stubDb();

    const links = await readBaseGameLinks(db, [], BASE_WHERE);

    expect(findMany).not.toHaveBeenCalled();
    expect(links.size).toBe(0);
  });
});

describe('readBaseGameLinksOnPlatform', () => {
  const TABLETOP = 'plat-tabletop';
  const PC = 'plat-pc';

  const stubDb = (rows: unknown[] = []) => {
    const findMany = jest.fn().mockResolvedValue(rows);

    return {
      db: { gameExpansion: { findMany } } as never as Parameters<typeof readBaseGameLinksOnPlatform>[0],
      findMany,
    };
  };

  /** A platform game a row shows: its own content type, if it has one, over its game's. */
  const inView = (
    id: string,
    platformId: string,
    game: PlatformGameInView['game'],
    contentType: ContentType | null = null,
  ): PlatformGameInView => ({ id, platform: { id: platformId }, contentType, game });

  /** A link row as the read returns it: the base game's platform games, among the page's platforms. */
  const linkRow = (expansionGameId: string, baseGameId: string, basePlatformIds: readonly string[]) => ({
    expansionGameId,
    baseGameId,
    baseGame: { platformGames: basePlatformIds.map((platformId) => ({ platformId })) },
  });

  // The caller's where stays in the read's own where, where the CASL extension
  // sees a deny-all (#1069). The base game's platform games are read only to
  // test presence, and only on the page's platforms: never sent, so under no
  // ceiling (#1391).
  it("reads each game once, with its base games' platform games on the page's platforms, in base game title then id order (#1391)", async () => {
    const { db, findMany } = stubDb();

    await readBaseGameLinksOnPlatform(
      db,
      [inView('pg-1', TABLETOP, DLC), inView('pg-2', PC, DLC), inView('pg-3', TABLETOP, EXPANSION)],
      BASE_WHERE,
    );

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({
      where: { expansionGameId: { in: ['e2', 'e1'] }, baseGame: { is: BASE_WHERE } },
      select: {
        expansionGameId: true,
        baseGameId: true,
        baseGame: {
          select: {
            platformGames: { where: { platformId: { in: [TABLETOP, PC] } }, select: { platformId: true } },
          },
        },
      },
      orderBy: [{ baseGame: { title: 'asc' } }, { baseGameId: 'asc' }],
    });
  });

  // A row shows one platform game, and a DLC on PC adds nothing to a base game
  // a user can only have on the table (#1391).
  it('gives a platform game no link to a base game with no platform game on its platform (#1391)', async () => {
    const { db } = stubDb([linkRow('e2', 'b1', [TABLETOP])]);

    const links = await readBaseGameLinksOnPlatform(db, [inView('pg-pc', PC, DLC)], BASE_WHERE);

    expect(links.get('pg-pc') ?? []).toEqual([]);
  });

  // One DLC held on two platforms gives two rows, and the base game is only on
  // the table: keyed by game, both rows would get the same answer (#1391).
  it('keys the links by platform game, so of one DLC on Tabletop and on PC only the Tabletop one names a Tabletop-only base game (#1391)', async () => {
    const { db } = stubDb([linkRow('e2', 'b1', [TABLETOP])]);

    const links = await readBaseGameLinksOnPlatform(
      db,
      [inView('pg-tabletop', TABLETOP, DLC), inView('pg-pc', PC, DLC)],
      BASE_WHERE,
    );

    expect(links.get('pg-tabletop')).toEqual([{ gameId: 'b1', isStandalone: false }]);
    expect(links.get('pg-pc') ?? []).toEqual([]);
  });

  // With one platform in view, the add-on's content type is the platform
  // game's own where it has one, else the game's (#1391).
  it("reads isStandalone from the platform game's own content type, else the game's (#1391)", async () => {
    const { db } = stubDb([linkRow('e2', 'b1', [TABLETOP, PC])]);

    const links = await readBaseGameLinksOnPlatform(
      db,
      [inView('pg-tabletop', TABLETOP, DLC), inView('pg-pc', PC, DLC, ContentType.StandaloneExpansion)],
      BASE_WHERE,
    );

    expect(links.get('pg-tabletop')).toEqual([{ gameId: 'b1', isStandalone: false }]);
    expect(links.get('pg-pc')).toEqual([{ gameId: 'b1', isStandalone: true }]);
  });

  // The offered-games filters read a row's content type from its platform
  // game where it has one; a row they count as a base game must not also
  // name a base game of its own (#1391).
  it.each([ContentType.BaseGame, ContentType.Bundle, ContentType.Remaster, ContentType.Unknown])(
    'gives a platform game whose own content type is %s no base game, though its game is a DLC (#1391)',
    async (contentType) => {
      const { db } = stubDb([linkRow('e2', 'b1', [TABLETOP, PC])]);

      const links = await readBaseGameLinksOnPlatform(
        db,
        [inView('pg-tabletop', TABLETOP, DLC), inView('pg-pc', PC, DLC, contentType)],
        BASE_WHERE,
      );

      expect(links.get('pg-tabletop')).toEqual([{ gameId: 'b1', isStandalone: false }]);
      expect(links.has('pg-pc')).toBe(false);
    },
  );

  // A batch offer reads its already-offered entries before its writes and the
  // new ones after, so a re-import between them can give one platform game
  // two content types. The links are keyed by platform game, so a base game
  // snapshot would otherwise carry the add-on snapshot's links. With none,
  // either snapshot is a row that can be: an add-on whose links hold on no
  // platform, or a base game (#1391).
  it.each([
    ['the add-on first', [DLC, { ...DLC, contentType: ContentType.BaseGame }]],
    ['the base game first', [{ ...DLC, contentType: ContentType.BaseGame }, DLC]],
  ])(
    'gives a platform game seen both as an add-on and as no add-on no base game, %s (#1391)',
    async (_order, [first, second]) => {
      const { db } = stubDb([linkRow('e2', 'b1', [TABLETOP])]);

      const links = await readBaseGameLinksOnPlatform(
        db,
        [inView('pg-1', TABLETOP, first), inView('pg-1', TABLETOP, second)],
        BASE_WHERE,
      );

      expect(links.has('pg-1')).toBe(false);
    },
  );

  // An empty page has nothing to link, and `in: []` would still cost a round trip.
  it('issues no query for no platform games (#1391)', async () => {
    const { db, findMany } = stubDb();

    const links = await readBaseGameLinksOnPlatform(db, [], BASE_WHERE);

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
    expect(linkPlatformIds(['p2', 'p1', 'p3'], new Set(['p3', 'p2']))).toEqual(['p2', 'p3']);
  });

  it('is empty when the games share no platform (#1391)', () => {
    expect(linkPlatformIds(['p1'], new Set())).toEqual([]);
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
