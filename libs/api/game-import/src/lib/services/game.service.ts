import { ContentType, DatabaseService, ExpansionType, Prisma, Visibility } from '@bge/database';
import { DlcData, type GameData, ContentType as ProtoContentType } from '@board-games-empire/proto-gateway';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { ImportJobResult } from '../interfaces/import-job.interface';
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

    await this.upsertRelations(gameId, gameData, gatewayId);
    return { gameId, gameCreated, sourceCreated };
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
    await this.upsertRelations(gameId, gameData, gatewayId);

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

    return { gameId, gameCreated, sourceCreated, baseGameId };
  }

  private async upsertGameRecord(
    gameData: GameData,
    gatewayId: string,
  ): Promise<{ gameId: string; gameCreated: boolean; sourceCreated: boolean }> {
    const existingSource = await this.db.gameSource.findUnique({
      where: { gatewayId_externalId: { gatewayId, externalId: gameData.externalId } },
      select: { gameId: true, game: { select: { id: true, frozenAt: true } } },
    });

    if (existingSource) {
      const { game } = existingSource;
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
  }

  /**
   * Upserts all relational data for a game.
   *
   * PlatformGame records are created first (from gameData.platforms) so that
   * downstream upsertReleases can associate GameRelease records with the
   * correct PlatformGame parent. Taxonomy, persons, and DLC are platform-
   * independent and run in parallel with PlatformGame creation.
   */
  private async upsertRelations(gameId: string, gameData: GameData, gatewayId: string): Promise<void> {
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
  }

  private async upsertMechanics(gameId: string, mechanics: GameData['mechanics'], gatewayId: string) {
    for (const mechanic of mechanics) {
      const mechanicId = await this.taxonomy.upsertMechanic(mechanic, gatewayId);
      await this.db.gameMechanic.upsert({
        where: { gameId_mechanicId: { gameId, mechanicId } },
        create: { gameId, mechanicId },
        update: {},
      });
    }
  }

  private async upsertCategories(gameId: string, categories: GameData['categories'], gatewayId: string) {
    for (const category of categories) {
      const categoryId = await this.taxonomy.upsertCategory(category, gatewayId);
      await this.db.gameCategory.upsert({
        where: { gameId_categoryId: { gameId, categoryId } },
        create: { gameId, categoryId },
        update: {},
      });
    }
  }

  private async upsertFamilies(gameId: string, families: GameData['families'], gatewayId: string) {
    for (const family of families) {
      const familyId = await this.taxonomy.upsertFamily(family, gatewayId);
      await this.db.gameFamily.upsert({
        where: { gameId_familyId: { gameId, familyId } },
        create: { gameId, familyId },
        update: {},
      });
    }
  }

  private async upsertDesigners(gameId: string, designers: GameData['designers'], gatewayId: string) {
    for (const designer of designers) {
      const designerId = await this.persons.upsertDesigner(designer, gatewayId);
      await this.db.gameDesigner.upsert({
        where: { gameId_designerId: { gameId, designerId } },
        create: { gameId, designerId },
        update: {},
      });
    }
  }

  private async upsertArtists(gameId: string, artists: GameData['artists'], gatewayId: string) {
    for (const artist of artists) {
      const artistId = await this.persons.upsertArtist(artist, gatewayId);
      await this.db.gameArtist.upsert({
        where: { gameId_artistId: { gameId, artistId } },
        create: { gameId, artistId },
        update: {},
      });
    }
  }

  private async upsertPublishers(gameId: string, publishers: GameData['publishers'], gatewayId: string) {
    for (const publisher of publishers) {
      const publisherId = await this.persons.upsertPublisher(publisher, gatewayId);
      await this.db.gamePublisher.upsert({
        where: { gameId_publisherId: { gameId, publisherId } },
        create: { gameId, publisherId },
        update: {},
      });
    }
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

  private buildCreateInput(game: GameData): Prisma.GameCreateInput {
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
      visibility: Visibility.Public,
    };
  }

  private buildUpdateInput(game: GameData): Prisma.GameUpdateInput {
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
