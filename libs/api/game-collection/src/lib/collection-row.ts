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
