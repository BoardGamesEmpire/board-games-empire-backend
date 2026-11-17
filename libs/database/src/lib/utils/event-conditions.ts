import type { Prisma } from '../client';

/**
 * A live event: not soft-deleted, and outside any household or in one that is
 * not soft-deleted. A household delete stamps only the household, so its
 * events read and write as gone through this clause and come back on a
 * restore (#992).
 *
 * The household relation is optional, so the `householdId: null` arm keeps
 * events outside any household: a bare `household: { is: … }` filter drops
 * them.
 *
 * The clause carries a top-level `OR`. Spread it only into a `where` that has
 * no `OR` of its own; otherwise put it in an `AND` array, or one `OR` replaces
 * the other.
 *
 * Typed as only the two fields it sets, so it spreads into a unique `where`
 * (`{ id, ...liveEventWhere() }`) without widening `id` to a filter.
 *
 * Its household arm asks what `liveHouseholdOf` asks of a household, without
 * the membership. A new clause on every call, as that one builds one.
 */
export function liveEventWhere(): Pick<Prisma.EventWhereInput, 'deletedAt' | 'OR'> {
  return {
    deletedAt: null,
    OR: [{ householdId: null }, { household: { is: { deletedAt: null } } }],
  };
}
