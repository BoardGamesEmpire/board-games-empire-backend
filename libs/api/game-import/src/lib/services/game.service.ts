import {
  ContentType,
  DatabaseService,
  ExpansionType,
  isPrismaUniqueConstraintError,
  Prisma,
  Visibility,
} from '@bge/database';
import { DlcData, type GameData, ContentType as ProtoContentType } from '@boardgamesempire/proto-gateway';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { ImportJobResult, PlatformGameRef } from '../interfaces/import-job.interface';
import { toReleaseDate, toReleaseRegion } from './helpers';
import { PersonUpsertService } from './person.service';
import { PlatformUpsertService } from './platform.service';
import { TaxonomyUpsertService } from './taxonomy.service';

@Injectable()
export class GameUpsertService {
  private readonly logger = new Logger(GameUpsertService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly taxonomy: TaxonomyUpsertService,
    private readonly persons: PersonUpsertService,
    private readonly platform: PlatformUpsertService,
  ) {}

  async upsert(gameData: GameData, gatewayId: string): Promise<ImportJobResult> {
    const { gameId, gameCreated, sourceCreated } = await this.upsertGameRecord(gameData, gatewayId);

    const platformGames = await this.upsertRelations(gameId, gameData, gatewayId);
    return { gameId, gameCreated, sourceCreated, platformGames };
  }

  async upsertExpansion(gameData: GameData, baseGameExternalId: string, gatewayId: string): Promise<ImportJobResult> {
    const baseSource = await this.db.gameSource.findUnique({
      where: { gatewayId_externalId: { gatewayId, externalId: baseGameExternalId } },
      select: { gameId: true },
    });

    if (!baseSource) {
      throw new NotFoundException(
        `Base game source not found for gatewayId=${gatewayId} externalId=${baseGameExternalId}. ` +
          `The base game import must complete before expansions.`,
      );
    }

    const { gameId, gameCreated, sourceCreated } = await this.upsertGameRecord(gameData, gatewayId);
    const platformGames = await this.upsertRelations(gameId, gameData, gatewayId);

    const baseGameId = baseSource.gameId;
    const contentType = toDbContentType(gameData.contentType);

    await this.db.gameExpansion.upsert({
      where: { baseGameId_expansionGameId: { baseGameId, expansionGameId: gameId } },
      create: {
        baseGameId,
        expansionGameId: gameId,
        expansionType: toExpansionType(contentType),
        isStandalone: contentType === ContentType.StandaloneExpansion,
      },
      update: {
        expansionType: toExpansionType(contentType),
        isStandalone: contentType === ContentType.StandaloneExpansion,
      },
    });

    return { gameId, gameCreated, sourceCreated, baseGameId, platformGames };
  }

  private async upsertGameRecord(
    gameData: GameData,
    gatewayId: string,
  ): Promise<{ gameId: string; gameCreated: boolean; sourceCreated: boolean }> {
    const existingSource = await this.findGameSource(gatewayId, gameData.externalId);
    if (existingSource) {
      return this.applyExistingGameUpdate(existingSource.game, gameData);
    }

    try {
      const game = await this.db.game.create({
        data: {
          ...this.buildCreateInput(gameData),
          gameSources: {
            create: {
              gatewayId,
              externalId: gameData.externalId,
              sourceUrl: gameData.sourceUrl,
            },
          },
        },
        select: { id: true },
      });

      this.logger.debug(`Created game id=${game.id} externalId=${gameData.externalId}`);
      return {
        gameId: game.id,
        gameCreated: true,
        sourceCreated: true,
      };
    } catch (error) {
      // A concurrent duplicate import can win the race between our findUnique
      // and this create, tripping the GameSource(gatewayId, externalId) unique
      // constraint (the only unique on this write — Game itself has none).
      // Recover like TaxonomyUpsertService: re-fetch the winner and fall
      // through to the update path, so the losing job reports success for a
      // game that IS now in the system instead of failing terminally and
      // notifying the user ImportFailed (import jobs are single-attempt).
      if (isPrismaUniqueConstraintError(error)) {
        const raced = await this.findGameSource(gatewayId, gameData.externalId);
        if (raced) {
          this.logger.debug(
            `Concurrent import race for externalId=${gameData.externalId}; recovered game id=${raced.game.id}`,
          );
          return this.applyExistingGameUpdate(raced.game, gameData);
        }
      }

      throw error;
    }
  }

  private findGameSource(gatewayId: string, externalId: string) {
    return this.db.gameSource.findUnique({
      where: { gatewayId_externalId: { gatewayId, externalId } },
      select: { gameId: true, game: { select: { id: true, frozenAt: true } } },
    });
  }

  /** Applies the re-import update path to an already-persisted game (skipping frozen rows). */
  private async applyExistingGameUpdate(
    game: { id: string; frozenAt: Date | null },
    gameData: GameData,
  ): Promise<{ gameId: string; gameCreated: boolean; sourceCreated: boolean }> {
    if (game.frozenAt) {
      this.logger.debug(`Skipped update for frozen game id=${game.id}`);
    } else {
      await this.db.game.update({
        where: { id: game.id },
        data: this.buildUpdateInput(gameData),
      });
    }

    return {
      gameId: game.id,
      gameCreated: false,
      sourceCreated: false,
    };
  }

  /**
   * Upserts all relational data for a game.
   *
   * PlatformGame records are created first (from gameData.platforms) so that
   * downstream upsertReleases can associate GameRelease records with the
   * correct PlatformGame parent. Taxonomy, persons, and DLC are platform-
   * independent and run in parallel with PlatformGame creation.
   */
  private async upsertRelations(gameId: string, gameData: GameData, gatewayId: string): Promise<PlatformGameRef[]> {
    // PlatformGame must resolve before releases can be associated.
    // Taxonomy, persons, and DLC are independent and can run in parallel.
    const [platformGameMap] = await Promise.all([
      this.platform.upsertPlatformGames(gameId, gameData.platforms ?? [], gameData, gatewayId),
      this.upsertMechanics(gameId, gameData.mechanics ?? [], gatewayId),
      this.upsertCategories(gameId, gameData.categories ?? [], gatewayId),
      this.upsertFamilies(gameId, gameData.families ?? [], gatewayId),
      this.upsertDesigners(gameId, gameData.designers ?? [], gatewayId),
      this.upsertArtists(gameId, gameData.artists ?? [], gatewayId),
      this.upsertPublishers(gameId, gameData.publishers ?? [], gatewayId),
      this.upsertDlc(gameId, gameData.dlc ?? [], gatewayId),
    ]);

    // Releases depend on PlatformGame resolution — run after the parallel batch.
    await this.platform.upsertReleases(platformGameMap, gameData.releases ?? [], gatewayId);

    return Array.from(platformGameMap, ([platformId, platformGameId]) => ({ platformId, platformGameId }));
  }

  /**
   * Resolves every item to its canonical id (concurrently), then bulk-inserts
   * the game↔id join rows in a single createMany. The six taxonomy/person
   * relations below share this exact shape and differ only in the resolver and
   * the join delegate/composite key, so it lives here once; each wrapper
   * supplies the resolver and a createMany over the resolved ids.
   *
   * skipDuplicates makes the insert idempotent, matching the old per-item
   * upsert's no-op `update: {}` (the join rows carry no columns beyond the
   * composite key, so an existing link never needs updating). This collapses
   * the former per-item sequential resolve+upsert — ~N round trips per relation
   * — into concurrent resolution plus one insert, so a large bulk import no
   * longer serializes tens of thousands of join writes.
   */
  private async linkResolved<T>(
    items: readonly T[],
    resolveId: (item: T) => Promise<string>,
    createLinks: (ids: string[]) => Promise<unknown>,
  ): Promise<void> {
    if (items.length === 0) {
      return;
    }

    const resolved = await Promise.all(items.map(resolveId));
    // Two source aliases can resolve to the same canonical id; dedupe so the
    // batch carries no in-statement duplicates.
    const ids = [...new Set(resolved)];
    await createLinks(ids);
  }

  private upsertMechanics(gameId: string, mechanics: GameData['mechanics'], gatewayId: string) {
    return this.linkResolved(
      mechanics,
      (mechanic) => this.taxonomy.upsertMechanic(mechanic, gatewayId),
      (mechanicIds) =>
        this.db.gameMechanic.createMany({
          data: mechanicIds.map((mechanicId) => ({ gameId, mechanicId })),
          skipDuplicates: true,
        }),
    );
  }

  private upsertCategories(gameId: string, categories: GameData['categories'], gatewayId: string) {
    return this.linkResolved(
      categories,
      (category) => this.taxonomy.upsertCategory(category, gatewayId),
      (categoryIds) =>
        this.db.gameCategory.createMany({
          data: categoryIds.map((categoryId) => ({ gameId, categoryId })),
          skipDuplicates: true,
        }),
    );
  }

  private upsertFamilies(gameId: string, families: GameData['families'], gatewayId: string) {
    return this.linkResolved(
      families,
      (family) => this.taxonomy.upsertFamily(family, gatewayId),
      (familyIds) =>
        this.db.gameFamily.createMany({
          data: familyIds.map((familyId) => ({ gameId, familyId })),
          skipDuplicates: true,
        }),
    );
  }

  private upsertDesigners(gameId: string, designers: GameData['designers'], gatewayId: string) {
    return this.linkResolved(
      designers,
      (designer) => this.persons.upsertDesigner(designer, gatewayId),
      (designerIds) =>
        this.db.gameDesigner.createMany({
          data: designerIds.map((designerId) => ({ gameId, designerId })),
          skipDuplicates: true,
        }),
    );
  }

  private upsertArtists(gameId: string, artists: GameData['artists'], gatewayId: string) {
    return this.linkResolved(
      artists,
      (artist) => this.persons.upsertArtist(artist, gatewayId),
      (artistIds) =>
        this.db.gameArtist.createMany({
          data: artistIds.map((artistId) => ({ gameId, artistId })),
          skipDuplicates: true,
        }),
    );
  }

  private upsertPublishers(gameId: string, publishers: GameData['publishers'], gatewayId: string) {
    return this.linkResolved(
      publishers,
      (publisher) => this.persons.upsertPublisher(publisher, gatewayId),
      (publisherIds) =>
        this.db.gamePublisher.createMany({
          data: publisherIds.map((publisherId) => ({ gameId, publisherId })),
          skipDuplicates: true,
        }),
    );
  }

  private async upsertDlc(gameId: string, dlcList: DlcData[], gatewayId: string): Promise<void> {
    for (const dlc of dlcList) {
      const existing = await this.db.gameDlcGatewayLink.findUnique({
        where: { gatewayId_externalId: { gatewayId, externalId: dlc.externalId } },
        select: { dlcId: true },
      });

      let dlcId: string;

      if (existing) {
        dlcId = existing.dlcId;
        await this.db.gameDlc.update({
          where: { id: dlcId },
          data: { name: dlc.name, description: dlc.description, thumbnail: dlc.thumbnailUrl },
        });
      } else {
        const created = await this.db.gameDlc.create({
          data: {
            gameId,
            name: dlc.name,
            description: dlc.description,
            thumbnail: dlc.thumbnailUrl,
            gatewayLinks: {
              create: { gatewayId, externalId: dlc.externalId },
            },
          },
          select: { id: true },
        });
        dlcId = created.id;
      }

      // Upsert DLC releases — same platform resolution as game releases
      for (const release of dlc.releases ?? []) {
        const platformId = await this.platform.upsertPlatform(release.platform!, gatewayId);
        const region = toReleaseRegion(release.localizations);

        await this.db.gameDlcRelease.upsert({
          where: { dlcId_platformId_region: { dlcId, platformId, region } },
          create: { dlcId, platformId, region, releaseDate: toReleaseDate(release.releaseDate) },
          update: { releaseDate: toReleaseDate(release.releaseDate) },
        });
      }
    }
  }

  /**
   * The 15 gateway-sourced scalar fields shared by the create and update
   * paths. Kept as one source of truth so a new mapped field can't drift
   * between insert and re-import. Returned as the inferred literal type
   * (plain scalars) so it stays assignable to both GameCreateInput and
   * GameUpdateInput — the only difference between the two paths is
   * `visibility`, which is seeded on create but never reset on re-import.
   */
  private buildScalarInput(game: GameData) {
    return {
      title: game.title,
      contentType: toDbContentType(game.contentType),
      description: game.description,
      thumbnail: game.thumbnailUrl,
      image: game.imageUrl,
      publishYear: game.yearPublished,
      minPlayers: game.minPlayers,
      maxPlayers: game.maxPlayers,
      minPlayTime: game.minPlaytime,
      maxPlayTime: game.maxPlaytime,
      minAge: game.minAge,
      complexity: game.complexityWeight ? game.complexityWeight / 1000 : undefined,
      averageRating: game.averageRating,
      bayesRating: game.bayesRating,
      ratingsCount: game.ratingsCount,
    };
  }

  private buildCreateInput(game: GameData): Prisma.GameCreateInput {
    return {
      ...this.buildScalarInput(game),
      visibility: Visibility.Public,
    };
  }

  private buildUpdateInput(game: GameData): Prisma.GameUpdateInput {
    return this.buildScalarInput(game);
  }
}

const PROTO_TO_DB_CONTENT_TYPE: Record<string, ContentType> = {
  [ProtoContentType.CONTENT_TYPE_BASE_GAME]: ContentType.BaseGame,
  [ProtoContentType.CONTENT_TYPE_EXPANSION]: ContentType.Expansion,
  [ProtoContentType.CONTENT_TYPE_STANDALONE_EXPANSION]: ContentType.StandaloneExpansion,
  [ProtoContentType.CONTENT_TYPE_DLC]: ContentType.DLC,
  [ProtoContentType.CONTENT_TYPE_ACCESSORY]: ContentType.Accessory,
  [ProtoContentType.CONTENT_TYPE_BUNDLE]: ContentType.Bundle,
  [ProtoContentType.CONTENT_TYPE_REMAKE]: ContentType.Remake,
  [ProtoContentType.CONTENT_TYPE_REMASTER]: ContentType.Remaster,
  [ProtoContentType.CONTENT_TYPE_EXPANDED_EDITION]: ContentType.ExpandedEdition,
  [ProtoContentType.CONTENT_TYPE_PORT]: ContentType.Port,
  [ProtoContentType.CONTENT_TYPE_MOD]: ContentType.Mod,
  [ProtoContentType.UNRECOGNIZED]: ContentType.Unknown,
  [ProtoContentType.CONTENT_TYPE_UNSPECIFIED]: ContentType.Unknown,
};

function toDbContentType(protoType: string | undefined): ContentType {
  return (protoType && PROTO_TO_DB_CONTENT_TYPE[protoType]) || ContentType.Unknown;
}

/**
 * Derives the GameExpansion.expansionType from the expansion game's ContentType.
 * ContentType describes what the game IS; ExpansionType describes the relationship.
 */
function toExpansionType(contentType: ContentType): ExpansionType {
  switch (contentType) {
    case ContentType.StandaloneExpansion: {
      return ExpansionType.StandaloneExpansion;
    }

    case ContentType.DLC: {
      return ExpansionType.DLC;
    }

    case ContentType.Accessory: {
      return ExpansionType.Accessory;
    }

    case ContentType.ExpandedEdition: {
      return ExpansionType.ExpandedEdition;
    }

    case ContentType.Port: {
      return ExpansionType.Port;
    }

    case ContentType.Mod: {
      return ExpansionType.Mod;
    }

    default: {
      return ExpansionType.Expansion;
    }
  }
}
