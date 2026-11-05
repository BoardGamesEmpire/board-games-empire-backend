import type { Prisma } from '@bge/database';

/**
 * The relations `GET /games/:id` reads with the game (#1036). Each names its
 * columns one by one, so a new column stays off the wire until someone adds
 * it here (#460). Every field below is display data a detail page will show:
 * a credit's role, whether a category is the game's primary one, a family's
 * kind, and a mechanic's description and complexity. The client shows none
 * of them yet.
 *
 * None of these is filtered by a ceiling: they are the game's own facts, read
 * once the game read has passed. A relation that needs its own permission is
 * a read of its own, as platform games (#791) and expansion links (#1069) are.
 */
export const GAME_DETAIL_INCLUDE = {
  artists: {
    select: {
      id: true,
      role: true,
      details: true,
      artist: { select: { id: true, name: true } },
    },
  },

  categories: {
    select: {
      id: true,
      isPrimary: true,
      category: { select: { id: true, name: true } },
    },
  },

  designers: {
    select: {
      id: true,
      role: true,
      designer: { select: { id: true, name: true } },
    },
  },

  families: {
    select: {
      id: true,
      family: { select: { id: true, name: true, familyType: true } },
    },
  },

  mechanics: {
    select: {
      id: true,
      mechanic: { select: { id: true, name: true, description: true, complexity: true } },
    },
  },

  publishers: {
    select: {
      id: true,
      role: true,
      publisher: { select: { id: true, name: true } },
    },
  },

  tags: {
    select: {
      id: true,
      tag: { select: { id: true, name: true } },
    },
  },
} as const satisfies Prisma.GameInclude;

/** The game as {@link GAME_DETAIL_INCLUDE} reads it. */
export type GameDetailRow = Prisma.GameGetPayload<{ include: typeof GAME_DETAIL_INCLUDE }>;

/**
 * One row of a relation {@link GAME_DETAIL_INCLUDE} reads. A class can't
 * implement an indexed type directly, so the DTOs implement this.
 */
export type GameDetailRelationRow<TRelation extends keyof typeof GAME_DETAIL_INCLUDE> =
  GameDetailRow[TRelation][number];
