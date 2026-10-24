import type { GameShare } from '../client';

/**
 * A game share as its mutation events carry it (#810): every column but
 * `createdAt`, which the audit row's own time covers. The share's created and
 * deleted events in `@bge/game` and its approval event in `@bge/household`
 * all carry this one shape, so one share's audit trail diffs alike across the
 * three.
 */
export type GameShareSnapshot = Pick<
  GameShare,
  'id' | 'gameId' | 'userId' | 'householdId' | 'sharedById' | 'approvedById' | 'approvedAt'
>;

/** The share as a snapshot, so every event of a share carries the same columns. */
export function gameShareSnapshot(share: GameShareSnapshot): GameShareSnapshot {
  return {
    id: share.id,
    gameId: share.gameId,
    userId: share.userId,
    householdId: share.householdId,
    sharedById: share.sharedById,
    approvedById: share.approvedById,
    approvedAt: share.approvedAt,
  };
}
