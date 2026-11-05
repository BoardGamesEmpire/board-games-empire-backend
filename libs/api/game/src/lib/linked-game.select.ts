import type { Prisma } from '@bge/database';

/**
 * The game at the far end of an expansion link on `GET /games/:id` (#1069):
 * enough for a client to list it and to tell an expansion from a base game.
 * Named one by one so a new column stays off the wire until someone adds it
 * here (#460). The thumbnail has no alt text of its own until #1035 stores
 * one, so the title labels it; add the alt text here when it does.
 */
export const LINKED_GAME_SELECT = {
  id: true,
  title: true,
  thumbnail: true,
  contentType: true,
} as const satisfies Prisma.GameSelect;

/** One game of the read {@link LINKED_GAME_SELECT} names. */
export type LinkedGame = Prisma.GameGetPayload<{ select: typeof LINKED_GAME_SELECT }>;
