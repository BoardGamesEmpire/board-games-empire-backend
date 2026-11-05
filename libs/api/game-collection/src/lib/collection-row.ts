import type { ExpansionLink, Prisma } from '@bge/database';

/**
 * What a collection row embeds, so a client can render, filter, sort and nest
 * a collection without further fetches (#1070): the platform game with its
 * overrides of players and play time, its platform's type, and the game's
 * content type, year, players and play time. Each field is named, so no
 * column ships by default (#460).
 */
export const COLLECTION_INCLUDE = {
  platformGame: {
    select: {
      id: true,
      image: true,
      thumbnail: true,
      minPlayers: true,
      maxPlayers: true,
      minPlayTime: true,
      maxPlayTime: true,
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
          minPlayers: true,
          maxPlayers: true,
          minPlayTime: true,
          maxPlayTime: true,
        },
      },
    },
  },
  release: { select: { id: true, editionName: true, releaseYear: true } },
} satisfies Prisma.GameCollectionInclude;

export type GameCollectionWithRelations = Prisma.GameCollectionGetPayload<{ include: typeof COLLECTION_INCLUDE }>;

/**
 * The entries changed since `since`, for the `updatedSince` catch-up drain
 * (#1070): the entry itself, or a value it embeds. Beside the entry's own
 * arm come the platform game, its platform, the game, the game's links as an
 * expansion, those links' base games, and the release. A relation added to
 * `COLLECTION_INCLUDE` needs an arm here, or the drain misses its changes.
 *
 * - Each arm tests `updatedAt` alone, under no ceiling. A base game whose
 *   own `reach` or `deletedAt` changes takes a new `updatedAt`, so the row is
 *   resent whether the viewer gained or lost it.
 * - A link deleted outright leaves nothing to test, so a client keeps the
 *   stale base game id until it reloads in full. Today a link goes only with
 *   one of its games, and games are hard-deleted (#476). A path that unlinks
 *   games on their own would meet the same gap.
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
                    OR: [changed, { expansionEntries: { some: { OR: [changed, { baseGame: { is: changed } }] } } }],
                  },
                },
              },
            ],
          },
        },
      },
      { release: { is: changed } },
    ],
  };
}

type IncludedPlatformGame = GameCollectionWithRelations['platformGame'];

/**
 * A collection row as the routes send it: the include's row, with its game's
 * `baseGames`, read after it by a link read of its own (#1070).
 */
export type GameCollectionRow = Omit<GameCollectionWithRelations, 'platformGame'> & {
  platformGame: Omit<IncludedPlatformGame, 'game'> & {
    game: IncludedPlatformGame['game'] & { baseGames: ExpansionLink[] };
  };
};
