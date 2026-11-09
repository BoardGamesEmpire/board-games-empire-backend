import { ContentType, ExpansionType, Prisma } from '@bge/database';
import { createTestingModuleWithDb, type MockDatabaseService } from '@bge/testing';
import { BaseGameLinkService, type LinkBaseGamesInput } from './base-game-link.service';

const uniqueViolation = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });

/**
 * #971. Every import links its game to the base games its DataGateway names
 * that are in the game catalog, and links the games already in the catalog
 * that name it as their base game. A game that needs a base game and finds
 * none reports the first one named, for the import to add to its batch.
 */
describe('BaseGameLinkService', () => {
  let service: BaseGameLinkService;
  let db: MockDatabaseService;

  const GATEWAY_ID = 'gw-bgg';

  /** DataGateway links by external id, as the game catalog holds them. */
  let catalog: Record<string, { gameId: string; contentType?: ContentType }>;
  /** DataGateway links whose stored base game ids name another game. */
  let addOns: { gameId: string; baseExternalIds: string[]; contentType: ContentType }[];

  beforeEach(async () => {
    const { module, db: mockDb } = await createTestingModuleWithDb({ providers: [BaseGameLinkService] });
    service = module.get(BaseGameLinkService);
    db = mockDb;

    catalog = {};
    addOns = [];

    db.gameSource.findMany.mockImplementation((async (args: Prisma.GameSourceFindManyArgs) => {
      const where = args.where ?? {};
      const externalIds = (where.externalId as { in?: string[] } | undefined)?.in;
      if (externalIds) {
        return externalIds
          .filter((externalId) => catalog[externalId])
          .map((externalId) => ({ externalId, gameId: catalog[externalId].gameId }));
      }

      const named = (where.baseExternalIds as { has?: string } | undefined)?.has;
      const excluded = (where.gameId as { not?: string } | undefined)?.not;
      if (named) {
        return addOns
          .filter((addOn) => addOn.baseExternalIds.includes(named) && addOn.gameId !== excluded)
          .map((addOn) => ({ gameId: addOn.gameId, game: { contentType: addOn.contentType } }));
      }

      return [];
    }) as never);
    db.gameExpansion.upsert.mockResolvedValue({} as never);
  });

  afterEach(() => jest.clearAllMocks());

  const input = (overrides: Partial<LinkBaseGamesInput> = {}): LinkBaseGamesInput => ({
    gameId: 'game-expansion',
    gatewayId: GATEWAY_ID,
    externalId: '926',
    contentType: ContentType.Expansion,
    baseExternalIds: [],
    ...overrides,
  });

  /** The (base game, add-on) pairs linked, in call order. */
  const linkedPairs = () =>
    db.gameExpansion.upsert.mock.calls.map(([args]) => {
      const { baseGameId, expansionGameId } = args.where.baseGameId_expansionGameId as {
        baseGameId: string;
        expansionGameId: string;
      };
      return [baseGameId, expansionGameId];
    });

  it('links the game to every named base game in the game catalog', async () => {
    catalog = { '13': { gameId: 'game-catan' }, '143065': { gameId: 'game-tribes' } };

    const result = await service.link(input({ contentType: ContentType.DLC, baseExternalIds: ['13', '143065'] }));

    expect(result).toEqual({ baseGameIds: ['game-catan', 'game-tribes'], isExpansion: true });
    expect(linkedPairs()).toEqual([
      ['game-catan', 'game-expansion'],
      ['game-tribes', 'game-expansion'],
    ]);
    expect(db.gameExpansion.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ expansionType: ExpansionType.DLC, isStandalone: false }),
        update: { expansionType: ExpansionType.DLC, isStandalone: false },
      }),
    );
  });

  it('looks the named base games up on the same DataGateway only', async () => {
    await service.link(input({ baseExternalIds: ['13'] }));

    expect(db.gameSource.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { gatewayId: GATEWAY_ID, externalId: { in: ['13'] } } }),
    );
  });

  it.each([ContentType.Expansion, ContentType.DLC, ContentType.Mod])(
    'adds the first named base game when none is in the game catalog, for content type %s',
    async (contentType) => {
      const result = await service.link(input({ contentType, baseExternalIds: ['13', '143065'] }));

      expect(result).toEqual({ baseGameIds: [], baseGameToAdd: '13', isExpansion: true });
      expect(db.gameExpansion.upsert).not.toHaveBeenCalled();
    },
  );

  it.each([
    ContentType.StandaloneExpansion,
    ContentType.ExpandedEdition,
    ContentType.Remake,
    ContentType.Remaster,
    ContentType.Port,
    ContentType.Bundle,
    ContentType.Accessory,
    ContentType.BaseGame,
    ContentType.Unknown,
  ])('only links, never adds, for content type %s', async (contentType) => {
    const result = await service.link(input({ contentType, baseExternalIds: ['13'] }));

    expect(result.baseGameToAdd).toBeUndefined();
  });

  // An expansion to the import's events, notifications and game watches is
  // an add-on with a base game; a version of its original is not (#971).
  it.each([
    ContentType.Remake,
    ContentType.Remaster,
    ContentType.Port,
    ContentType.ExpandedEdition,
    ContentType.Bundle,
    ContentType.BaseGame,
    ContentType.Unknown,
  ])('links a %s to its original without counting it as an expansion', async (contentType) => {
    catalog = { '13': { gameId: 'game-catan' } };

    const result = await service.link(input({ contentType, baseExternalIds: ['13'] }));

    expect(result).toEqual({ baseGameIds: ['game-catan'], isExpansion: false });
  });

  it.each([ContentType.StandaloneExpansion, ContentType.Accessory])(
    'counts a %s linked to its base game as an expansion',
    async (contentType) => {
      catalog = { '13': { gameId: 'game-catan' } };

      const result = await service.link(input({ contentType, baseExternalIds: ['13'] }));

      expect(result).toEqual({ baseGameIds: ['game-catan'], isExpansion: true });
    },
  );

  it('does not count an add-on as an expansion while it has no base game and adds none', async () => {
    const result = await service.link(input({ contentType: ContentType.StandaloneExpansion, baseExternalIds: ['13'] }));

    expect(result).toEqual({ baseGameIds: [], isExpansion: false });
  });

  it('adds nothing when at least one named base game is present', async () => {
    catalog = { '143065': { gameId: 'game-tribes' } };

    const result = await service.link(input({ baseExternalIds: ['13', '143065'] }));

    expect(result).toEqual({ baseGameIds: ['game-tribes'], isExpansion: true });
  });

  it('links games already in the game catalog that name this game as their base game', async () => {
    addOns = [
      { gameId: 'game-seafarers', baseExternalIds: ['13'], contentType: ContentType.Expansion },
      { gameId: 'game-catan-mod', baseExternalIds: ['13', '99'], contentType: ContentType.Mod },
      { gameId: 'game-unrelated', baseExternalIds: ['99'], contentType: ContentType.Expansion },
    ];

    await service.link(input({ gameId: 'game-catan', externalId: '13', contentType: ContentType.BaseGame }));

    expect(db.gameSource.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { gatewayId: GATEWAY_ID, baseExternalIds: { has: '13' }, gameId: { not: 'game-catan' } },
      }),
    );
    expect(linkedPairs()).toEqual([
      ['game-catan', 'game-seafarers'],
      ['game-catan', 'game-catan-mod'],
    ]);
    // Each link takes its type from the add-on's stored content type.
    expect(db.gameExpansion.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { baseGameId_expansionGameId: { baseGameId: 'game-catan', expansionGameId: 'game-catan-mod' } },
        create: expect.objectContaining({ expansionType: ExpansionType.Mod }),
      }),
    );
  });

  it('falls back to the requested game when the DataGateway names no base game', async () => {
    catalog = { '13': { gameId: 'game-catan' } };

    const result = await service.link(input({ baseExternalIds: [], fallbackBaseExternalId: '13' }));

    expect(result).toEqual({ baseGameIds: ['game-catan'], isExpansion: true });
    expect(linkedPairs()).toEqual([['game-catan', 'game-expansion']]);
  });

  it('ignores the fallback when the DataGateway names other base games', async () => {
    catalog = { '13': { gameId: 'game-catan' }, '143065': { gameId: 'game-tribes' } };

    const result = await service.link(input({ baseExternalIds: ['143065'], fallbackBaseExternalId: '13' }));

    expect(result).toEqual({ baseGameIds: ['game-tribes'], isExpansion: true });
    expect(db.gameSource.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { gatewayId: GATEWAY_ID, externalId: { in: ['143065'] } } }),
    );
  });

  it('never adds the fallback game, which is already in its import batch', async () => {
    const result = await service.link(input({ baseExternalIds: [], fallbackBaseExternalId: '13' }));

    expect(result).toEqual({ baseGameIds: [], isExpansion: false });
  });

  it('never links a game to itself, though its DataGateway lists it as its own base game', async () => {
    catalog = { '926': { gameId: 'game-expansion' } };
    addOns = [{ gameId: 'game-expansion', baseExternalIds: ['926'], contentType: ContentType.Expansion }];

    const result = await service.link(input({ externalId: '926', baseExternalIds: ['926'] }));

    expect(result).toEqual({ baseGameIds: [], isExpansion: false });
    expect(db.gameExpansion.upsert).not.toHaveBeenCalled();
  });

  it('treats a link another import made first as linked', async () => {
    catalog = { '13': { gameId: 'game-catan' } };
    db.gameExpansion.upsert.mockRejectedValue(uniqueViolation());

    await expect(service.link(input({ baseExternalIds: ['13'] }))).resolves.toEqual({
      baseGameIds: ['game-catan'],
      isExpansion: true,
    });
  });

  it('looks for its base games and its add-ons at the same time', async () => {
    const lookups = db.gameSource.findMany.getMockImplementation();
    const held: (() => void)[] = [];
    db.gameSource.findMany.mockImplementation((async (args: Prisma.GameSourceFindManyArgs) => {
      await new Promise<void>((resolve) => held.push(resolve));
      return lookups?.(args as never);
    }) as never);

    const linking = service.link(input({ baseExternalIds: ['13'] }));

    // Both lookups are in flight before either answers.
    expect(held).toHaveLength(2);
    held.forEach((release) => release());
    await linking;
  });

  it('rethrows a link failure that is not a unique violation', async () => {
    catalog = { '13': { gameId: 'game-catan' } };
    const boom = new Error('connection reset');
    db.gameExpansion.upsert.mockRejectedValue(boom);

    await expect(service.link(input({ baseExternalIds: ['13'] }))).rejects.toBe(boom);
  });
});
