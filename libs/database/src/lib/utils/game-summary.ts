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

/**
 * The game summary `skip` games past `after` in id order over `where`, or
 * `skip` games in without one: the read `sampleByOffsets` walks for
 * `GET /games/random` and the game pool sample (#960, #961). Prisma's cursor
 * is the row itself, so `skip` counts on from it.
 */
export function gameSummaryReader(tx: Prisma.TransactionClient, where: Prisma.GameWhereInput) {
  return (skip: number, after: GameSummary | undefined) =>
    tx.game.findFirst({
      where,
      orderBy: { id: 'asc' },
      cursor: after && { id: after.id },
      skip,
      select: GAME_SUMMARY_SELECT,
    });
}
