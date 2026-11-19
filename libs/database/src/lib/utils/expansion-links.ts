import type { Prisma } from '../client';
import { ContentType } from '../client';

/**
 * One end of an add-on link, seen from the other: `gameId` is the game at the
 * far end, and `isStandalone` is the add-on's. It follows the add-on's content
 * type: the platform game's own where one platform is in view (a collection or
 * offered-game row), else the game's. So every link on one row, or of one game
 * where no platform is in view, carries the same value (#1391).
 */
export interface ExpansionLink {
  readonly gameId: string;
  readonly isStandalone: boolean;
}

/**
 * A platform game a row shows, as {@link readBaseGameLinksOnPlatform} reads it
 * (#1391): its id and platform, its own content type if it has one, and its
 * game's id and content type.
 */
export interface PlatformGameInView {
  readonly contentType: ContentType | null;
  readonly game: { readonly contentType: ContentType; readonly id: string };
  readonly id: string;
  readonly platformId: string;
}

const BASE_GAME_LINK_SELECT = {
  expansionGameId: true,
  baseGameId: true,
} as const satisfies Prisma.GameExpansionSelect;

/**
 * The base-game links of each of `expansions`, keyed by expansion game id
 * (#1069). An expansion with no visible link is absent from the map, and the
 * caller defaults it to none.
 *
 * - The caller's `baseGameWhere` decides which base games are visible:
 *   `GET /games`'s intrinsic scope under the ceiling (#1070). A row that
 *   shows one platform reads {@link readBaseGameLinksOnPlatform} instead
 *   (#1391).
 * - It sits in this read's own `where`, where the CASL extension sees a
 *   deny-all in it. In an `include` filter Prisma would drop one and name
 *   every base game.
 * - The link's direction, not a game's content type, says which game is the
 *   base: the link is what the importer recorded.
 * - Each link's `isStandalone` follows the add-on's content type, which the
 *   caller passes with its id (#1391). A game given twice is read once.
 * - Each expansion's links come in base game title order, then base game id,
 *   the order `GET /games/:id` gives them, so an expansion's base games read
 *   the same on a list row as on its detail.
 */
export async function readBaseGameLinks(
  db: Pick<Prisma.TransactionClient, 'gameExpansion'>,
  expansions: readonly { contentType: ContentType; id: string }[],
  baseGameWhere: Prisma.GameWhereInput,
): Promise<ReadonlyMap<string, ExpansionLink[]>> {
  const links = new Map<string, ExpansionLink[]>();
  if (expansions.length === 0) {
    return links;
  }

  const isStandaloneOf = new Map(expansions.map(({ id, contentType }) => [id, isStandaloneAddOn(contentType)]));
  const rows = await db.gameExpansion.findMany({
    where: { expansionGameId: { in: [...isStandaloneOf.keys()] }, baseGame: { is: baseGameWhere } },
    select: BASE_GAME_LINK_SELECT,
    orderBy: [{ baseGame: { title: 'asc' } }, { baseGameId: 'asc' }],
  });

  for (const { expansionGameId, baseGameId } of rows) {
    const forExpansion = links.get(expansionGameId) ?? [];
    forExpansion.push({ gameId: baseGameId, isStandalone: isStandaloneOf.get(expansionGameId) === true });
    links.set(expansionGameId, forExpansion);
  }

  return links;
}

/** A base game an add-on links to, and the platforms in view it has a platform game on. */
interface BaseGameOnPlatforms {
  readonly baseGameId: string;
  readonly platformIds: ReadonlySet<string>;
}

/**
 * The base-game links of each of `platformGames`, keyed by platform game id
 * (#1391), for a row that shows one platform: a collection row or an offered
 * game. A platform game lists only the base games that have a platform game
 * on its own platform, so one add-on held on two platforms can list different
 * base games on each row. A platform game with no such link is absent from the
 * map, and the caller defaults it to none.
 *
 * - The caller's `baseGameWhere` decides which base games are visible. It sits
 *   in this read's own `where`, as in {@link readBaseGameLinks}, where the CASL
 *   extension sees a deny-all.
 * - Each base game's platform games are read on the page's platforms only,
 *   and only to test whether one is on a row's platform. That read is a
 *   presence check under no ceiling, and none of it is sent. It still decides
 *   which base games a row lists, so a key with no `read:platform_game` can
 *   infer that a listed base game has a platform game on the row's platform.
 *   That is accepted: it is catalog data, of the kind the row's own platform
 *   game already shows.
 * - Each link's `isStandalone` follows the add-on's content type on that
 *   platform: the platform game's own where it has one, else the game's.
 * - A game given more than once is read once. Each platform game's links come
 *   in base game title order, then base game id, as in
 *   {@link readBaseGameLinks}.
 */
export async function readBaseGameLinksOnPlatform(
  db: Pick<Prisma.TransactionClient, 'gameExpansion'>,
  platformGames: readonly PlatformGameInView[],
  baseGameWhere: Prisma.GameWhereInput,
): Promise<ReadonlyMap<string, ExpansionLink[]>> {
  const links = new Map<string, ExpansionLink[]>();
  if (platformGames.length === 0) {
    return links;
  }

  const gameIds = new Set(platformGames.map(({ game }) => game.id));
  const platformIds = new Set(platformGames.map(({ platformId }) => platformId));
  const rows = await db.gameExpansion.findMany({
    where: { expansionGameId: { in: [...gameIds] }, baseGame: { is: baseGameWhere } },
    select: {
      ...BASE_GAME_LINK_SELECT,
      baseGame: {
        select: { platformGames: { where: { platformId: { in: [...platformIds] } }, select: { platformId: true } } },
      },
    } satisfies Prisma.GameExpansionSelect,
    orderBy: [{ baseGame: { title: 'asc' } }, { baseGameId: 'asc' }],
  });

  const baseGamesOf = new Map<string, BaseGameOnPlatforms[]>();
  for (const { expansionGameId, baseGameId, baseGame } of rows) {
    const forAddOn = baseGamesOf.get(expansionGameId) ?? [];
    forAddOn.push({ baseGameId, platformIds: new Set(baseGame.platformGames.map(({ platformId }) => platformId)) });
    baseGamesOf.set(expansionGameId, forAddOn);
  }

  for (const platformGame of platformGames) {
    const isStandalone = isStandaloneAddOn(
      effectiveContentType(platformGame.contentType, platformGame.game.contentType),
    );
    const onPlatform = (baseGamesOf.get(platformGame.game.id) ?? [])
      .filter((baseGame) => baseGame.platformIds.has(platformGame.platformId))
      .map(({ baseGameId }) => ({ gameId: baseGameId, isStandalone }));

    if (onPlatform.length > 0) {
      links.set(platformGame.id, onPlatform);
    }
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
