import type { ExpansionLink, Prisma } from '@bge/database';

/**
 * The players and play time a game carries and its platform game may
 * override, selected the same way on both (#1070).
 */
const PLAYERS_AND_PLAY_TIME = {
  minPlayers: true,
  maxPlayers: true,
  minPlayTime: true,
  maxPlayTime: true,
} as const satisfies Prisma.GameSelect & Prisma.PlatformGameSelect;

/**
 * A copy the user still owns: neither removed nor taken back (#1231). An
 * entry's `quantity` counts these, and the entry is removed with its last.
 */
export const OWNED_COPY: Prisma.CollectionCopyWhereInput = { removedAt: null, retractedAt: null };

/**
 * A copy as its owner reads it on the copy routes (#1231): every field that
 * describes it, its acquisition and its removal included, and its release's
 * name and year. When the user last edited it, and the upstream account that
 * synced it, are never selected, so they never ship.
 */
export const OWNER_COPY_SELECT = {
  id: true,
  createdAt: true,
  condition: true,
  acquiredOn: true,
  acquiredOnPrecision: true,
  acquiredFrom: true,
  pricePaidAmount: true,
  pricePaidCurrency: true,
  currentValueAmount: true,
  currentValueCurrency: true,
  note: true,
  removedAt: true,
  removedOn: true,
  removedOnPrecision: true,
  removeReason: true,
  release: { select: { id: true, editionName: true, releaseYear: true } },
} as const satisfies Prisma.CollectionCopySelect;

export type OwnerCopyRow = Prisma.CollectionCopyGetPayload<{ select: typeof OWNER_COPY_SELECT }>;

/**
 * What a collection row embeds, so a client can render, filter, sort and nest
 * a collection without further fetches (#1070): the platform game with its
 * overrides of players and play time and of content type (#1391), its
 * platform's type, and the game's content type, year, players and play time.
 * Each field is named, so no column ships by default (#460). The count of
 * owned copies becomes the row's `quantity` (#1231).
 */
export const COLLECTION_INCLUDE = {
  _count: { select: { copies: { where: OWNED_COPY } } },
  platformGame: {
    select: {
      id: true,
      image: true,
      thumbnail: true,
      contentType: true,
      ...PLAYERS_AND_PLAY_TIME,
      platform: { select: { id: true, name: true, slug: true, platformType: true } },
      game: {
        select: {
          id: true,
          title: true,
          subtitle: true,
          image: true,
          thumbnail: true,
          contentType: true,
          publishYear: true,
          ...PLAYERS_AND_PLAY_TIME,
        },
      },
    },
  },
} satisfies Prisma.GameCollectionInclude;

export type GameCollectionWithRelations = Prisma.GameCollectionGetPayload<{ include: typeof COLLECTION_INCLUDE }>;

/**
 * The entries changed since `since`, for the `updatedSince` catch-up drain
 * (#1070): the entry itself, or a value it embeds. Beside the entry's own
 * arm come the platform game, its platform, the game, the game's links as an
 * expansion, those links' base games, and those base games' platform games.
 * A relation added to `COLLECTION_INCLUDE` needs an arm here, or the drain
 * misses its changes.
 *
 * - The count of owned copies needs no arm: every write of a copy runs
 *   through `CollectionWriteService`, whose `reconcileOwnership` sets the
 *   entry's `lastUpdated` and so bumps its `updatedAt`, and the entry's own
 *   arm resends the row (#1231).
 * - Each arm tests `updatedAt` alone, under no ceiling. A base game whose
 *   own `reach` or `deletedAt` changes takes a new `updatedAt`, so the row is
 *   resent whether the viewer gained or lost it.
 * - A row lists a base game only when the base game has a platform game on
 *   the row's platform (#1391), so a base game's new platform game resends
 *   the row. The arm can't name the row's platform, so a platform game on
 *   any platform resends it.
 * - A link deleted outright leaves nothing to test, so a client keeps the
 *   stale base game id until it reloads in full. Today a link goes with one
 *   of its games, and games are hard-deleted (#476). It also goes when a
 *   re-import moves its add-on off the add-on content types, but that import
 *   writes the add-on game's new content type, so the game's own arm resends
 *   the row (#1391). A path that unlinks games on their own, leaving both
 *   untouched, would meet the gap. A base game's platform game deleted
 *   outright is the same: nothing is left to test (#1391).
 * - Whether the viewer could open a base game also turns on rows no arm
 *   reads: a friendship, a block, a share, a household membership. A change
 *   there resends nothing, so a client sees the base game appear or go only
 *   on a full reload.
 */
export function changedSince(since: Date): Prisma.GameCollectionWhereInput {
  const changed = { updatedAt: { gte: since } };

  return {
    OR: [
      changed,
      {
        platformGame: {
          is: {
            OR: [
              changed,
              { platform: { is: changed } },
              {
                game: {
                  is: {
                    OR: [
                      changed,
                      {
                        expansionEntries: {
                          some: {
                            OR: [
                              changed,
                              { baseGame: { is: changed } },
                              { baseGame: { is: { platformGames: { some: changed } } } },
                            ],
                          },
                        },
                      },
                    ],
                  },
                },
              },
            ],
          },
        },
      },
    ],
  };
}

type IncludedPlatformGame = GameCollectionWithRelations['platformGame'];

/**
 * A collection row as the routes send it: the include's row, with its game's
 * `baseGames`, read after it by a link read of its own (#1070), and its count
 * of owned copies as `quantity` (#1231).
 */
export type GameCollectionRow = Omit<GameCollectionWithRelations, '_count' | 'platformGame'> & {
  /**
   * Whether the entry's game is on the acting user's wishlist (#1241). Set on
   * the rows `GET /users/:userId/game-collections` serves only; `null` for an
   * actor with no wishlist they can read.
   */
  onWishlist?: boolean | null;

  platformGame: Omit<IncludedPlatformGame, 'game'> & {
    game: IncludedPlatformGame['game'] & { baseGames: ExpansionLink[] };
  };

  /** The number of copies the owner still has: neither removed nor taken back (#1231). */
  quantity: number;
};
