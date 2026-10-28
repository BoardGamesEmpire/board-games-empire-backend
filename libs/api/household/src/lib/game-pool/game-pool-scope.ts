import type { Prisma } from '@bge/database';

/**
 * The collection entries in the game pool of any of the given households
 * (#960). An entry is in household H's game pool when its owner's membership
 * in H has collection sharing on, and no excluded game for a membership in H
 * holds it back. The caller's own entries are no exception.
 *
 * An excluded game is its owner's: they hold their own entry back. The rule
 * matches an exclusion by any membership in H, because Prisma cannot tie the
 * membership's user to the entry's owner, so the write that records one
 * (#170) keeps it to the owner's own membership.
 *
 * The rule is stated per household because a flat clause, like the
 * permission catalog's `read:game_collection:household`, cannot tie the
 * exclusion to the same household as the collection sharing. Nor is the read
 * ceiling the game pool: it also admits an entry by its reach, which puts it in
 * no household's game pool.
 *
 * Callers pass live household ids, and compose the result under the
 * GameCollection read ceiling, which it narrows and never replaces. With no ids
 * it admits nothing. The per-household game pool read (#367) reuses it with
 * one id.
 */
export function gamePoolEntryScope(householdIds: readonly string[]): Prisma.GameCollectionWhereInput {
  return {
    deletedAt: null,
    OR: householdIds.map((householdId) => ({
      user: { is: { householdMember: { some: { householdId, showAllGames: true } } } },
      excludedFromHouseholds: { none: { householdMember: { is: { householdId } } } },
    })),
  };
}
