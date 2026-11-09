import { convertToMarkdown } from '@bge/content-format';
import {
  ContentFormat,
  ContentType,
  DatabaseService,
  isPrismaUniqueConstraintError,
  Prisma,
  Reach,
} from '@bge/database';
import { toStoredContentType } from '@bge/gateway-registry';
import { ServiceAccountService } from '@bge/services';
import { VocabularyLinkService } from '@bge/vocabulary';
import { DlcData, type GameData } from '@boardgamesempire/proto-gateway';
import { Injectable, Logger } from '@nestjs/common';
import type { ImportJobResult, PlatformGameRef } from '../interfaces/import-job.interface';
import { BaseGameLinkService } from './base-game-link.service';
import { toReleaseDate, toReleaseRegion } from './helpers';
import { PersonUpsertService } from './person.service';
import { PlatformUpsertService } from './platform.service';

@Injectable()
export class GameUpsertService {
  private readonly logger = new Logger(GameUpsertService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly vocabulary: VocabularyLinkService,
    private readonly persons: PersonUpsertService,
    private readonly platform: PlatformUpsertService,
    private readonly serviceAccount: ServiceAccountService,
    private readonly baseGameLinks: BaseGameLinkService,
  ) {}

  /**
   * Imports a game from `gatewayId`, whose free text arrives in
   * `contentFormat`, null when the DataGateway declared none.
   *
   * The game's DataGateway link stores the base game ids its DataGateway sent,
   * and the game is then linked to its base games and its add-ons in the game
   * catalog. `fallbackBaseExternalId` is the requested game of the import
   * batch, for an expansion chosen with it: linked as its base game when the
   * DataGateway names none (#971).
   */
  async upsert(
    fetched: GameData,
    gatewayId: string,
    contentFormat: ContentFormat | null,
    fallbackBaseExternalId?: string,
  ): Promise<ImportJobResult> {
    const gameData = inMarkdown(fetched, contentFormat);
    const { gameId, gameCreated, sourceCreated } = await this.upsertGameRecord(gameData, gatewayId);

    const platformGames = await this.upsertRelations(gameId, gameData, gatewayId);

    // After the DataGateway link holds the base game ids, which is what lets
    // an add-on and its base game find each other in either order (#971).
    const { baseGameIds, baseGameToAdd, isExpansion } = await this.baseGameLinks.link({
      gameId,
      gatewayId,
      externalId: gameData.externalId,
      contentType: toDbContentType(gameData.contentType),
      baseExternalIds: gameData.baseGameExternalIds ?? [],
      fallbackBaseExternalId,
    });

    return { gameId, gameCreated, sourceCreated, platformGames, baseGameIds, baseGameToAdd, isExpansion };
  }

  private async upsertGameRecord(
    gameData: GameData,
    gatewayId: string,
  ): Promise<{ gameId: string; gameCreated: boolean; sourceCreated: boolean }> {
    const existingSource = await this.findGameSource(gatewayId, gameData.externalId);
    if (existingSource) {
      return this.applyExistingGameUpdate(existingSource, gameData, gatewayId);
    }

    // An imported game is the server's, not the requester's, and that ownership
    // is what keeps it Public (`updateGame` refuses to privatize one). Created
    // if missing, not merely resolved: otherwise the account exists only once
    // the first Owner's provisioning has run, and nothing orders an import after
    // that. Outside the try, so a failure here is never read as the GameSource
    // race.
    const owner = await this.serviceAccount.resolveOrEnsure();

    try {
      const game = await this.db.game.create({
        data: {
          ...this.buildCreateInput(gameData),
          createdBy: { connect: { id: owner.id } },
          gameSources: {
            create: {
              gatewayId,
              externalId: gameData.externalId,
              sourceUrl: gameData.sourceUrl,
              baseExternalIds: gameData.baseGameExternalIds ?? [],
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
      // Recover as the vocabulary links do: re-fetch the winner and fall
      // through to the update path, so the losing job reports success for a
      // game that IS now in the system instead of failing terminally and
      // notifying the user ImportFailed (import jobs are single-attempt).
      if (isPrismaUniqueConstraintError(error)) {
        const raced = await this.findGameSource(gatewayId, gameData.externalId);
        if (raced) {
          this.logger.debug(
            `Concurrent import race for externalId=${gameData.externalId}; recovered game id=${raced.game.id}`,
          );
          return this.applyExistingGameUpdate(raced, gameData, gatewayId);
        }
      }

      throw error;
    }
  }

  private findGameSource(gatewayId: string, externalId: string) {
    return this.db.gameSource.findUnique({
      where: { gatewayId_externalId: { gatewayId, externalId } },
      select: { baseExternalIds: true, game: { select: { id: true, frozenAt: true } } },
    });
  }

  /**
   * Applies the re-import update path to an already-persisted game (skipping
   * frozen rows). Its DataGateway link takes the base game ids either way: they
   * describe the DataGateway's data, not the game's, and the links rest on
   * them (#971). They rarely change, so an unchanged list is not written.
   */
  private async applyExistingGameUpdate(
    source: { baseExternalIds: string[]; game: { id: string; frozenAt: Date | null } },
    gameData: GameData,
    gatewayId: string,
  ): Promise<{ gameId: string; gameCreated: boolean; sourceCreated: boolean }> {
    const { game } = source;
    const baseExternalIds = gameData.baseGameExternalIds ?? [];
    if (!sameIds(source.baseExternalIds, baseExternalIds)) {
      await this.db.gameSource.update({
        where: { gatewayId_externalId: { gatewayId, externalId: gameData.externalId } },
        data: { baseExternalIds },
      });
    }

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
   *
   * An item that resolves to null is left out: its vocabulary link is Pending
   * or Ignored, and a re-import after the link is settled adds it (#718).
   */
  private async linkResolved<T>(
    items: readonly T[],
    resolveId: (item: T) => Promise<string | null>,
    createLinks: (ids: string[]) => Promise<unknown>,
  ): Promise<void> {
    if (items.length === 0) {
      return;
    }

    const resolved = await Promise.all(items.map(resolveId));
    // Two DataGateway entries can resolve to the same record; dedupe so the
    // batch carries no in-statement duplicates.
    const ids = [...new Set(resolved.filter((id): id is string => id !== null))];
    if (ids.length === 0) {
      return;
    }

    await createLinks(ids);
  }

  private upsertMechanics(gameId: string, mechanics: GameData['mechanics'], gatewayId: string) {
    return this.linkResolved(
      mechanics,
      (mechanic) => this.vocabulary.resolveForImport('mechanic', gatewayId, mechanic),
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
      (category) => this.vocabulary.resolveForImport('category', gatewayId, category),
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
      (family) => this.vocabulary.resolveForImport('family', gatewayId, family),
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
        const platformId = await this.platform.resolvePlatform(release.platform!, gatewayId);
        if (!platformId) {
          // Its platform's link waits for review or was ignored (#718).
          this.logger.debug(`Skipping a release of DLC ${dlc.externalId}: its platform's link isn't Resolved`);
          continue;
        }

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
   * `reach`, which is seeded on create but never reset on re-import.
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
      reach: Reach.Public,
    };
  }

  private buildUpdateInput(game: GameData): Prisma.GameUpdateInput {
    return this.buildScalarInput(game);
  }
}

/**
 * The game as it's stored: its description and its DLC's are Markdown,
 * converted from the content format its DataGateway declared (#714). Its
 * summary isn't stored.
 */
function inMarkdown(gameData: GameData, contentFormat: ContentFormat | null): GameData {
  return {
    ...gameData,
    description: convertToMarkdown(gameData.description, contentFormat),
    dlc: gameData.dlc?.map((dlc) => ({ ...dlc, description: convertToMarkdown(dlc.description, contentFormat) })),
  };
}

/** A content type with no stored equivalent, UNSPECIFIED included, is stored as unknown. */
function toDbContentType(protoType: string | undefined): ContentType {
  return toStoredContentType(protoType) ?? ContentType.Unknown;
}

/** True when two id lists hold the same ids in the same order: the order names the primary base game. */
function sameIds(stored: readonly string[] | undefined, sent: readonly string[]): boolean {
  return stored !== undefined && stored.length === sent.length && stored.every((id, index) => id === sent[index]);
}
