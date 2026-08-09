import { Prisma, type DatabaseService } from '@bge/database';
import { t } from '@bge/i18n';
import { NotFoundException } from '@nestjs/common';

/**
 * Cheap existence probe (excludes soft-deleted). Lets a caller distinguish a
 * household that does not exist (→ 404) from one that exists but the actor may
 * not read/mutate (→ 403) once a permission-scoped query returns nothing.
 *
 * Consumed today by `HouseholdService` and `HouseholdMemberService`; the
 * household analog of `event-access.helpers.ts`. Scope is deliberately narrow —
 * only the existence predicate is shared here. The 403-vs-404 disambiguation
 * that follows a permission-scoped miss stays with each service, because the
 * "what does an empty result mean" question is resource-specific.
 */
export async function householdExists(db: DatabaseService, householdId: string): Promise<boolean> {
  const count = await db.household.count({ where: { id: householdId, deletedAt: null } });
  return count > 0;
}

/**
 * Asserts a household exists (and is not soft-deleted), throwing
 * `NotFoundException` otherwise.
 */
export async function assertHouseholdExists(db: DatabaseService, householdId: string): Promise<void> {
  if (!(await householdExists(db, householdId))) {
    throw new NotFoundException(t('errors.household.not_found', { id: householdId }));
  }
}

/**
 * Transactional counterpart of {@link assertHouseholdExists}: asserts the
 * household is live AND holds a share lock on its row for the remainder of the
 * caller's transaction. For write paths that add rows to a household (#276).
 *
 * The lock, not the read, is the point. `deletedAt` is an ordinary column, so
 * `deleteHousehold` soft-deletes with a plain `UPDATE households`. Under READ
 * COMMITTED an unlocked existence probe leaves a window in which that update
 * commits between the probe and the insert, producing a member on a dead
 * household with no error raised anywhere.
 *
 * The foreign key does not close it: inserting into `household_members` takes
 * `FOR KEY SHARE` on the parent row, and `FOR KEY SHARE` does not block a
 * non-key `UPDATE` — `deleted_at` is not a key column. `FOR SHARE` does.
 *
 * `FOR SHARE` rather than `FOR UPDATE` deliberately: it blocks the soft-delete's
 * exclusive lock while letting concurrent member-adds to the same household
 * proceed in parallel, which is the common case.
 *
 * Both interleavings are safe. If the soft-delete commits first, this statement
 * blocks, then re-evaluates its `WHERE` against the new row version
 * (`EvalPlanQual`), finds `deleted_at` set, matches nothing, and 404s. If this
 * commits first, the soft-delete waits and then deletes a household that
 * legitimately gained a member beforehand.
 *
 * NOTE: raw SQL because Prisma exposes no row-locking clause. The identifiers
 * are pinned against the checked-in Prisma models by a spec in this lib so a
 * later `@map` rename fails loudly; that it actually serializes is #239's
 * integration work.
 */
export async function lockExistingHousehold(tx: Prisma.TransactionClient, householdId: string): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT h.id
    FROM households h
    WHERE h.id = ${householdId}
      AND h.deleted_at IS NULL
    FOR SHARE
  `);

  if (rows.length === 0) {
    throw new NotFoundException(t('errors.household.not_found', { id: householdId }));
  }
}
