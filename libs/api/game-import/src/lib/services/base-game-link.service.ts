import { ContentType, DatabaseService, ExpansionType, isPrismaUniqueConstraintError } from '@bge/database';
import { Injectable, Logger } from '@nestjs/common';

export interface LinkBaseGamesInput {
  /** The game just imported. */
  gameId: string;
  gatewayId: string;
  /** The game's external id on `gatewayId`. */
  externalId: string;
  /** The game's content type, as stored. */
  contentType: ContentType;
  /** Every base game its DataGateway names for it, primary first. */
  baseExternalIds: string[];
  /**
   * The requested game of the import batch, for an expansion chosen with it.
   * Linked only when the DataGateway names no base game (#971).
   */
  fallbackBaseExternalId?: string;
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
}

/**
 * The content types that are played with a base game, so an import of one
 * whose base game is missing adds it. Every other content type that names a
 * base game (an edition, a remake, a port) is linked to it but never adds it
 * (#971, #658).
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
    // Independent: one reads the base games' DataGateway links, the other the add-ons'.
    const [baseGameIds] = await Promise.all([this.linkToBaseGames(input, named.externalIds), this.linkAddOns(input)]);

    const needsOne = named.fromDataGateway && baseGameIds.length === 0 && NEEDS_BASE_GAME.has(input.contentType);
    return needsOne ? { baseGameIds, baseGameToAdd: named.externalIds[0] } : { baseGameIds };
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

    await Promise.all(baseGameIds.map((baseGameId) => this.linkPair(baseGameId, input.gameId, input.contentType)));

    return baseGameIds;
  }

  /** Links the add-ons in the game catalog whose DataGateway links name this game as their base game. */
  private async linkAddOns(input: LinkBaseGamesInput): Promise<void> {
    const addOns = await this.db.gameSource.findMany({
      where: { gatewayId: input.gatewayId, baseExternalIds: { has: input.externalId }, gameId: { not: input.gameId } },
      select: { gameId: true, game: { select: { contentType: true } } },
    });

    await Promise.all(addOns.map((addOn) => this.linkPair(input.gameId, addOn.gameId, addOn.game.contentType)));
  }

  /**
   * Writes one base game link, its type taken from the add-on's content type.
   * Another import may write the same link first (see `link`), and losing
   * that race leaves the link made.
   */
  private async linkPair(baseGameId: string, expansionGameId: string, contentType: ContentType): Promise<void> {
    const kind = {
      expansionType: toExpansionType(contentType),
      isStandalone: contentType === ContentType.StandaloneExpansion,
    };

    try {
      await this.db.gameExpansion.upsert({
        where: { baseGameId_expansionGameId: { baseGameId, expansionGameId } },
        create: { baseGameId, expansionGameId, ...kind },
        update: kind,
      });
    } catch (error) {
      if (!isPrismaUniqueConstraintError(error)) {
        throw error;
      }

      this.logger.debug(`Base game link ${baseGameId} ← ${expansionGameId} was made by another import`);
    }
  }
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
