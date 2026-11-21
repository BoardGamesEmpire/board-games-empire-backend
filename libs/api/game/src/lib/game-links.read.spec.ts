import type { Prisma } from '@bge/database';
import { ContentType } from '@bge/database';
import type { MockDatabaseService } from '@bge/testing';
import { createMockDatabaseService } from '@bge/testing';
import { readGameLinks } from './game-links.read';
import { LINKED_GAME_SELECT } from './linked-game.select';

/** A stand-in for the where `getGame` composes for the linked games. */
const LINKED_GAME_WHERE: Prisma.GameWhereInput = { id: 'sentinel-linked-game-where' };

/** A DataGateway link as the read selects it, with no linked ids unless given. */
const gatewayLink = (
  gatewayId: string,
  externalId: string,
  ids: { bundles?: string[]; contents?: string[]; worksWith?: string[] } = {},
) => ({
  gatewayId,
  externalId,
  worksWithExternalIds: ids.worksWith ?? [],
  contentExternalIds: ids.contents ?? [],
  bundleExternalIds: ids.bundles ?? [],
});

type GameRead = { where: { AND: [Prisma.GameWhereInput, Prisma.GameWhereInput, Prisma.GameWhereInput] } };

/** The fields of the other game's DataGateway link a "named by" arm can test. */
const NAMED_BY_FIELDS = ['worksWithExternalIds', 'contentExternalIds', 'bundleExternalIds'] as const;

type NamedByField = (typeof NAMED_BY_FIELDS)[number];

const armsOf = (read: GameRead) =>
  (read.where.AND[2] as { gameSources: { some: { OR: Prisma.GameSourceWhereInput[] } } }).gameSources.some.OR;

/**
 * The field a game read's "named by" arms test, read from the arms' keys.
 * A read with none, or with more than one, fails the test at once (#1392).
 */
const namedByFieldOf = (read: GameRead): NamedByField => {
  const fields = [...new Set(armsOf(read).flatMap((arm) => NAMED_BY_FIELDS.filter((field) => field in arm)))];
  if (fields.length !== 1) {
    throw new Error(`a game read tests ${fields.length} "named by" fields: ${fields.join(', ')}`);
  }

  return fields[0];
};

describe('readGameLinks', () => {
  let db: MockDatabaseService;

  // The mock's delegates return the full row type, not the selected payload,
  // so it is passed as the read's own parameter type.
  const readG1 = () => readGameLinks(db as never as Parameters<typeof readGameLinks>[0], 'g1', LINKED_GAME_WHERE);

  /** The one game read whose "named by" arm tests `field`: one per relationship. */
  const readOf = (field: NamedByField): GameRead => {
    const reads = db.game.findMany.mock.calls
      .map(([args]) => args as GameRead)
      .filter((read) => namedByFieldOf(read) === field);
    if (reads.length !== 1) {
      throw new Error(`${reads.length} game reads test ${field}`);
    }

    return reads[0];
  };

  beforeEach(() => {
    db = createMockDatabaseService();
    db.game.findMany.mockResolvedValue([]);
  });

  it('reads nothing for a game with no DataGateway link (#1392)', async () => {
    db.gameSource.findMany.mockResolvedValue([]);

    const links = await readG1();

    expect(db.gameSource.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { gameId: 'g1' } }));
    expect(db.game.findMany).not.toHaveBeenCalled();
    expect(links).toEqual({ worksWith: [], contents: [], bundles: [] });
  });

  // A works-with link holds when either game's DataGateway link names the
  // other, on the same DataGateway: BGG sends it on both games, but an import
  // in either order, or stale data on one side, can leave only one naming the
  // other (#1392). The DataGateway scopes both arms, so BGG 13 never matches
  // IGDB 13.
  it('matches the games this game names and the games naming it, on its own DataGateway only (#1392)', async () => {
    db.gameSource.findMany.mockResolvedValue([gatewayLink('gw-bgg', '367498', { worksWith: ['162886'] })] as never);

    await readG1();

    expect(db.game.findMany).toHaveBeenCalledTimes(3);
    expect(armsOf(readOf('worksWithExternalIds'))).toEqual([
      { gatewayId: 'gw-bgg', externalId: { in: ['162886'] } },
      { gatewayId: 'gw-bgg', worksWithExternalIds: { has: '367498' } },
    ]);
  });

  // A bundle names its contents, and a contained game names its bundles, so
  // a contents link is found from either side (#1394).
  it("reads contents from this game's contents and the other game's bundles, and bundles the other way round (#1394)", async () => {
    db.gameSource.findMany.mockResolvedValue([
      gatewayLink('gw-bgg', '13', { contents: ['278'], bundles: ['30549'] }),
    ] as never);

    await readG1();

    expect(armsOf(readOf('bundleExternalIds'))).toEqual([
      { gatewayId: 'gw-bgg', externalId: { in: ['278'] } },
      { gatewayId: 'gw-bgg', bundleExternalIds: { has: '13' } },
    ]);
    expect(armsOf(readOf('contentExternalIds'))).toEqual([
      { gatewayId: 'gw-bgg', externalId: { in: ['30549'] } },
      { gatewayId: 'gw-bgg', contentExternalIds: { has: '13' } },
    ]);
  });

  // A game on two DataGateways is matched on each, every arm scoped to its
  // own DataGateway (#1392).
  it('matches on each of its DataGateway links, each arm scoped to its own DataGateway (#1392)', async () => {
    db.gameSource.findMany.mockResolvedValue([
      gatewayLink('gw-bgg', '13', { worksWith: ['278'] }),
      gatewayLink('gw-igdb', '740', { worksWith: ['13'] }),
    ] as never);

    await readG1();

    expect(armsOf(readOf('worksWithExternalIds'))).toEqual([
      { gatewayId: 'gw-bgg', externalId: { in: ['278'] } },
      { gatewayId: 'gw-bgg', worksWithExternalIds: { has: '13' } },
      { gatewayId: 'gw-igdb', externalId: { in: ['13'] } },
      { gatewayId: 'gw-igdb', worksWithExternalIds: { has: '740' } },
    ]);
  });

  // The CASL extension hoists a deny-all only from a read's top-level where,
  // so the ceiling sits there, never in a relation filter: a linked game is
  // named only if the actor could open it, as on add-on links (#1069, #1392).
  // A game naming itself is never its own link.
  it("keeps the ceiling in the read's own where, and leaves this game out (#1392)", async () => {
    db.gameSource.findMany.mockResolvedValue([gatewayLink('gw-bgg', '13')] as never);

    await readG1();

    expect(db.game.findMany).toHaveBeenCalledTimes(3);
    for (const [args] of db.game.findMany.mock.calls) {
      const { where } = args as GameRead;
      expect(where.AND[0]).toBe(LINKED_GAME_WHERE);
      expect(where.AND[1]).toEqual({ id: { not: 'g1' } });
      expect(args).toEqual(expect.objectContaining({ select: LINKED_GAME_SELECT }));
    }
  });

  it('reads in title order, then id (#1392)', async () => {
    const worksWith = [{ id: 'w1', title: 'A', thumbnail: null, contentType: ContentType.BaseGame }];
    db.gameSource.findMany.mockResolvedValue([gatewayLink('gw-bgg', '13')] as never);
    db.game.findMany.mockImplementation(((read: GameRead) =>
      Promise.resolve(namedByFieldOf(read) === 'worksWithExternalIds' ? worksWith : [])) as never);

    const links = await readG1();

    expect(links).toEqual({ worksWith, contents: [], bundles: [] });
    expect(db.game.findMany).toHaveBeenCalledTimes(3);
    for (const [args] of db.game.findMany.mock.calls) {
      expect(args).toEqual(expect.objectContaining({ orderBy: [{ title: 'asc' }, { id: 'asc' }] }));
    }
  });

  // A game whose DataGateway names nothing can still be named by another
  // game, so its "named by" arm stays (#1392, #1394).
  it('drops the "names" arm when a list is empty, keeping the "named by" arm (#1392)', async () => {
    db.gameSource.findMany.mockResolvedValue([gatewayLink('gw-bgg', '13')] as never);

    await readG1();

    expect(armsOf(readOf('worksWithExternalIds'))).toEqual([
      { gatewayId: 'gw-bgg', worksWithExternalIds: { has: '13' } },
    ]);
    expect(armsOf(readOf('bundleExternalIds'))).toEqual([{ gatewayId: 'gw-bgg', bundleExternalIds: { has: '13' } }]);
    expect(armsOf(readOf('contentExternalIds'))).toEqual([{ gatewayId: 'gw-bgg', contentExternalIds: { has: '13' } }]);
  });
});
