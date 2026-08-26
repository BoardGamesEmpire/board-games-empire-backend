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
 * It does WAIT on {@link lockHouseholdForRoleTransition}, whose `FOR NO KEY
 * UPDATE` conflicts with this mode — so an admission blocks for the duration of
 * a role transition on the same household. Accepted; both are rare.
 *
 * Both interleavings are safe. If the soft-delete commits first, this statement
 * blocks, then re-evaluates its `WHERE` against the new row version
 * (`EvalPlanQual`), finds `deleted_at` set, matches nothing, and 404s. If this
 * commits first, the soft-delete waits and then deletes a household that
 * legitimately gained a member beforehand.
 *
 * NOTE: raw SQL because Prisma exposes no row-locking clause. The identifiers
 * are pinned against the checked-in Prisma models by a spec in this lib so a
 * later `@map` rename fails loudly; that it actually blocks the soft-delete —
 * and that the FK's own `FOR KEY SHARE` does not — is pinned against a real
 * database by `apps/api-e2e/src/household/household-share-lock.spec.ts` (#239).
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

/**
 * Serializes role transitions within one household by locking the HOUSEHOLD ROW
 * for the remainder of the caller's transaction (#239).
 *
 * ## Why the owner-row lock is not enough on its own
 *
 * `lockHouseholdOwnerRows` takes `FOR UPDATE OF hr` over the rows that are
 * owners *right now*, and that set is defined by a predicate — `roles.name =
 * 'HouseholdOwner'` — which is exactly what a concurrent transfer mutates.
 * Under READ COMMITTED a blocked locking SELECT does not re-run; it re-checks
 * (EvalPlanQual) only the rows its own snapshot already located. So when a
 * transfer commits while a departure waits:
 *
 *  - the demoted owner's row IS re-checked, no longer matches, and drops out;
 *  - the promoted member's row was never in the result set — it was a plain
 *    member when the snapshot was taken — so it is never added.
 *
 * The departure therefore observes ZERO owners, concludes the member leaving is
 * not the last one, and deletes the household's only owner. No error, nothing
 * in the logs, and an unadministrable household. `apps/api-e2e` pins both the
 * mechanism and the endpoint behaviour.
 *
 * A row lock cannot serialize writers that change the predicate defining which
 * rows it covers. The household row can't be changed out from under anyone, so
 * it can. Every path that reads role state and then writes it takes this first.
 *
 * ## Why `FOR NO KEY UPDATE`
 *
 * It conflicts with itself, which is all mutual exclusion between role
 * transitions requires, and it conflicts with the soft-delete's plain `UPDATE`
 * (also a non-key update) — so a household cannot be deleted midway through one.
 * It does NOT conflict with `FOR KEY SHARE`, the mode a `household_members`
 * insert takes implicitly through its foreign key, so nothing about an ordinary
 * FK reference to this household waits on it. `FOR UPDATE` would block those for
 * no benefit.
 *
 * What DOES wait is {@link lockExistingHousehold}: `FOR SHARE` conflicts with
 * this mode, so an admission through `addMemberWithin` blocks for the duration
 * of a role transition on the same household. That is accepted rather than
 * accidental — both operations are rare, and admitting a member while ownership
 * is mid-swap has no meaning worth preserving.
 *
 * ## What this does NOT check
 *
 * The rows are discarded, and there is no `deleted_at` predicate: this is a
 * mutex, not an existence guard, and it must serialize against a soft-delete
 * rather than be filtered out by one. Callers establish liveness with
 * {@link assertHouseholdExists} BEFORE the transaction, which is an unlocked
 * probe — so a soft-delete that commits in between leaves the caller mutating
 * roles on a dead household, and emitting events for it. Tracked as #386, which
 * carries the decision the fix depends on: whether a member may leave a
 * soft-deleted household.
 *
 * NOTE: raw SQL because Prisma exposes no row-locking clause. The identifiers
 * are pinned against the checked-in Prisma models by a spec in this lib.
 */
export async function lockHouseholdForRoleTransition(tx: Prisma.TransactionClient, householdId: string): Promise<void> {
  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT h.id
    FROM households h
    WHERE h.id = ${householdId}
    FOR NO KEY UPDATE
  `);
}
