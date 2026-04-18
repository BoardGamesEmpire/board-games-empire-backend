import { DatabaseService } from '@bge/database';
import type { GameReleaseData, LanguageData, PlatformData } from '@board-games-empire/proto-gateway';
import { Injectable, Logger } from '@nestjs/common';
import { toPlatformType, toReleaseDate, toReleaseRegion, toReleaseStatus } from './helpers';

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
   * Upserts all GameRelease rows for a game from the proto releases list,
   * including per-release language associations.
   */
  async upsertReleases(gameId: string, releases: GameReleaseData[], gatewayId: string): Promise<void> {
    for (const release of releases) {
      const platformId = await this.upsertPlatform(release.platform!, gatewayId);
      const region = toReleaseRegion(release.localizations);

      const { id: releaseId } = await this.db.gameRelease.upsert({
        where: { gameId_platformId_region: { gameId, platformId, region } },
        create: {
          gameId,
          platformId,
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

  private toSlug(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  }
}
