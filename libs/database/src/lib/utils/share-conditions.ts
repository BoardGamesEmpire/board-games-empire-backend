import type { Prisma } from '../client';
import { blockWith } from './friendship-conditions';
import { liveHouseholdOf } from './household-conditions';

/**
 * The games shared with `userId` (#810): a share names one user, or one
 * household the user belongs to, and takes effect once its `approvedAt` is
 * set. A share waiting for approval grants nothing, so both branches test it.
 * The read rule and the game list use the same condition, so they agree on
 * what is shared with a user.
 *
 * - The user branch is vetoed by a block between the owner and `userId`,
 *   whichever placed it, since a block refuses a user share (#810). The veto
 *   sits on this branch only: a household share names a household, not one
 *   user, and carries no block check.
 * - The household branch reads members of every role, guests included, as
 *   `read:game_collection:household` does.
 *
 * A new clause on every call, as `acceptedFriendOf` builds one.
 */
export function gameSharedWith(userId: string): Prisma.GameWhereInput {
  return {
    OR: [
      {
        shares: { some: { userId, approvedAt: { not: null } } },
        createdBy: { is: { NOT: blockWith(userId) } },
      },
      {
        shares: {
          some: {
            approvedAt: { not: null },
            household: { is: liveHouseholdOf(userId) },
          },
        },
      },
    ],
  };
}
