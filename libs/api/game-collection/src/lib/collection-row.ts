import type { Prisma } from '@bge/database';

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
