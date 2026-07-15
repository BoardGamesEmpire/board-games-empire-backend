import type { GameRelease, PlatformGatewayLink } from '@bge/database';
import { PlatformType } from '@bge/database';
import { LanguageLinkService } from '@bge/language';
import { createTestingModuleWithDb, type MockDatabaseService } from '@bge/testing';
import type { GameData, PlatformData } from '@boardgamesempire/proto-gateway';
import * as proto from '@boardgamesempire/proto-gateway';
import { Logger } from '@nestjs/common';
import type { PlatformGameMap } from './platform.service';
import { PlatformUpsertService } from './platform.service';
import { ReleaseGraphResolver } from './release-graph.resolver';

describe('PlatformUpsertService', () => {
  let service: PlatformUpsertService;
  let db: MockDatabaseService;
  let languageLinks: { resolveLanguageData: jest.Mock };

  beforeEach(async () => {
    languageLinks = { resolveLanguageData: jest.fn() };

    const { module, db: mockDb } = await createTestingModuleWithDb({
      providers: [
        PlatformUpsertService,
        ReleaseGraphResolver,
        { provide: LanguageLinkService, useValue: languageLinks },
      ],
    });

    service = module.get(PlatformUpsertService);
    db = mockDb;
  });

  beforeEach(() => {
    db.gameRelease.findFirst.mockResolvedValue(null);
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
   * Stubs the platform resolution chain for an already-known platform
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
      db.gameRelease.upsert.mockResolvedValue({ id: 'release-1' } as GameRelease);

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
          where: {
            platformGameId_editionKey_region: {
              platformGameId: 'pg-ps5',
              editionKey: 'rd-1',
              region: expect.any(String),
            },
          },
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

    it('attaches resolved language tags for each release', async () => {
      const platformGameMap: PlatformGameMap = new Map([['platform-ps5', 'pg-ps5']]);

      stubExistingPlatformLink('platform-ps5');
      db.gameRelease.upsert.mockResolvedValue({ id: 'release-1' } as never);
      languageLinks.resolveLanguageData.mockResolvedValue('tag-en');
      db.gameReleaseLanguage.upsert.mockResolvedValue({} as never);

      await service.upsertReleases(
        platformGameMap,
        [
          {
            externalId: 'rd-1',
            platform: consolePlatformData(),
            status: proto.ReleaseStatus.RELEASE_STATUS_RELEASED,
            localizations: [],
            languages: [{ ietfTag: 'en', iso6393: 'eng', iso6391: 'en', name: 'English' }],
          },
        ],
        'gw-igdb',
      );

      expect(languageLinks.resolveLanguageData).toHaveBeenCalledWith('gw-igdb', {
        ietfTag: 'en',
        iso6393: 'eng',
        iso6391: 'en',
        name: 'English',
      });
      expect(db.gameReleaseLanguage.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { releaseId_languageTagId: { releaseId: 'release-1', languageTagId: 'tag-en' } },
        }),
      );
    });

    it('skips languages that do not resolve to a tag (pending/unresolved links)', async () => {
      const platformGameMap: PlatformGameMap = new Map([['platform-ps5', 'pg-ps5']]);

      stubExistingPlatformLink('platform-ps5');
      db.gameRelease.upsert.mockResolvedValue({ id: 'release-1' } as never);
      languageLinks.resolveLanguageData.mockResolvedValue(null);

      await service.upsertReleases(
        platformGameMap,
        [
          {
            externalId: 'rd-1',
            platform: consolePlatformData(),
            status: proto.ReleaseStatus.RELEASE_STATUS_RELEASED,
            localizations: [],
            languages: [{ name: 'Klingon' }],
          },
        ],
        'gw-igdb',
      );

      expect(db.gameReleaseLanguage.upsert).not.toHaveBeenCalled();
    });

    it('is a no-op when releases list is empty', async () => {
      const platformGameMap: PlatformGameMap = new Map([['platform-tabletop', 'pg-1']]);

      await service.upsertReleases(platformGameMap, [], GATEWAY_ID);

      expect(db.gameRelease.upsert).not.toHaveBeenCalled();
    });
  });

  describe('upsertReleases — duplicate edition keys', () => {
    function bggReleaseData(overrides: Partial<proto.GameReleaseData> = {}): proto.GameReleaseData {
      return {
        externalId: 'rel-1',
        platform: tabletopPlatformData(),
        status: proto.ReleaseStatus.RELEASE_STATUS_RELEASED,
        localizations: [],
        languages: [],
        ...overrides,
      } as proto.GameReleaseData;
    }

    it('warns when the same (editionKey, region) appears twice in a batch', async () => {
      const map: PlatformGameMap = new Map([['platform-tabletop', 'pg-1']]);
      stubExistingPlatformLink('platform-tabletop');
      db.gameRelease.upsert.mockResolvedValue({ id: 'release-1' } as never);
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      await service.upsertReleases(
        map,
        [bggReleaseData({ externalId: 'dup-key' }), bggReleaseData({ externalId: 'dup-key' })],
        GATEWAY_ID,
      );

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Duplicate (editionKey=dup-key'));
    });

    it('does not warn when the same editionKey appears in different regions', async () => {
      const map: PlatformGameMap = new Map([['platform-tabletop', 'pg-1']]);
      stubExistingPlatformLink('platform-tabletop');
      db.gameRelease.upsert.mockResolvedValue({ id: 'release-1' } as never);
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      await service.upsertReleases(
        map,
        [
          bggReleaseData({
            externalId: 'shared-key',
            localizations: [{ region: { externalId: 'us', name: 'NA', regionCode: 'us' } }],
          }),
          bggReleaseData({
            externalId: 'shared-key',
            localizations: [{ region: { externalId: 'eu', name: 'EU', regionCode: 'eu' } }],
          }),
        ],
        GATEWAY_ID,
      );

      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('Duplicate'));
    });

    it('does not warn when the same editionKey appears across different PlatformGames', async () => {
      const map: PlatformGameMap = new Map([
        ['platform-ps5', 'pg-ps5'],
        ['platform-pc', 'pg-pc'],
      ]);
      db.platformGatewayLink.findUnique
        .mockResolvedValueOnce({ platformId: 'platform-ps5' } as PlatformGatewayLink)
        .mockResolvedValueOnce({ platformId: 'platform-pc' } as PlatformGatewayLink);
      db.gameRelease.upsert.mockResolvedValue({ id: 'release-1' } as never);
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      await service.upsertReleases(
        map,
        [
          bggReleaseData({ externalId: 'shared-key', platform: consolePlatformData() }),
          bggReleaseData({ externalId: 'shared-key', platform: pcPlatformData() }),
        ],
        'gw-igdb',
      );

      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('Duplicate'));
    });

    it('still upserts both occurrences (the second overwrites on the unique row)', async () => {
      const map: PlatformGameMap = new Map([['platform-tabletop', 'pg-1']]);
      stubExistingPlatformLink('platform-tabletop');
      db.gameRelease.upsert.mockResolvedValue({ id: 'release-1' } as never);

      await service.upsertReleases(
        map,
        [
          bggReleaseData({ externalId: 'dup-key', editionName: 'First Occurrence' }),
          bggReleaseData({ externalId: 'dup-key', editionName: 'Second Occurrence' }),
        ],
        GATEWAY_ID,
      );

      expect(db.gameRelease.upsert).toHaveBeenCalledTimes(2);
      const lastCall = db.gameRelease.upsert.mock.calls[1][0];
      expect(lastCall.create).toEqual(expect.objectContaining({ editionName: 'Second Occurrence' }));
    });
  });

  describe('upsertReleases — edition fields', () => {
    function bggReleaseData(overrides: Partial<proto.GameReleaseData> = {}): proto.GameReleaseData {
      return {
        externalId: '416798',
        platform: tabletopPlatformData(),
        status: proto.ReleaseStatus.RELEASE_STATUS_RELEASED,
        editionName: 'Afrikaans edition',
        releaseYear: 2020,

        localizations: [],
        languages: [],
        ...overrides,
      } as proto.GameReleaseData;
    }

    it('persists edition fields on create', async () => {
      const map: PlatformGameMap = new Map([['platform-tabletop', 'pg-1']]);
      stubExistingPlatformLink('platform-tabletop');
      db.gameRelease.upsert.mockResolvedValue({ id: 'release-1' } as never);

      await service.upsertReleases(
        map,
        [bggReleaseData({ externalId: '416798', editionName: '5th Edition', releaseYear: 2015 })],
        GATEWAY_ID,
      );

      expect(db.gameRelease.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            platformGameId_editionKey_region: {
              platformGameId: 'pg-1',
              editionKey: '416798',
              region: 'Worldwide',
            },
          },
          create: expect.objectContaining({
            editionKey: '416798',
            editionName: '5th Edition',
            releaseYear: 2015,
          }),
        }),
      );
    });

    it('coerces empty externalId to the default edition key sentinel', async () => {
      const map: PlatformGameMap = new Map([['platform-tabletop', 'pg-1']]);
      stubExistingPlatformLink('platform-tabletop');
      db.gameRelease.upsert.mockResolvedValue({ id: 'release-1' } as never);

      await service.upsertReleases(map, [bggReleaseData({ externalId: '' })], GATEWAY_ID);

      expect(db.gameRelease.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            platformGameId_editionKey_region: expect.objectContaining({ editionKey: 'default' }),
          }),
        }),
      );
    });

    it('persists edition-level gameplay overrides when present', async () => {
      const map: PlatformGameMap = new Map([['platform-tabletop', 'pg-1']]);
      stubExistingPlatformLink('platform-tabletop');
      db.gameRelease.upsert.mockResolvedValue({ id: 'release-1' } as never);

      await service.upsertReleases(
        map,
        [
          bggReleaseData({
            externalId: '999',
            minPlayers: 2,
            maxPlayers: 6,
            minPlaytime: 90,
            maxPlaytime: 150,
          }),
        ],
        GATEWAY_ID,
      );

      expect(db.gameRelease.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            minPlayers: 2,
            maxPlayers: 6,
            minPlayTime: 90,
            maxPlayTime: 150,
          }),
        }),
      );
    });
  });

  describe('upsertReleases — parent hierarchy', () => {
    function bggReleaseData(overrides: Partial<proto.GameReleaseData> = {}): proto.GameReleaseData {
      return {
        externalId: 'rel-1',
        platform: tabletopPlatformData(),
        status: proto.ReleaseStatus.RELEASE_STATUS_RELEASED,

        localizations: [],
        languages: [],
        ...overrides,
      } as proto.GameReleaseData;
    }

    it('applies parentReleaseId in a second pass for in-batch parent references', async () => {
      const map: PlatformGameMap = new Map([['platform-tabletop', 'pg-1']]);
      stubExistingPlatformLink('platform-tabletop');
      db.gameRelease.findFirst.mockResolvedValue(null);
      db.gameRelease.upsert
        .mockResolvedValueOnce({ id: 'release-parent' } as never)
        .mockResolvedValueOnce({ id: 'release-child' } as never);
      db.gameRelease.update.mockResolvedValue({} as never);

      await service.upsertReleases(
        map,
        [
          bggReleaseData({ externalId: 'parent-edition' }),
          bggReleaseData({ externalId: 'child-edition', parentEditionExternalId: 'parent-edition' }),
        ],
        GATEWAY_ID,
      );

      expect(db.gameRelease.update).toHaveBeenCalledWith({
        where: { id: 'release-child' },
        data: { parentReleaseId: 'release-parent' },
      });
    });

    it('does not call update when no parent references are present', async () => {
      const map: PlatformGameMap = new Map([['platform-tabletop', 'pg-1']]);
      stubExistingPlatformLink('platform-tabletop');
      db.gameRelease.findFirst.mockResolvedValue(null);
      db.gameRelease.upsert.mockResolvedValue({ id: 'release-1' } as never);

      await service.upsertReleases(map, [bggReleaseData({ externalId: 'lonely' })], GATEWAY_ID);

      expect(db.gameRelease.update).not.toHaveBeenCalled();
    });

    it('does not call update for unresolved parent references', async () => {
      const map: PlatformGameMap = new Map([['platform-tabletop', 'pg-1']]);
      stubExistingPlatformLink('platform-tabletop');
      db.gameRelease.findFirst.mockResolvedValue(null);
      db.gameRelease.upsert.mockResolvedValue({ id: 'release-1' } as never);

      await service.upsertReleases(
        map,
        [bggReleaseData({ externalId: 'orphan', parentEditionExternalId: 'missing' })],
        GATEWAY_ID,
      );

      expect(db.gameRelease.update).not.toHaveBeenCalled();
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
