import type { Prisma } from '@bge/database';
import type { LinkedGame } from './linked-game.select';
import { LINKED_GAME_SELECT } from './linked-game.select';

/** The games a game works with, contains and belongs to, each in title order, then id (#1392, #1394). */
export interface GameLinks {
  readonly bundles: LinkedGame[];
  readonly contents: LinkedGame[];
  readonly worksWith: LinkedGame[];
}

/** What a game's DataGateway links say about its works-with links, contents and bundles (#1392, #1394). */
const DATAGATEWAY_LINK_IDS_SELECT = {
  gatewayId: true,
  externalId: true,
  worksWithExternalIds: true,
  contentExternalIds: true,
  bundleExternalIds: true,
} as const satisfies Prisma.GameSourceSelect;

type DataGatewayLinkIds = Prisma.GameSourceGetPayload<{ select: typeof DATAGATEWAY_LINK_IDS_SELECT }>;

/**
 * How one relationship is matched from a DataGateway link: the ids this game's
 * link names, and the test that the other game's link names this one. A bundle
 * names its contents and a contained game names its bundles, so contents are
 * named by the other game's bundle ids, and bundles by its content ids (#1394).
 */
interface Relationship {
  readonly named: (link: DataGatewayLinkIds) => string[];
  readonly namedBy: (externalId: string) => Prisma.GameSourceWhereInput;
}

const RELATIONSHIPS = {
  worksWith: {
    named: (link) => link.worksWithExternalIds,
    namedBy: (externalId) => ({ worksWithExternalIds: { has: externalId } }),
  },
  contents: {
    named: (link) => link.contentExternalIds,
    namedBy: (externalId) => ({ bundleExternalIds: { has: externalId } }),
  },
  bundles: {
    named: (link) => link.bundleExternalIds,
    namedBy: (externalId) => ({ contentExternalIds: { has: externalId } }),
  },
} as const satisfies Record<keyof GameLinks, Relationship>;

/**
 * The games a game works with, contains and belongs to, for `GET /games/:id`
 * (#1392, #1394). No table stores these links: each holds when either game's
 * DataGateway link names the other on the same DataGateway, so the order of
 * import doesn't matter and a link follows the DataGateway's latest data.
 *
 * - The game's DataGateway links are read unscoped: a DataGateway link is no
 *   permission resource, and only the games it matches are sent.
 * - The `linkedGameWhere` passed in decides which linked games are named. It
 *   sits in each game read's own top-level `where`, where the CASL extension
 *   sees a deny-all; in a relation filter Prisma would drop one and name
 *   every linked game (#1069).
 * - Every match is scoped to the DataGateway link's own DataGateway, so the
 *   same external id on two DataGateways never links two games.
 * - A game naming itself is left out. A game named from both sides is one
 *   game row, so it is listed once.
 * - A game with no DataGateway link, such as a manual game, reads no game.
 */
export async function readGameLinks(
  db: Pick<Prisma.TransactionClient, 'game' | 'gameSource'>,
  gameId: string,
  linkedGameWhere: Prisma.GameWhereInput,
): Promise<GameLinks> {
  const gatewayLinks = await db.gameSource.findMany({ where: { gameId }, select: DATAGATEWAY_LINK_IDS_SELECT });
  if (gatewayLinks.length === 0) {
    return { worksWith: [], contents: [], bundles: [] };
  }

  const readLinked = ({ named, namedBy }: Relationship): Promise<LinkedGame[]> => {
    const arms = gatewayLinks.flatMap((link): Prisma.GameSourceWhereInput[] => {
      const ids = named(link);
      const namedByLink = { gatewayId: link.gatewayId, ...namedBy(link.externalId) };

      // A link that names nothing can still be named by the other game (#1392).
      return ids.length > 0 ? [{ gatewayId: link.gatewayId, externalId: { in: ids } }, namedByLink] : [namedByLink];
    });

    return db.game.findMany({
      where: { AND: [linkedGameWhere, { id: { not: gameId } }, { gameSources: { some: { OR: arms } } }] },
      select: LINKED_GAME_SELECT,
      orderBy: [{ title: 'asc' }, { id: 'asc' }],
    });
  };

  const [worksWith, contents, bundles] = await Promise.all([
    readLinked(RELATIONSHIPS.worksWith),
    readLinked(RELATIONSHIPS.contents),
    readLinked(RELATIONSHIPS.bundles),
  ]);

  return { worksWith, contents, bundles };
}
