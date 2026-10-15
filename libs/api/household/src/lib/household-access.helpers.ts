import { lockLiveHousehold, Prisma, type DatabaseService, type SystemRole } from '@bge/database';
import { t } from '@bge/i18n';
import { InternalServerErrorException, NotFoundException } from '@nestjs/common';

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
 * The lock is `@bge/database`'s `lockLiveHousehold`, which says why an unlocked
 * probe is not enough and why the mode is `FOR SHARE`. This wrapper adds the
 * household lib's answer for a dead household, the 404 every household route
 * gives (#299). Other libraries take the lock directly and answer for
 * themselves (#552).
 */
export async function lockExistingHousehold(tx: Prisma.TransactionClient, householdId: string): Promise<void> {
  if (!(await lockLiveHousehold(tx, householdId))) {
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
 * ## It is also the liveness check
 *
 * A soft-deleted household answers 404 here, and that is the authority for it.
 * Callers probe with {@link assertHouseholdExists} before the transaction, but
 * that probe takes no lock, so a soft-delete can commit between the two. Without
 * this check the transition then rewrote roles on a household the API treats
 * as gone, and a transfer emitted its audit and webhook events for it (#386).
 *
 * The predicate does not stop this statement serializing against a delete. If
 * the soft-delete is in flight, this blocks on the row lock, then re-evaluates
 * its `WHERE` against the committed version (`EvalPlanQual`), finds
 * `deleted_at` set, matches nothing, and 404s, which is the behaviour
 * {@link lockExistingHousehold} already relies on.
 *
 * A restore in flight is NOT the mirror image, and it is easy to assume it is.
 * A locking read tests its `WHERE` against its own snapshot first and locks only
 * the rows that pass there; the re-check after a wait applies to those alone.
 * An uncommitted restore leaves the row deleted in that snapshot, so it fails
 * the predicate, is never locked, and this 404s at once rather than waiting.
 * That is still correct: the household was deleted when the transition asked,
 * and the same request succeeds once the restore commits.
 *
 * All four transitions refuse, leaving included. Restore is an undo and brings
 * back exactly what was deleted, so a deleted household's roster stays frozen
 * until then; a member who wants out leaves once it is live again.
 *
 * NOTE: raw SQL because Prisma exposes no row-locking clause. The identifiers
 * are pinned against the checked-in Prisma models by a spec in this lib; the
 * interleaving with a real soft-delete is pinned by
 * `apps/api-e2e/src/household/owner-lock-serialization.spec.ts`.
 */
export async function lockHouseholdForRoleTransition(tx: Prisma.TransactionClient, householdId: string): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT h.id
    FROM households h
    WHERE h.id = ${householdId}
      AND h.deleted_at IS NULL
    FOR NO KEY UPDATE
  `);

  if (rows.length === 0) {
    throw new NotFoundException(t('errors.household.not_found', { id: householdId }));
  }
}

/**
 * A client for reads that take NO locks and whose result cannot vary with
 * transaction state. Today that is exactly one lookup, {@link resolveHouseholdRoleId},
 * which reads static seed data, so either client is correct there and the
 * caller may pick whichever avoids extending a lock window.
 *
 * This is NOT a general-purpose "any client will do". It is the exception, and
 * it is named for the property that makes it safe rather than for the clients
 * it admits. Anything that takes a row lock, takes an advisory lock, or must be
 * atomic with the caller's other writes (`HouseholdMemberService.addMemberWithin`,
 * `QuotaService.consume`) types its parameter `Prisma.TransactionClient`
 * exactly. A base client there would compile, pass its tests, and serialize
 * nothing. Do not widen a locking parameter to this union on the strength of
 * its neighbors.
 */
export type LockFreeReadClient = DatabaseService | Prisma.TransactionClient;

/**
 * Resolves a `SystemRole` to its `roles` row id, failing loud when the row is
 * absent. The member and invite services both write a role by id.
 *
 * Explicit resolution rather than a nested `role: { connect: { name } }`: a
 * missing row (seed drift: a new `SystemRole` shipped before the seed
 * reseeds) raises the same `P2025` from the connect target as a vanished
 * member row raises from the write, and the member service's
 * `rethrowMutationFailure` would report a server misconfiguration to the
 * caller as their own lack of permission. Repo-wide generalization is #242.
 */
export async function resolveHouseholdRoleId(client: LockFreeReadClient, name: SystemRole): Promise<string> {
  const role = await client.role.findUnique({ where: { name }, select: { id: true } });

  if (!role) {
    throw new InternalServerErrorException(t('errors.household.role_not_provisioned', { role: name }));
  }

  return role.id;
}
