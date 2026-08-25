import { randomUUID } from 'node:crypto';
import { expectBlocked, expectNotBlocked, withBarrier } from '../support/lock-barrier';
import { readShippedSql } from '../support/shipped-sql';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { arrangeEmptyHousehold } from './lock-fixtures';

/**
 * `lockExistingHousehold`'s share lock (#276), under #239's 2026-08-10
 * amendment. A different lock from the owner lock next door, and a different
 * claim: not mutual exclusion between two writers, but one writer blocking a
 * DIFFERENT KIND of writer — and the exact lock mode is the whole point.
 *
 *  - `deleteHousehold` soft-deletes with `UPDATE households SET deleted_at`,
 *    which touches no key column and so takes `FOR NO KEY UPDATE`.
 *  - Inserting a `household_members` row takes `FOR KEY SHARE` on the parent,
 *    implicitly, via the foreign key. `FOR KEY SHARE` does NOT conflict with
 *    `FOR NO KEY UPDATE` — which is exactly why the FK does not close the race
 *    and an explicit lock was needed.
 *  - `FOR SHARE` does conflict. That one cell of the Postgres lock-conflict
 *    matrix is what the guard rests on, and it has never been executed.
 *
 * A test that only showed "the second transaction waited" would not tell those
 * three modes apart, because the FK's lock is present either way. So the FK's
 * own mode is exercised as a control (it must NOT block), and the shipped
 * statement's mode is exercised as the guard (it must).
 *
 * ADMISSION HAS NO ENDPOINT YET (D-239-4). `addMemberWithin` is an internal
 * seam with no HTTP caller until the invite flow (#163), so the product-level
 * races belong there and this spec covers the mechanism only.
 */
describe('household share lock (FOR SHARE)', () => {
  const HELPERS = 'libs/api/household/src/lib/household-access.helpers.ts';

  /**
   * The statement `lockExistingHousehold` ships, binding `${householdId}`. The
   * file also holds the role-transition lock (#239), so the anchor names which
   * of the two this spec means rather than relying on ordering.
   */
  const shareLock = readShippedSql(HELPERS, ['householdId'], {
    after: 'lockExistingHousehold',
    matching: /FOR SHARE/,
  });

  /**
   * Stand-in for `deleteHousehold`'s soft delete. Prisma writes
   * `SET deleted_at = $1, updated_at = $2`; what matters for the lock is that
   * every column it touches is a non-key column, which is what makes it a
   * `FOR NO KEY UPDATE` — the weaker mode the FK fails to block.
   */
  const SOFT_DELETE = 'UPDATE households SET deleted_at = now(), updated_at = now() WHERE id = $1 RETURNING id';

  /** What a member insert takes on the parent row, stated explicitly. */
  const FK_STYLE_LOCK = 'SELECT h.id FROM households h WHERE h.id = $1 FOR KEY SHARE';

  let db: TestDatabase;

  beforeAll(() => {
    db = createTestDatabase();
  });

  afterAll(async () => {
    await db.close();
  });

  it('executes against the real schema and matches a live household', async () => {
    const { householdId } = await arrangeEmptyHousehold(db.client);

    await withBarrier(async ({ holder }) => {
      const rows = await holder.query<{ id: string }>(shareLock.text, [householdId]);

      expect(rows.map((row) => row.id)).toEqual([householdId]);
    });
  });

  it('matches nothing once the household is soft-deleted', async () => {
    // The `deleted_at IS NULL` predicate is what turns the lock's miss into the
    // 404 `lockExistingHousehold` raises.
    const { householdId } = await arrangeEmptyHousehold(db.client);
    await db.client.household.update({ where: { id: householdId }, data: { deletedAt: new Date() } });

    await withBarrier(async ({ holder }) => {
      await expect(holder.query(shareLock.text, [householdId])).resolves.toHaveLength(0);
    });
  });

  it('blocks a soft-delete while an admission holds it', async () => {
    // Admission first. The member is admitted to a household that was live
    // when it was admitted, and the delete lands afterwards — correct, and the
    // ordering that is easy to get right.
    const { householdId } = await arrangeEmptyHousehold(db.client);

    await withBarrier(async (barrier) => {
      const { holder, waiter } = barrier;

      await holder.begin();
      await expect(holder.query(shareLock.text, [householdId])).resolves.toHaveLength(1);

      await waiter.begin();
      const pending = waiter.issue<{ id: string }>(SOFT_DELETE, [householdId], 'the soft-delete');

      await expectBlocked(barrier, pending);

      await holder.commit();

      await expect(pending.result()).resolves.toHaveLength(1);
      await waiter.commit();

      const household = await db.client.household.findUniqueOrThrow({ where: { id: householdId } });
      expect(household.deletedAt).not.toBeNull();
    });
  });

  it('re-checks its predicate after an in-flight soft-delete commits, and matches nothing', async () => {
    // The subtle ordering, and the one most worth pinning. Under READ COMMITTED
    // the blocked statement does not return the row version it originally
    // located: on release it re-evaluates its WHERE against the NEW version
    // (EvalPlanQual), finds `deleted_at` set, and matches nothing — which is
    // what makes `lockExistingHousehold` answer 404 rather than admitting a
    // member to a household that is being deleted.
    //
    // If that assumption were wrong, every unit test would still pass and the
    // guard would silently admit members to dead households.
    const { householdId } = await arrangeEmptyHousehold(db.client);

    await withBarrier(async (barrier) => {
      const { holder, waiter } = barrier;

      await holder.begin();
      await expect(holder.query<{ id: string }>(SOFT_DELETE, [householdId])).resolves.toHaveLength(1);

      await waiter.begin();
      const pending = waiter.issue<{ id: string }>(shareLock.text, [householdId], 'the admission probe');

      await expectBlocked(barrier, pending);

      await holder.commit();

      await expect(pending.result()).resolves.toHaveLength(0);
      await waiter.commit();
    });
  });

  it("does not block the soft-delete under the FK's own lock mode — which is why the explicit lock exists", async () => {
    // The control. `FOR KEY SHARE` is what the member insert already takes via
    // the foreign key, and it lets the soft-delete straight through. Without
    // this case, the blocking above would only show that SOMETHING serializes;
    // with it, the gap the explicit `FOR SHARE` closes is visible.
    const { householdId } = await arrangeEmptyHousehold(db.client);

    await withBarrier(async (barrier) => {
      const { holder, waiter } = barrier;

      await holder.begin();
      await expect(holder.query(FK_STYLE_LOCK, [householdId])).resolves.toHaveLength(1);

      await waiter.begin();
      const pending = waiter.issue<{ id: string }>(SOFT_DELETE, [householdId], 'the soft-delete');

      await expectNotBlocked(barrier, pending);
      await expect(pending.result()).resolves.toHaveLength(1);

      await waiter.commit();
      await holder.commit();
    });
  });

  it('takes the same non-blocking mode when a real member row is inserted', async () => {
    // The claim above, made against the actual FK rather than a statement that
    // stands in for it: an in-flight member insert does not stop the household
    // from being soft-deleted underneath it. This is the race in full — and it
    // is why `addMemberWithin` cannot rely on the foreign key alone.
    const { householdId, userId } = await arrangeEmptyHousehold(db.client);

    await withBarrier(async (barrier) => {
      const { holder, waiter } = barrier;

      await holder.begin();
      await holder.query(
        'INSERT INTO household_members (id, user_id, household_id, updated_at) VALUES ($1, $2, $3, now())',
        [randomUUID(), userId, householdId],
      );

      await waiter.begin();
      const pending = waiter.issue<{ id: string }>(SOFT_DELETE, [householdId], 'the soft-delete');

      await expectNotBlocked(barrier, pending);

      await waiter.commit();
      await holder.commit();

      // Both committed: a member on a household whose `deleted_at` is set.
      const household = await db.client.household.findUniqueOrThrow({ where: { id: householdId } });
      expect(household.deletedAt).not.toBeNull();
      await expect(db.client.householdMember.count({ where: { householdId } })).resolves.toBe(1);
    });
  });
});
