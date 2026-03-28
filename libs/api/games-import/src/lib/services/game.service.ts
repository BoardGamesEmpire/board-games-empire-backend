import { ContentType, DatabaseService, ExpansionType, Prisma, Visibility } from '@bge/database';
import type { GameData } from '@board-games-empire/proto-gateway';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { ImportJobResult } from '../interfaces/import-job.interface';
import { PersonUpsertService } from './person.service';
import { TaxonomyUpsertService } from './taxonomy.service';

@Injectable()
export class GameUpsertService {
  private readonly logger = new Logger(GameUpsertService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly taxonomy: TaxonomyUpsertService,
    private readonly persons: PersonUpsertService,
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

    // Entirely new game
    // Cross-gateway dedup (same real-world game imported from BGG and IGDB) is
    // deferred — external IDs are gateway-specific and title matching is
    // unreliable. A future admin merge tool will handle this duplication cleanup.
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

  private async upsertRelations(gameId: string, gameData: GameData, gatewayId: string): Promise<void> {
    await Promise.all([
      this.upsertMechanics(gameId, gameData.mechanics ?? [], gatewayId),
      this.upsertCategories(gameId, gameData.categories ?? [], gatewayId),
      this.upsertFamilies(gameId, gameData.families ?? [], gatewayId),
      this.upsertDesigners(gameId, gameData.designers ?? [], gatewayId),
      this.upsertArtists(gameId, gameData.artists ?? [], gatewayId),
      this.upsertPublishers(gameId, gameData.publishers ?? [], gatewayId),
    ]);
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
  CONTENT_TYPE_BASE_GAME: ContentType.BaseGame,
  CONTENT_TYPE_EXPANSION: ContentType.Expansion,
  CONTENT_TYPE_STANDALONE_EXPANSION: ContentType.StandaloneExpansion,
  CONTENT_TYPE_DLC: ContentType.DLC,
  CONTENT_TYPE_ACCESSORY: ContentType.Accessory,
  CONTENT_TYPE_BUNDLE: ContentType.Bundle,
  CONTENT_TYPE_REMAKE: ContentType.Remake,
  CONTENT_TYPE_REMASTER: ContentType.Remaster,
};

function toDbContentType(protoType: string | undefined): ContentType {
  return (protoType && PROTO_TO_DB_CONTENT_TYPE[protoType]) || ContentType.BaseGame;
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

    default: {
      return ExpansionType.Expansion;
    }
  }
}
