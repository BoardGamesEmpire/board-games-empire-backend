import type { DatabaseService } from '@bge/database';
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
