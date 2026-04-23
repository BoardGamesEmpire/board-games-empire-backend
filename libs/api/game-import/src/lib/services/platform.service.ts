import { DatabaseService, PlatformType } from '@bge/database';
import type { GameData, GameReleaseData, LanguageData, PlatformData } from '@board-games-empire/proto-gateway';
import { Injectable, Logger } from '@nestjs/common';
import { toPlatformType, toReleaseDate, toReleaseRegion, toReleaseStatus } from './helpers';

export type PlatformGameMap = Map<string, string>;

@Injectable()
export class PlatformUpsertService {
  private readonly logger = new Logger(PlatformUpsertService.name);

  constructor(private readonly db: DatabaseService) {}

  /**
   * Resolves a canonical Platform record for the given proto PlatformData,
   * creating it alongside its gateway link if not already present.
   * Deduplicates on gatewayId + externalId.
   */
  async upsertPlatform(data: PlatformData, gatewayId: string): Promise<string> {
    const existing = await this.db.platformGatewayLink.findUnique({
      where: { gatewayId_externalId: { gatewayId, externalId: data.externalId } },
      select: { platformId: true },
    });

    if (existing) {
      return existing.platformId;
    }

    const slug = this.toSlug(data.name);
    this.logger.debug(`Upserting platform ${data.name} (${gatewayId}:${data.externalId})`);

    // Platform may already exist under a different gateway link (e.g. Steam PC
    // and IGDB PC are the same platform — first-importer-wins on slug).
    const platform = await this.db.platform.upsert({
      where: { slug },
      create: {
        name: data.name,
        slug,
        abbreviation: data.abbreviation,
        platformType: toPlatformType(data.platformType),
        gatewayLinks: {
          create: { gatewayId, externalId: data.externalId },
        },
      },
      update: {
        gatewayLinks: {
          connectOrCreate: {
            where: { gatewayId_externalId: { gatewayId, externalId: data.externalId } },
            create: { gatewayId, externalId: data.externalId },
          },
        },
      },
      select: { id: true },
    });

    return platform.id;
  }

  /**
   * Creates or updates PlatformGame records for each platform in the list.
   * Returns a map of Platform.id → PlatformGame.id for use by downstream
   * methods (e.g. upsertReleases).
   *
   * Capabilities are inferred from platform type and game data:
   *   - Tabletop: supportsLocal=true, hasRealtime=true
   *   - All: supportsSolo derived from minPlayers <= 1
   *   - Digital platforms: conservative defaults (false) until enrichment
   *
   * Respects frozenAt — skips updates for frozen PlatformGame records.
   */
  async upsertPlatformGames(
    gameId: string,
    platforms: PlatformData[],
    gameData: GameData,
    gatewayId: string,
  ): Promise<PlatformGameMap> {
    const map: PlatformGameMap = new Map();

    for (const platformData of platforms) {
      const platformId = await this.upsertPlatform(platformData, gatewayId);
      const platformType = toPlatformType(platformData.platformType);
      const capabilities = this.inferCapabilities(platformType, gameData);

      const platformGame = await this.db.platformGame.upsert({
        where: { gameId_platformId: { gameId, platformId } },
        create: {
          gameId,
          platformId,
          ...capabilities,
        },
        update: {
          // Only update capabilities if not frozen
          ...capabilities,
        },
        select: { id: true, frozenAt: true },
      });

      if (platformGame.frozenAt) {
        this.logger.debug(`Skipped capability update for frozen PlatformGame id=${platformGame.id}`);
      }

      map.set(platformId, platformGame.id);
    }

    return map;
  }

  /**
   * Upserts a Language record on iso6393 (the stable key).
   * Does not overwrite systemSupported — seeds own that flag.
   */
  async upsertLanguage(data: LanguageData): Promise<string> {
    const language = await this.db.language.upsert({
      where: { code: data.iso6393 },
      create: {
        code: data.iso6393,
        abbreviation: data.iso6391 ?? null,
        name: data.name,
        systemSupported: false,
      },
      update: {},
      select: { id: true },
    });

    return language.id;
  }

  /**
   * Upserts all GameRelease rows from the proto releases list.
   * Releases are now children of PlatformGame (not Game directly).
   * The platformGameMap provides the resolved PlatformGame.id for each Platform.id.
   */
  async upsertReleases(
    platformGameMap: PlatformGameMap,
    releases: GameReleaseData[],
    gatewayId: string,
  ): Promise<void> {
    for (const release of releases) {
      const platformId = await this.upsertPlatform(release.platform!, gatewayId);
      const platformGameId = platformGameMap.get(platformId);

      if (!platformGameId) {
        this.logger.warn(`No PlatformGame found for platformId=${platformId} during release upsert — skipping release`);
        continue;
      }

      const region = toReleaseRegion(release.localizations);

      const { id: releaseId } = await this.db.gameRelease.upsert({
        where: { platformGameId_region: { platformGameId, region } },
        create: {
          platformGameId,
          region,
          status: toReleaseStatus(release.status),
          releaseDate: toReleaseDate(release.releaseDate),
        },
        update: {
          status: toReleaseStatus(release.status),
          releaseDate: toReleaseDate(release.releaseDate),
        },
        select: { id: true },
      });

      for (const lang of release.languages ?? []) {
        if (!lang.iso6393) {
          this.logger.warn(
            `Release ${releaseId} has language with missing iso6393 code, skipping: ${JSON.stringify(lang)}`,
          );
          continue;
        }

        const languageId = await this.upsertLanguage(lang);
        await this.db.gameReleaseLanguage.upsert({
          where: { releaseId_languageId: { releaseId, languageId } },
          create: { releaseId, languageId },
          update: {},
        });
      }
    }
  }

  /**
   * Infers PlatformGame capability defaults based on platform type and game data.
   * Tabletop games get sensible physical-game defaults.
   * Digital platforms get conservative defaults until enrichment provides data.
   */
  inferCapabilities(
    platformType: PlatformType,
    gameData: GameData,
  ): {
    supportsSolo: boolean;
    supportsLocal: boolean;
    supportsOnline: boolean;
    hasAsyncPlay: boolean;
    hasRealtime: boolean;
    hasTutorial: boolean;
  } {
    const supportsSolo = gameData.minPlayers != null && gameData.minPlayers <= 1;

    if (platformType === PlatformType.Tabletop) {
      return {
        supportsSolo,
        supportsLocal: true,
        supportsOnline: false,
        hasAsyncPlay: false,
        hasRealtime: true,
        hasTutorial: false,
      };
    }

    // Digital platforms — conservative defaults
    return {
      supportsSolo,
      supportsLocal: false,
      supportsOnline: false,
      hasAsyncPlay: false,
      hasRealtime: false,
      hasTutorial: false,
    };
  }

  private toSlug(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  }
}
