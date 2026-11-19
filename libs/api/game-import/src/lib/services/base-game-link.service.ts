import { ADD_ON_CONTENT_TYPES, ContentType, DatabaseService, isPrismaUniqueConstraintError } from '@bge/database';
import { Injectable, Logger } from '@nestjs/common';

export interface LinkBaseGamesInput {
  /** Every base game its DataGateway names for it, primary first. */
  baseExternalIds: string[];

  /** The game's content type, as stored. */
  contentType: ContentType;

  /** The game's external id on `gatewayId`. */
  externalId: string;

  /**
   * The requested game of the import batch, for an expansion chosen with it.
   * Linked only when the DataGateway names no base game (#971).
   */
  fallbackBaseExternalId?: string;

  /** The game just imported. */
  gameId: string;

  gatewayId: string;
}

export interface LinkBaseGamesResult {
  /** The base games the game is now linked to, in the order its DataGateway named them. */
  baseGameIds: string[];

  /**
   * The external id of the base game to add to the import batch: the first
   * one named, when the game needs a base game and none of those named is in
   * the game catalog.
   */
  baseGameToAdd?: string;

  /**
   * True when the game is an add-on that has a base game: linked to one, or
   * missing the one it needs. A remake, remaster, port or edition linked to
   * its original is not an expansion (#971).
   */
  isExpansion: boolean;
}

/**
 * The content types that are played with a base game, so an import of one
 * whose base game is missing adds it. A standalone expansion or accessory is
 * linked to a base game that is in the game catalog but never adds one. A
 * remake, remaster, port, expanded edition or bundle names its original on
 * `GameSource.baseExternalIds` alone, for #658, and gets no add-on link
 * (#971, #1391).
 */
const NEEDS_BASE_GAME: ReadonlySet<ContentType> = new Set([ContentType.Expansion, ContentType.DLC, ContentType.Mod]);

/**
 * Links an imported game to its base games, and the add-ons already in the
 * game catalog to it (#971).
 */
@Injectable()
export class BaseGameLinkService {
  private readonly logger = new Logger(BaseGameLinkService.name);

  constructor(private readonly db: DatabaseService) {}

  /**
   * Links the game both ways: to the base games its DataGateway names that
   * are in the game catalog, and from the games in the catalog whose
   * DataGateway links name it as their base game.
   *
   * A race between an add-on and its base game can't miss the link. Each
   * import commits its own DataGateway link, base game ids included, before
   * it looks for the other side, so whichever of the two looks second finds
   * the first. When both look at once, both write the same link, and the one
   * that loses the unique constraint counts it as made.
   */
  async link(input: LinkBaseGamesInput): Promise<LinkBaseGamesResult> {
    const named = this.namedBaseGames(input);
    // Only an add-on gets an add-on link to its base games. A remake,
    // remaster, port, expanded edition or bundle names its original on
    // `GameSource.baseExternalIds` alone, for #658 (#1391).
    const isAddOn = ADD_ON_CONTENT_TYPES.has(input.contentType);
    // Independent: one reads the base games' DataGateway links, the other the add-ons'.
    const [baseGameIds] = await Promise.all([
      isAddOn ? this.linkToBaseGames(input, named.externalIds) : Promise.resolve<string[]>([]),
      this.linkAddOns(input),
    ]);

    const needsOne = named.fromDataGateway && baseGameIds.length === 0 && NEEDS_BASE_GAME.has(input.contentType);
    const baseGameToAdd = needsOne ? named.externalIds[0] : undefined;
    // A game of an add-on content type with a base game is an expansion to
    // the import's events, notifications and game watches; a game of any
    // other content type is not, and gets no add-on link (#971, #658, #1391).
    // An add-on whose base game is being added counts already: the base
    // game's own import makes the link, after this game's events fired.
    const isExpansion = isAddOn && (baseGameIds.length > 0 || baseGameToAdd !== undefined);

    return baseGameToAdd ? { baseGameIds, baseGameToAdd, isExpansion } : { baseGameIds, isExpansion };
  }

  /**
   * The base games to look for: those the DataGateway names, leaving out the
   * game itself, or else the requested game it was chosen with. A DataGateway
   * that names other base games decides; the requested game is not linked
   * then (#971).
   */
  private namedBaseGames(input: LinkBaseGamesInput): { externalIds: string[]; fromDataGateway: boolean } {
    const fromDataGateway = [...new Set(input.baseExternalIds)].filter((id) => id !== input.externalId);
    if (fromDataGateway.length > 0) {
      return { externalIds: fromDataGateway, fromDataGateway: true };
    }

    const fallback = input.fallbackBaseExternalId;
    const externalIds = fallback && fallback !== input.externalId ? [fallback] : [];
    return { externalIds, fromDataGateway: false };
  }

  private async linkToBaseGames(input: LinkBaseGamesInput, externalIds: string[]): Promise<string[]> {
    if (externalIds.length === 0) {
      return [];
    }

    const sources = await this.db.gameSource.findMany({
      where: { gatewayId: input.gatewayId, externalId: { in: externalIds } },
      select: { externalId: true, gameId: true },
    });

    const gameIdOf = new Map(sources.map((source) => [source.externalId, source.gameId]));
    const baseGameIds = [
      ...new Set(
        externalIds
          .map((externalId) => gameIdOf.get(externalId))
          .filter((gameId): gameId is string => gameId !== undefined && gameId !== input.gameId),
      ),
    ];

    await Promise.all(baseGameIds.map((baseGameId) => this.linkPair(baseGameId, input.gameId)));

    return baseGameIds;
  }

  /**
   * Links the add-ons in the game catalog whose DataGateway links name this
   * game as their base game. A game of any other content type that names it
   * is not an add-on and gets no link (#1391). Runs for every game, since a
   * bundle is a base game for the add-ons that name it.
   */
  private async linkAddOns(input: LinkBaseGamesInput): Promise<void> {
    const addOns = await this.db.gameSource.findMany({
      where: {
        gatewayId: input.gatewayId,
        baseExternalIds: { has: input.externalId },
        gameId: { not: input.gameId },
        game: { is: { contentType: { in: [...ADD_ON_CONTENT_TYPES] } } },
      },
      select: { gameId: true },
    });

    await Promise.all(addOns.map((addOn) => this.linkPair(input.gameId, addOn.gameId)));
  }

  /**
   * Writes one add-on link. It has no kind of its own: the add-on's content
   * type is its kind, so the write names the pair alone (#1391). Another
   * import may write the same link first (see `link`), and losing that race
   * leaves the link made.
   */
  private async linkPair(baseGameId: string, expansionGameId: string): Promise<void> {
    try {
      await this.db.gameExpansion.upsert({
        where: { baseGameId_expansionGameId: { baseGameId, expansionGameId } },
        create: { baseGameId, expansionGameId },
        update: {},
      });
    } catch (error) {
      if (!isPrismaUniqueConstraintError(error)) {
        throw error;
      }

      this.logger.debug(`Base game link ${baseGameId} ← ${expansionGameId} was made by another import`);
    }
  }
}
