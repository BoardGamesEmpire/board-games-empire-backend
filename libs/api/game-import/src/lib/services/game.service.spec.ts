import { GameSource, Prisma } from '@bge/database';
import { createTestingModuleWithDb, type MockDatabaseService } from '@bge/testing';
import type { GameData } from '@boardgamesempire/proto-gateway';
import { ContentType, PlatformType as ProtoPlatformType } from '@boardgamesempire/proto-gateway';
import { NotFoundException } from '@nestjs/common';
import { GameUpsertService } from './game.service';
import { PersonUpsertService } from './person.service';
import type { PlatformGameMap } from './platform.service';
import { PlatformUpsertService } from './platform.service';
import { TaxonomyUpsertService } from './taxonomy.service';

const uniqueViolation = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });

describe('GameUpsertService', () => {
  let service: GameUpsertService;
  let db: MockDatabaseService;
  let platformService: jest.Mocked<PlatformUpsertService>;
  let taxonomyService: jest.Mocked<TaxonomyUpsertService>;
  let personService: jest.Mocked<PersonUpsertService>;

  const GATEWAY_ID = 'gw-bgg';

  beforeEach(async () => {
    platformService = {
      upsertPlatformGames: jest.fn(),
      upsertReleases: jest.fn(),
      upsertPlatform: jest.fn(),
      upsertLanguage: jest.fn(),
      inferCapabilities: jest.fn(),
    } as unknown as jest.Mocked<PlatformUpsertService>;

    taxonomyService = {
      upsertMechanic: jest.fn(),
      upsertCategory: jest.fn(),
      upsertFamily: jest.fn(),
    } as unknown as jest.Mocked<TaxonomyUpsertService>;

    personService = {
      upsertDesigner: jest.fn(),
      upsertArtist: jest.fn(),
      upsertPublisher: jest.fn(),
    } as unknown as jest.Mocked<PersonUpsertService>;

    const { module, db: mockDb } = await createTestingModuleWithDb({
      providers: [
        GameUpsertService,
        { provide: PlatformUpsertService, useValue: platformService },
        { provide: TaxonomyUpsertService, useValue: taxonomyService },
        { provide: PersonUpsertService, useValue: personService },
      ],
    });

    service = module.get(GameUpsertService);
    db = mockDb;
  });

  afterEach(() => jest.clearAllMocks());

  function bggGameData(overrides: Partial<GameData> = {}): GameData {
    return {
      externalId: '13',
      title: 'Catan',
      contentType: 'CONTENT_TYPE_BASE_GAME',
      minPlayers: 3,
      maxPlayers: 4,
      minPlaytime: 60,
      maxPlaytime: 120,
      platforms: [
        {
          externalId: 'tabletop',
          name: 'Tabletop',
          platformType: ProtoPlatformType.PLATFORM_TYPE_TABLETOP,
        },
      ],
      releases: [],
      mechanics: [],
      categories: [],
      families: [],
      designers: [],
      artists: [],
      publishers: [],
      dlc: [],
      themes: [],
      ageRatings: [],
      metadataKeys: [],
      metadataValues: [],
      ...overrides,
    } as GameData;
  }

  function igdbGameData(overrides: Partial<GameData> = {}): GameData {
    return {
      externalId: '1942',
      title: 'The Witcher 3',
      contentType: 'CONTENT_TYPE_BASE_GAME',
      minPlayers: 1,
      maxPlayers: 1,
      platforms: [
        {
          externalId: '48',
          name: 'PlayStation 5',
          abbreviation: 'PS5',
          platformType: ProtoPlatformType.PLATFORM_TYPE_CONSOLE,
        },
        {
          externalId: '6',
          name: 'PC (Microsoft Windows)',
          abbreviation: 'PC',
          platformType: ProtoPlatformType.PLATFORM_TYPE_PC,
        },
      ],
      releases: [
        {
          externalId: 'rd-ps5',
          platform: {
            externalId: '48',
            name: 'PlayStation 5',
            abbreviation: 'PS5',
            platformType: ProtoPlatformType.PLATFORM_TYPE_CONSOLE,
          },
          status: 'RELEASE_STATUS_RELEASED',
          releaseDate: '2022-12-14',
          localizations: [],
          languages: [],
        },
        {
          externalId: 'rd-pc',
          platform: {
            externalId: '6',
            name: 'PC (Microsoft Windows)',
            abbreviation: 'PC',
            platformType: ProtoPlatformType.PLATFORM_TYPE_PC,
          },
          status: 'RELEASE_STATUS_RELEASED',
          releaseDate: '2015-05-19',
          localizations: [],
          languages: [],
        },
      ],
      mechanics: [],
      categories: [],
      families: [],
      designers: [],
      artists: [],
      publishers: [],
      dlc: [],
      themes: [],
      ageRatings: [],
      metadataKeys: [],
      metadataValues: [],
      ...overrides,
    } as GameData;
  }

  function stubNewGameCreation(gameId = 'game-1'): void {
    db.gameSource.findUnique.mockResolvedValue(null);
    db.game.create.mockResolvedValue({ id: gameId } as never);
  }

  function stubExistingGame(gameId = 'game-1', frozen = false): void {
    db.gameSource.findUnique.mockResolvedValue({
      gameId,
      game: { id: gameId, frozenAt: frozen ? new Date() : null },
    } as never);
    db.game.update.mockResolvedValue({ id: gameId } as never);
  }

  function stubPlatformGameMap(...entries: [string, string][]): void {
    const map: PlatformGameMap = new Map(entries);
    platformService.upsertPlatformGames.mockResolvedValue(map);
    platformService.upsertReleases.mockResolvedValue(undefined);
  }

  describe('upsert', () => {
    it('calls upsertPlatformGames with the game platforms during relation upsert', async () => {
      stubNewGameCreation('game-catan');
      stubPlatformGameMap(['platform-tabletop', 'pg-1']);

      const gameData = bggGameData();
      await service.upsert(gameData, GATEWAY_ID);

      expect(platformService.upsertPlatformGames).toHaveBeenCalledWith(
        'game-catan',
        gameData.platforms,
        gameData,
        GATEWAY_ID,
      );
    });

    it('passes the resolved PlatformGameMap to upsertReleases', async () => {
      stubNewGameCreation('game-catan');
      const expectedMap: PlatformGameMap = new Map([['platform-tabletop', 'pg-1']]);
      platformService.upsertPlatformGames.mockResolvedValue(expectedMap);
      platformService.upsertReleases.mockResolvedValue(undefined);

      const gameData = bggGameData();
      await service.upsert(gameData, GATEWAY_ID);

      expect(platformService.upsertReleases).toHaveBeenCalledWith(expectedMap, gameData.releases, GATEWAY_ID);
    });

    it('resolves PlatformGames before calling upsertReleases (ordering guarantee)', async () => {
      stubNewGameCreation('game-witcher');

      const callOrder: string[] = [];
      platformService.upsertPlatformGames.mockImplementation(async () => {
        callOrder.push('upsertPlatformGames');
        return new Map([
          ['platform-ps5', 'pg-ps5'],
          ['platform-pc', 'pg-pc'],
        ]);
      });
      platformService.upsertReleases.mockImplementation(async () => {
        callOrder.push('upsertReleases');
      });

      await service.upsert(igdbGameData(), 'gw-igdb');

      expect(callOrder).toEqual(['upsertPlatformGames', 'upsertReleases']);
    });

    it('creates a new Game record with GameSource on first import', async () => {
      stubNewGameCreation('game-new');
      stubPlatformGameMap(['platform-tabletop', 'pg-1']);

      const result = await service.upsert(bggGameData(), GATEWAY_ID);

      expect(result.gameCreated).toBe(true);
      expect(result.sourceCreated).toBe(true);
      expect(result.gameId).toBe('game-new');
      expect(db.game.create).toHaveBeenCalled();
    });

    it('updates an existing Game record on re-import', async () => {
      stubExistingGame('game-existing');
      stubPlatformGameMap(['platform-tabletop', 'pg-1']);

      const result = await service.upsert(bggGameData(), GATEWAY_ID);

      expect(result.gameCreated).toBe(false);
      expect(result.sourceCreated).toBe(false);
      expect(result.gameId).toBe('game-existing');
      expect(db.game.update).toHaveBeenCalled();
    });

    it('bulk-links resolved taxonomy/person ids to the game via createMany', async () => {
      stubNewGameCreation('game-linked');
      stubPlatformGameMap(['platform-tabletop', 'pg-1']);
      taxonomyService.upsertMechanic.mockResolvedValue('mech-1');
      personService.upsertDesigner.mockResolvedValue('designer-1');
      db.gameMechanic.createMany.mockResolvedValue({ count: 1 } as never);
      db.gameDesigner.createMany.mockResolvedValue({ count: 1 } as never);

      await service.upsert(
        bggGameData({
          mechanics: [{ externalId: 'm-1', name: 'Trading' }],
          designers: [{ externalId: 'd-1', name: 'Klaus Teuber' }],
        }),
        GATEWAY_ID,
      );

      expect(taxonomyService.upsertMechanic).toHaveBeenCalledWith({ externalId: 'm-1', name: 'Trading' }, GATEWAY_ID);
      expect(db.gameMechanic.createMany).toHaveBeenCalledWith({
        data: [{ gameId: 'game-linked', mechanicId: 'mech-1' }],
        skipDuplicates: true,
      });
      expect(db.gameDesigner.createMany).toHaveBeenCalledWith({
        data: [{ gameId: 'game-linked', designerId: 'designer-1' }],
        skipDuplicates: true,
      });
    });

    it('dedupes ids that resolve to the same canonical before the createMany batch', async () => {
      stubNewGameCreation('game-dedup');
      stubPlatformGameMap(['platform-tabletop', 'pg-1']);
      // Two distinct source aliases collapse to one canonical mechanic id.
      taxonomyService.upsertMechanic.mockResolvedValue('mech-shared');
      db.gameMechanic.createMany.mockResolvedValue({ count: 1 } as never);

      await service.upsert(
        bggGameData({
          mechanics: [
            { externalId: 'm-1', name: 'Trading' },
            { externalId: 'm-2', name: 'Bartering' },
          ],
        }),
        GATEWAY_ID,
      );

      expect(db.gameMechanic.createMany).toHaveBeenCalledWith({
        data: [{ gameId: 'game-dedup', mechanicId: 'mech-shared' }],
        skipDuplicates: true,
      });
    });

    it('skips Game update when frozen', async () => {
      stubExistingGame('game-frozen', true);
      stubPlatformGameMap(['platform-tabletop', 'pg-1']);

      await service.upsert(bggGameData(), GATEWAY_ID);

      expect(db.game.update).not.toHaveBeenCalled();
    });

    it('recovers from a concurrent-import unique race by re-fetching the winner and updating it', async () => {
      // First lookup misses (no source yet); a concurrent job then wins the
      // create race, so our create trips the GameSource unique constraint; the
      // recovery re-fetch finds the winner.
      db.gameSource.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ gameId: 'game-raced', game: { id: 'game-raced', frozenAt: null } } as never);
      db.game.create.mockRejectedValue(uniqueViolation());
      db.game.update.mockResolvedValue({ id: 'game-raced' } as never);
      stubPlatformGameMap(['platform-tabletop', 'pg-1']);

      const result = await service.upsert(bggGameData(), GATEWAY_ID);

      expect(result).toMatchObject({ gameId: 'game-raced', gameCreated: false, sourceCreated: false });
      expect(db.game.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'game-raced' } }));
    });

    it('recovers a frozen raced game without updating it', async () => {
      db.gameSource.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ gameId: 'game-raced', game: { id: 'game-raced', frozenAt: new Date() } } as never);
      db.game.create.mockRejectedValue(uniqueViolation());
      stubPlatformGameMap(['platform-tabletop', 'pg-1']);

      const result = await service.upsert(bggGameData(), GATEWAY_ID);

      expect(result).toMatchObject({ gameId: 'game-raced', gameCreated: false });
      expect(db.game.update).not.toHaveBeenCalled();
    });

    it('rethrows the unique-constraint error when the raced source is still absent on re-fetch', async () => {
      const err = uniqueViolation();
      db.gameSource.findUnique.mockResolvedValue(null); // both lookups miss
      db.game.create.mockRejectedValue(err);

      await expect(service.upsert(bggGameData(), GATEWAY_ID)).rejects.toBe(err);
    });

    it('rethrows non-unique create failures without attempting recovery', async () => {
      const boom = new Error('connection reset');
      db.gameSource.findUnique.mockResolvedValue(null);
      db.game.create.mockRejectedValue(boom);

      await expect(service.upsert(bggGameData(), GATEWAY_ID)).rejects.toBe(boom);
      expect(db.gameSource.findUnique).toHaveBeenCalledTimes(1); // no recovery re-fetch
    });
  });

  describe('upsertExpansion', () => {
    it('creates PlatformGames for the expansion game', async () => {
      db.gameSource.findUnique
        .mockResolvedValueOnce({ gameId: 'game-base' } as GameSource) // base game lookup
        .mockResolvedValueOnce(null); // expansion game lookup (new)

      db.game.create.mockResolvedValue({ id: 'game-expansion' } as never);
      db.gameExpansion.upsert.mockResolvedValue({} as never);
      stubPlatformGameMap(['platform-tabletop', 'pg-exp']);

      const expansionData = bggGameData({
        externalId: '926',
        title: 'Catan: 5-6 Player Extension',
        contentType: ContentType.CONTENT_TYPE_EXPANSION,
      });

      await service.upsertExpansion(expansionData, '13', GATEWAY_ID);

      expect(platformService.upsertPlatformGames).toHaveBeenCalledWith(
        'game-expansion',
        expansionData.platforms,
        expansionData,
        GATEWAY_ID,
      );
    });

    it('throws NotFoundException when base game source is missing', async () => {
      db.gameSource.findUnique.mockResolvedValue(null);

      await expect(service.upsertExpansion(bggGameData(), 'missing-base', GATEWAY_ID)).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
