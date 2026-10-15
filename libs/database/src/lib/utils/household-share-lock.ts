import { Prisma } from '../client';

/**
 * Reports whether a household is live AND holds a share lock on its row for
 * the remainder of the caller's transaction. For write paths that add rows to
 * a household, or change state that belongs to one (#276, #552).
 *
 * Returns rather than throws, because the callers owe different answers for a
 * dead household: the household lib a 404 (`lockExistingHousehold`), quota and
 * webhook subscription create a 403, and the plugin runtime its own typed
 * error, which its filter maps. It lives here, below all of them, so none of
 * those libraries has to import a feature lib to take it.
 *
 * The lock, not the read, is the point. `deletedAt` is an ordinary column, so
 * `deleteHousehold` soft-deletes with a plain `UPDATE households`. Under READ
 * COMMITTED an unlocked existence probe leaves a window in which that update
 * commits between the probe and the insert, producing a row on a dead
 * household with no error raised anywhere.
 *
 * The foreign key does not close it: inserting a child row takes `FOR KEY
 * SHARE` on the parent row, and `FOR KEY SHARE` does not block a non-key
 * `UPDATE` — `deleted_at` is not a key column. `FOR SHARE` does.
 *
 * `FOR SHARE` rather than `FOR UPDATE` deliberately: it blocks the soft-delete's
 * exclusive lock while letting concurrent writers to the same household
 * proceed in parallel, which is the common case.
 *
 * It does WAIT on the household lib's role-transition lock, whose `FOR NO KEY
 * UPDATE` conflicts with this mode — so a write blocks for the duration of a
 * role transition on the same household. Accepted; both are rare.
 *
 * Both interleavings are safe. If the soft-delete commits first, this statement
 * blocks, then re-evaluates its `WHERE` against the new row version
 * (`EvalPlanQual`), finds `deleted_at` set, matches nothing, and reports the
 * household dead. If this commits first, the soft-delete waits and then deletes
 * a household that legitimately gained the row beforehand.
 *
 * Take it FIRST in the transaction. Every household writer that locks the row
 * does so before anything else, so a caller that took another lock and then
 * this one could close a cycle against a soft-delete holding the row. The
 * plugin runtime's claimed lock order states it as its first stage.
 *
 * NOTE: raw SQL because Prisma exposes no row-locking clause. The identifiers
 * are pinned against the checked-in Prisma models by the household lib's
 * member service spec, through `lockExistingHousehold`; that it actually
 * blocks the soft-delete — and that the FK's own `FOR KEY SHARE` does not — is
 * pinned against a real database by
 * `apps/api-e2e/src/household/household-share-lock.spec.ts` (#239).
 */
export async function lockLiveHousehold(tx: Prisma.TransactionClient, householdId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT h.id
    FROM households h
    WHERE h.id = ${householdId}
      AND h.deleted_at IS NULL
    FOR SHARE
  `);

  return rows.length > 0;
}
