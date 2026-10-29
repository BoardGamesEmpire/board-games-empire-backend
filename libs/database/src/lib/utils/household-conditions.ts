import type { Prisma } from '../client';

/**
 * The live households `userId` belongs to: a membership in a household not
 * soft-deleted. A deleted household keeps its member rows until it is purged,
 * so a membership alone would still match it. The catalog renders it against
 * `{{ user.id }}`, and the share condition and the event browse scope against
 * a user's id, so all three agree on whose household it is (#962).
 *
 * A new clause on every call, as `acceptedFriendOf` builds one.
 */
export function liveHouseholdOf(userId: string): Prisma.HouseholdWhereInput {
  return { deletedAt: null, members: { some: { userId } } };
}
