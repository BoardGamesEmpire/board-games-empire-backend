import type { Prisma } from '../client';

/**
 * The game summary: the household preview's member games, `GET /games/random`
 * and the game pool sample all select this shape, so a game looks the same
 * wherever it is sampled (#960, #961). The thumbnail has no alt text of its
 * own, so the title labels it.
 */
export const GAME_SUMMARY_SELECT = {
  id: true,
  title: true,
  thumbnail: true,
  description: true,
} as const satisfies Prisma.GameSelect;

export type GameSummary = Prisma.GameGetPayload<{ select: typeof GAME_SUMMARY_SELECT }>;
