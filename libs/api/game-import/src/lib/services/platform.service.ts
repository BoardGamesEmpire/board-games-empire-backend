import { DatabaseService, PlatformType } from '@bge/database';
import type { GameData, GameReleaseData, LanguageData, PlatformData } from '@boardgamesempire/proto-gateway';
import { Injectable, Logger } from '@nestjs/common';
import { toEditionKey, toPlatformType, toReleaseDate, toReleaseRegion, toReleaseStatus } from './helpers';
import { ReleaseGraphResolver } from './release-graph.resolver';

export type PlatformGameMap = Map<string, string>;

/**
 * Internal — maps a release's editionKey to its persisted DB id within
 * a single import call. Used by applyParentHierarchy to resolve the
 * second-pass parentReleaseId after all releases are upserted.
 */
type ReleaseIdMap = Map<string, string>;

@Injectable()
export class PlatformUpsertService {
  private readonly logger = new Logger(PlatformUpsertService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly releaseGraphResolver: ReleaseGraphResolver,
  ) {}

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

      const existingPlatformGame = await this.db.platformGame.findUnique({
        where: { gameId_platformId: { gameId, platformId } },
        select: { id: true, frozenAt: true },
      });

      if (existingPlatformGame?.frozenAt) {
        this.logger.debug(`Skipped capability update for frozen PlatformGame id=${existingPlatformGame.id}`);
        map.set(platformId, existingPlatformGame.id);
        continue;
      }

      const platformGame = await this.db.platformGame.upsert({
        where: { gameId_platformId: { gameId, platformId } },
        create: {
          gameId,
          platformId,
          ...capabilities,
        },
        update: {
          ...capabilities,
        },
        select: { id: true, frozenAt: true },
      });

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
   * Upserts all GameRelease rows from the proto releases list and applies
   * edition hierarchy in a second pass.
   *
   * Algorithm:
   *   1. Group incoming releases by their resolved PlatformGame.id
   *      (via the platformGameMap)
   *   2. For each PG batch, pre-resolve parent map via
   *      ReleaseGraphResolver.
   *   3. Upsert each release on (platformGameId, editionKey, region),
   *      capturing editionKey → DB id for second pass.
   *   4. Apply parentReleaseId from the parent map.
   *   5. Upsert language associations as before.
   *
   * Releases targeting an unresolved Platform (no entry in platformGameMap)
   * are skipped with a warning — preserving the existing behavior.
   */
  async upsertReleases(
    platformGameMap: PlatformGameMap,
    releases: GameReleaseData[],
    gatewayId: string,
  ): Promise<void> {
    if (releases.length === 0) {
      return;
    }

    const releasesByPG = await this.groupReleasesByPlatformGame(platformGameMap, releases, gatewayId);
    for (const [platformGameId, batch] of releasesByPG.entries()) {
      const parentMap = this.releaseGraphResolver.preResolve(batch);
      const releaseIdMap: ReleaseIdMap = new Map();

      for (const release of batch) {
        const editionKey = toEditionKey(release.externalId);
        const region = toReleaseRegion(release.localizations);

        const persisted = await this.upsertSingleRelease({
          platformGameId,
          editionKey,
          region,
          release,
        });

        releaseIdMap.set(editionKey, persisted.id);

        await this.upsertReleaseLanguages(persisted.id, release.languages ?? []);
      }

      await this.applyParentHierarchy(releaseIdMap, parentMap);
    }
  }

  /**
   * Groups proto releases by the resolved PlatformGame.id from the supplied
   * map. Releases whose Platform is unresolvable are dropped with a warning.
   *
   * Also detects duplicate (editionKey, region) pairs within a single
   * PlatformGame's batch — the second and later occurrences will overwrite
   * earlier upserts on the unique constraint, which can quietly destroy
   * data when a gateway emits the same edition under different metadata.
   */
  private async groupReleasesByPlatformGame(
    platformGameMap: PlatformGameMap,
    releases: readonly GameReleaseData[],
    gatewayId: string,
  ): Promise<Map<string, GameReleaseData[]>> {
    const grouped = new Map<string, GameReleaseData[]>();
    const seenByPG = new Map<string, Set<string>>();

    for (const release of releases) {
      if (!release.platform) {
        this.logger.warn(`Skipping release editionKey=${release.externalId} — missing platform`);
        continue;
      }

      const platformId = await this.upsertPlatform(release.platform, gatewayId);
      const platformGameId = platformGameMap.get(platformId);

      if (!platformGameId) {
        this.logger.warn(`No PlatformGame found for platformId=${platformId} during release upsert — skipping release`);
        continue;
      }

      const editionKey = toEditionKey(release.externalId);
      const region = toReleaseRegion(release.localizations);
      const dedupKey = `${editionKey}:${region}`;

      const seen = seenByPG.get(platformGameId) ?? new Set<string>();
      if (seen.has(dedupKey)) {
        this.logger.warn(
          `Duplicate (editionKey=${editionKey}, region=${region}) within import batch ` +
            `for platformGameId=${platformGameId}; later occurrence will overwrite earlier ` +
            `via upsert. If this represents a legitimate distinct release (reprint, ` +
            `regional publisher split), the GameRelease unique constraint needs revisiting.`,
        );
      }
      seen.add(dedupKey);
      seenByPG.set(platformGameId, seen);

      const bucket = grouped.get(platformGameId) ?? [];
      bucket.push(release);
      grouped.set(platformGameId, bucket);
    }

    return grouped;
  }

  /**
   * Performs the upsert for a single release. Edition fields are written
   * on both create and update paths — gateways are the source of truth
   * for edition-name / release-year / overrides, and re-imports should
   * pick up corrected values upstream.
   *
   * parentReleaseId is intentionally not set here; it's applied in the
   * second pass via applyParentHierarchy after all releases are persisted.
   */
  private async upsertSingleRelease(args: {
    platformGameId: string;
    editionKey: string;
    region: ReturnType<typeof toReleaseRegion>;
    release: GameReleaseData;
  }): Promise<{ id: string }> {
    const { platformGameId, editionKey, region, release } = args;

    const editionFields = {
      editionName: release.editionName ?? null,
      releaseYear: release.releaseYear ?? null,
      minPlayers: release.minPlayers ?? null,
      maxPlayers: release.maxPlayers ?? null,
      minPlayTime: release.minPlaytime ?? null,
      maxPlayTime: release.maxPlaytime ?? null,
    };

    return this.db.gameRelease.upsert({
      where: {
        platformGameId_editionKey_region: { platformGameId, editionKey, region },
      },
      create: {
        platformGameId,
        editionKey,
        region,
        status: toReleaseStatus(release.status),
        releaseDate: toReleaseDate(release.releaseDate),
        ...editionFields,
      },
      update: {
        status: toReleaseStatus(release.status),
        releaseDate: toReleaseDate(release.releaseDate),
        editionName: editionFields.editionName,
        releaseYear: editionFields.releaseYear,
        minPlayers: editionFields.minPlayers,
        maxPlayers: editionFields.maxPlayers,
        minPlayTime: editionFields.minPlayTime,
        maxPlayTime: editionFields.maxPlayTime,
      },
      select: { id: true },
    });
  }

  /**
   * Second pass: now that every release has a DB id, walk the parent
   * map and apply parentReleaseId. Skipped entries (parent not present
   * in this batch) leave parentReleaseId at its existing value — null
   * for new releases, preserved for re-imports.
   */
  private async applyParentHierarchy(
    releaseIdMap: ReleaseIdMap,
    parentMap: ReadonlyMap<string, string>,
  ): Promise<void> {
    for (const [childEditionKey, parentEditionKey] of parentMap.entries()) {
      const childId = releaseIdMap.get(childEditionKey);
      const parentId = releaseIdMap.get(parentEditionKey);

      if (!childId || !parentId) {
        // Defensive — preResolve already filters orphans. This branch should
        // be unreachable.
        this.logger.warn(
          `Could not apply parent hierarchy: child=${childEditionKey} (${childId ?? 'missing'}), ` +
            `parent=${parentEditionKey} (${parentId ?? 'missing'})`,
        );
        continue;
      }

      await this.db.gameRelease.update({
        where: { id: childId },
        data: { parentReleaseId: parentId },
      });
    }
  }

  /**
   * Upserts language associations for a single release. Skips entries
   * with missing iso6393 (the stable Language.code key).
   */
  private async upsertReleaseLanguages(releaseId: string, languages: readonly LanguageData[]): Promise<void> {
    for (const lang of languages) {
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
