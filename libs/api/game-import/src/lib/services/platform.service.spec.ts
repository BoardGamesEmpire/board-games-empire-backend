import { PlatformGatewayLink, PlatformType } from '@bge/database';
import { createTestingModuleWithDb, type MockDatabaseService } from '@bge/testing';
import type { GameData, PlatformData } from '@board-games-empire/proto-gateway';
import * as proto from '@board-games-empire/proto-gateway';
import type { PlatformGameMap } from './platform.service';
import { PlatformUpsertService } from './platform.service';

describe('PlatformUpsertService', () => {
  let service: PlatformUpsertService;
  let db: MockDatabaseService;

  beforeEach(async () => {
    const { module, db: mockDb } = await createTestingModuleWithDb({
      providers: [PlatformUpsertService],
    });

    service = module.get(PlatformUpsertService);
    db = mockDb;
  });

  afterEach(() => jest.clearAllMocks());

  const GATEWAY_ID = 'gw-bgg';
  const GAME_ID = 'game-catan';

  function tabletopPlatformData(overrides: Partial<PlatformData> = {}): PlatformData {
    return {
      externalId: 'tabletop',
      name: 'Tabletop',
      abbreviation: undefined,
      platformType: proto.PlatformType.PLATFORM_TYPE_TABLETOP,
      ...overrides,
    };
  }

  function consolePlatformData(overrides: Partial<PlatformData> = {}): PlatformData {
    return {
      externalId: '48',
      name: 'PlayStation 5',
      abbreviation: 'PS5',
      platformType: proto.PlatformType.PLATFORM_TYPE_CONSOLE,
      ...overrides,
    };
  }

  function pcPlatformData(overrides: Partial<PlatformData> = {}): PlatformData {
    return {
      externalId: '6',
      name: 'PC (Microsoft Windows)',
      abbreviation: 'PC',
      platformType: proto.PlatformType.PLATFORM_TYPE_PC,
      ...overrides,
    };
  }

  function minimalGameData(overrides: Partial<GameData> = {}): GameData {
    return {
      externalId: '13',
      title: 'Catan',
      contentType: 'CONTENT_TYPE_BASE_GAME',
      platforms: [tabletopPlatformData()],
      ...overrides,
    } as GameData;
  }

  /**
   * Stubs the platform resolution chain:
   *   1. PlatformGatewayLink lookup (miss) → triggers Platform upsert
   *   2. Platform upsert → returns { id: platformId }
   */
  function stubPlatformResolution(platformId: string): void {
    db.platformGatewayLink.findUnique.mockResolvedValue(null);
    db.platform.upsert.mockResolvedValue({ id: platformId } as never);
  }

  /**
   * Stubs the platform resolution chain for an already-known platform.
   */
  function stubExistingPlatformLink(platformId: string): void {
    db.platformGatewayLink.findUnique.mockResolvedValue({ platformId } as PlatformGatewayLink);
  }

  describe('upsertPlatformGames', () => {
    it('creates a single Tabletop PlatformGame for a BGG import', async () => {
      stubPlatformResolution('platform-tabletop');
      db.platformGame.upsert.mockResolvedValue({
        id: 'pg-1',
        frozenAt: null,
      } as never);

      const gameData = minimalGameData({ minPlayers: 3, maxPlayers: 4 });
      const result = await service.upsertPlatformGames(GAME_ID, gameData.platforms, gameData, GATEWAY_ID);

      expect(db.platformGame.upsert).toHaveBeenCalledTimes(1);
      expect(db.platformGame.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { gameId_platformId: { gameId: GAME_ID, platformId: 'platform-tabletop' } },
          create: expect.objectContaining({
            gameId: GAME_ID,
            platformId: 'platform-tabletop',
            supportsLocal: true,
            hasRealtime: true,
            supportsSolo: false,
            supportsOnline: false,
          }),
        }),
      );
      expect(result.get('platform-tabletop')).toBe('pg-1');
    });

    it('creates multiple PlatformGames for an IGDB multi-platform import', async () => {
      const platforms = [consolePlatformData(), pcPlatformData()];

      // First call: PS5 platform
      db.platformGatewayLink.findUnique
        .mockResolvedValueOnce(null) // PS5 link miss
        .mockResolvedValueOnce(null); // PC link miss
      db.platform.upsert
        .mockResolvedValueOnce({ id: 'platform-ps5' } as never)
        .mockResolvedValueOnce({ id: 'platform-pc' } as never);
      db.platformGame.upsert
        .mockResolvedValueOnce({ id: 'pg-ps5', frozenAt: null } as never)
        .mockResolvedValueOnce({ id: 'pg-pc', frozenAt: null } as never);

      const gameData = minimalGameData({ platforms });
      const result = await service.upsertPlatformGames(GAME_ID, platforms, gameData, 'gw-igdb');

      expect(db.platformGame.upsert).toHaveBeenCalledTimes(2);
      expect(result.size).toBe(2);
      expect(result.get('platform-ps5')).toBe('pg-ps5');
      expect(result.get('platform-pc')).toBe('pg-pc');
    });

    it('returns an empty map when platforms list is empty', async () => {
      const result = await service.upsertPlatformGames(GAME_ID, [], minimalGameData(), GATEWAY_ID);

      expect(db.platformGame.upsert).not.toHaveBeenCalled();
      expect(result.size).toBe(0);
    });

    it('reuses an existing platform link without creating a new one', async () => {
      stubExistingPlatformLink('platform-tabletop');
      db.platformGame.upsert.mockResolvedValue({ id: 'pg-1', frozenAt: null } as never);

      const gameData = minimalGameData();
      await service.upsertPlatformGames(GAME_ID, gameData.platforms, gameData, GATEWAY_ID);

      // Platform upsert should NOT be called — existing link resolves the ID
      expect(db.platform.upsert).not.toHaveBeenCalled();
      expect(db.platformGame.upsert).toHaveBeenCalledTimes(1);
    });

    it('does not error on frozen PlatformGame (upsert still runs, frozenAt checked externally)', async () => {
      stubPlatformResolution('platform-tabletop');
      db.platformGame.upsert.mockResolvedValue({
        id: 'pg-frozen',
        frozenAt: new Date('2024-06-01'),
      } as never);

      const gameData = minimalGameData();
      const result = await service.upsertPlatformGames(GAME_ID, gameData.platforms, gameData, GATEWAY_ID);

      expect(result.get('platform-tabletop')).toBe('pg-frozen');
    });
  });

  describe('inferCapabilities', () => {
    it('sets supportsLocal and hasRealtime for Tabletop', () => {
      const caps = service.inferCapabilities(PlatformType.Tabletop, minimalGameData());

      expect(caps.supportsLocal).toBe(true);
      expect(caps.hasRealtime).toBe(true);
      expect(caps.supportsOnline).toBe(false);
      expect(caps.hasAsyncPlay).toBe(false);
      expect(caps.hasTutorial).toBe(false);
    });

    it('infers supportsSolo = true when minPlayers is 1', () => {
      const caps = service.inferCapabilities(PlatformType.Tabletop, minimalGameData({ minPlayers: 1 }));

      expect(caps.supportsSolo).toBe(true);
    });

    it('infers supportsSolo = false when minPlayers > 1', () => {
      const caps = service.inferCapabilities(PlatformType.Tabletop, minimalGameData({ minPlayers: 2 }));

      expect(caps.supportsSolo).toBe(false);
    });

    it('infers supportsSolo = false when minPlayers is not provided', () => {
      const caps = service.inferCapabilities(PlatformType.Tabletop, minimalGameData({ minPlayers: undefined }));

      expect(caps.supportsSolo).toBe(false);
    });

    it('returns conservative defaults for Console platform', () => {
      const caps = service.inferCapabilities(PlatformType.Console, minimalGameData({ minPlayers: 1 }));

      expect(caps.supportsSolo).toBe(true);
      expect(caps.supportsLocal).toBe(false);
      expect(caps.supportsOnline).toBe(false);
      expect(caps.hasAsyncPlay).toBe(false);
      expect(caps.hasRealtime).toBe(false);
      expect(caps.hasTutorial).toBe(false);
    });

    it('returns conservative defaults for PC platform', () => {
      const caps = service.inferCapabilities(PlatformType.PC, minimalGameData({ minPlayers: 3 }));

      expect(caps.supportsSolo).toBe(false);
      expect(caps.supportsLocal).toBe(false);
      expect(caps.supportsOnline).toBe(false);
    });

    it('returns conservative defaults for Mobile platform', () => {
      const caps = service.inferCapabilities(PlatformType.Mobile, minimalGameData());

      expect(caps.supportsLocal).toBe(false);
      expect(caps.supportsOnline).toBe(false);
    });
  });

  describe('upsertReleases', () => {
    it('associates a release with the correct PlatformGame via the map', async () => {
      const platformGameMap: PlatformGameMap = new Map([['platform-ps5', 'pg-ps5']]);

      stubExistingPlatformLink('platform-ps5');
      db.gameRelease.upsert.mockResolvedValue({ id: 'release-1' } as never);

      await service.upsertReleases(
        platformGameMap,
        [
          {
            externalId: 'rd-1',
            platform: consolePlatformData(),
            status: proto.ReleaseStatus.RELEASE_STATUS_RELEASED,
            releaseDate: '2024-01-15',
            localizations: [],
            languages: [],
          },
        ],
        'gw-igdb',
      );

      expect(db.gameRelease.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { platformGameId_region: { platformGameId: 'pg-ps5', region: expect.any(String) } },
          create: expect.objectContaining({
            platformGameId: 'pg-ps5',
          }),
        }),
      );
    });

    it('skips a release when its platform is not in the map', async () => {
      const platformGameMap: PlatformGameMap = new Map(); // empty — no platforms resolved

      stubExistingPlatformLink('platform-unknown');

      await service.upsertReleases(
        platformGameMap,
        [
          {
            externalId: 'rd-1',
            platform: consolePlatformData({ externalId: 'unknown' }),
            status: proto.ReleaseStatus.RELEASE_STATUS_RELEASED,
            localizations: [],
            languages: [],
          },
        ],
        'gw-igdb',
      );

      expect(db.gameRelease.upsert).not.toHaveBeenCalled();
    });

    it('handles multiple releases across different PlatformGames', async () => {
      const platformGameMap: PlatformGameMap = new Map([
        ['platform-ps5', 'pg-ps5'],
        ['platform-pc', 'pg-pc'],
      ]);

      db.platformGatewayLink.findUnique
        .mockResolvedValueOnce({ platformId: 'platform-ps5' } as PlatformGatewayLink)
        .mockResolvedValueOnce({ platformId: 'platform-pc' } as PlatformGatewayLink);

      db.gameRelease.upsert
        .mockResolvedValueOnce({ id: 'release-ps5' } as never)
        .mockResolvedValueOnce({ id: 'release-pc' } as never);

      await service.upsertReleases(
        platformGameMap,
        [
          {
            externalId: 'rd-ps5',
            platform: consolePlatformData(),
            status: proto.ReleaseStatus.RELEASE_STATUS_RELEASED,
            localizations: [],
            languages: [],
          },
          {
            externalId: 'rd-pc',
            platform: pcPlatformData(),
            status: proto.ReleaseStatus.RELEASE_STATUS_EARLY_ACCESS,
            localizations: [],
            languages: [],
          },
        ],
        'gw-igdb',
      );

      expect(db.gameRelease.upsert).toHaveBeenCalledTimes(2);

      // Verify each release points to the correct PlatformGame
      const calls = db.gameRelease.upsert.mock.calls;
      expect(calls[0][0]).toEqual(
        expect.objectContaining({
          create: expect.objectContaining({ platformGameId: 'pg-ps5' }),
        }),
      );
      expect(calls[1][0]).toEqual(
        expect.objectContaining({
          create: expect.objectContaining({ platformGameId: 'pg-pc' }),
        }),
      );
    });

    it('upserts language associations for each release', async () => {
      const platformGameMap: PlatformGameMap = new Map([['platform-ps5', 'pg-ps5']]);

      stubExistingPlatformLink('platform-ps5');
      db.gameRelease.upsert.mockResolvedValue({ id: 'release-1' } as never);
      db.language.upsert.mockResolvedValue({ id: 'lang-eng' } as never);
      db.gameReleaseLanguage.upsert.mockResolvedValue({} as never);

      await service.upsertReleases(
        platformGameMap,
        [
          {
            externalId: 'rd-1',
            platform: consolePlatformData(),
            status: proto.ReleaseStatus.RELEASE_STATUS_RELEASED,
            localizations: [],
            languages: [{ iso6393: 'eng', iso6391: 'en', name: 'English' }],
          },
        ],
        'gw-igdb',
      );

      expect(db.language.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { code: 'eng' },
        }),
      );
      expect(db.gameReleaseLanguage.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { releaseId_languageId: { releaseId: 'release-1', languageId: 'lang-eng' } },
        }),
      );
    });

    it('skips languages with missing iso6393 code', async () => {
      const platformGameMap: PlatformGameMap = new Map([['platform-ps5', 'pg-ps5']]);

      stubExistingPlatformLink('platform-ps5');
      db.gameRelease.upsert.mockResolvedValue({ id: 'release-1' } as never);

      await service.upsertReleases(
        platformGameMap,
        [
          {
            externalId: 'rd-1',
            platform: consolePlatformData(),
            status: proto.ReleaseStatus.RELEASE_STATUS_RELEASED,
            localizations: [],
            languages: [{ iso6393: '', name: 'Unknown' } as never],
          },
        ],
        'gw-igdb',
      );

      expect(db.language.upsert).not.toHaveBeenCalled();
    });

    it('is a no-op when releases list is empty', async () => {
      const platformGameMap: PlatformGameMap = new Map([['platform-tabletop', 'pg-1']]);

      await service.upsertReleases(platformGameMap, [], GATEWAY_ID);

      expect(db.gameRelease.upsert).not.toHaveBeenCalled();
    });
  });

  describe('upsertPlatform', () => {
    it('returns existing platformId when gateway link exists', async () => {
      stubExistingPlatformLink('platform-existing');

      const result = await service.upsertPlatform(tabletopPlatformData(), GATEWAY_ID);

      expect(result).toBe('platform-existing');
      expect(db.platform.upsert).not.toHaveBeenCalled();
    });

    it('creates Platform and PlatformGatewayLink when no link exists', async () => {
      stubPlatformResolution('platform-new');

      const result = await service.upsertPlatform(tabletopPlatformData(), GATEWAY_ID);

      expect(result).toBe('platform-new');
      expect(db.platform.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { slug: 'tabletop' },
          create: expect.objectContaining({
            name: 'Tabletop',
            slug: 'tabletop',
            platformType: PlatformType.Tabletop,
            gatewayLinks: {
              create: { gatewayId: GATEWAY_ID, externalId: 'tabletop' },
            },
          }),
        }),
      );
    });

    it('connectsOrCreates gateway link on update path (cross-gateway same platform)', async () => {
      db.platformGatewayLink.findUnique.mockResolvedValue(null);
      db.platform.upsert.mockResolvedValue({ id: 'platform-shared' } as never);

      await service.upsertPlatform(pcPlatformData({ externalId: 'steam-6' }), 'gw-steam');

      expect(db.platform.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: {
            gatewayLinks: {
              connectOrCreate: {
                where: { gatewayId_externalId: { gatewayId: 'gw-steam', externalId: 'steam-6' } },
                create: { gatewayId: 'gw-steam', externalId: 'steam-6' },
              },
            },
          },
        }),
      );
    });
  });
});
