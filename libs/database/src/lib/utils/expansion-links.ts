import type { Prisma } from '../client';
import { ContentType } from '../client';

/**
 * One end of an expansion link, seen from the other: `gameId` is the game at
 * the far end, and `isStandalone` is this link's own value, since an expansion
 * can be standalone for one base game and not another (#1069).
 */
export interface ExpansionLink {
  readonly gameId: string;
  readonly isStandalone: boolean;
}

const BASE_GAME_LINK_SELECT = {
  expansionGameId: true,
  baseGameId: true,
  isStandalone: true,
} as const satisfies Prisma.GameExpansionSelect;

/**
 * The base-game links of each of `expansionGameIds`, keyed by expansion game
 * id (#1069). An expansion with no visible link is absent from the map, and
 * the caller defaults it to none.
 *
 * - The caller's `baseGameWhere` decides which base games are visible:
 *   `GET /games`'s intrinsic scope under the ceiling, and the live games
 *   under the ceiling on collection rows (#1070).
 * - It sits in this read's own `where`, where the CASL extension sees a
 *   deny-all in it. In an `include` filter Prisma would drop one and name
 *   every base game.
 * - The link's direction, not a game's content type, says which game is the
 *   base: the link is what the importer recorded.
 * - Each expansion's links come in base game title order, then base game id,
 *   the order `GET /games/:id` gives them, so an expansion's base games read
 *   the same on a list row as on its detail.
 */
export async function readBaseGameLinks(
  db: Pick<Prisma.TransactionClient, 'gameExpansion'>,
  expansionGameIds: readonly string[],
  baseGameWhere: Prisma.GameWhereInput,
): Promise<ReadonlyMap<string, ExpansionLink[]>> {
  const links = new Map<string, ExpansionLink[]>();
  if (expansionGameIds.length === 0) {
    return links;
  }

  const rows = await db.gameExpansion.findMany({
    where: { expansionGameId: { in: [...expansionGameIds] }, baseGame: { is: baseGameWhere } },
    select: BASE_GAME_LINK_SELECT,
    orderBy: [{ baseGame: { title: 'asc' } }, { baseGameId: 'asc' }],
  });

  for (const { expansionGameId, baseGameId, isStandalone } of rows) {
    const forExpansion = links.get(expansionGameId) ?? [];
    forExpansion.push({ gameId: baseGameId, isStandalone });
    links.set(expansionGameId, forExpansion);
  }

  return links;
}

/**
 * The content types that add to a base game rather than being a version of
 * it, and so the only ones that get an add-on link (#1391). The importer uses
 * this set to decide whether an imported game is an add-on.
 */
export const ADD_ON_CONTENT_TYPES: ReadonlySet<ContentType> = new Set([
  ContentType.Expansion,
  ContentType.DLC,
  ContentType.Mod,
  ContentType.StandaloneExpansion,
  ContentType.Accessory,
]);

/**
 * The content type a platform game has: its own when it differs from the
 * game's, else the game's (#1391).
 */
export function effectiveContentType(own: ContentType | null, game: ContentType): ContentType {
  return own ?? game;
}

/**
 * True when an add-on of this content type plays without its base game, so it
 * is the only content type whose add-on link can be standalone (#1391).
 */
export function isStandaloneAddOn(contentType: ContentType): boolean {
  return contentType === ContentType.StandaloneExpansion;
}

/**
 * The platforms an add-on link holds on: the ids of `ordered` that are also in
 * `other`, in `ordered`'s order (#1391).
 */
export function linkPlatformIds(ordered: readonly string[], other: Iterable<string>): string[] {
  const shared = new Set(other);

  return ordered.filter((id) => shared.has(id));
}
