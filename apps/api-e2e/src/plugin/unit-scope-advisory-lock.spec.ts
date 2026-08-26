import { randomUUID } from 'node:crypto';
import { expectBlocked, expectNotBlocked, withBarrier } from '../support/lock-barrier';
import { bindTemplate, readShippedSql, readShippedValue } from '../support/shipped-sql';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { arrangeHouseholdFor, arrangePlugin } from './lock-fixtures';

/**
 * The `(scopeId, pluginId)` advisory locks every unit writer takes
 * (`unit-scope-lock.ts`, #323), proven to serialize rather than merely to be
 * issued — the unit suite asserts `$executeRaw` was called with the right
 * template and stops there.
 *
 * These exist because a row lock cannot order a transaction that CREATES the
 * row: while the creator's INSERT is uncommitted the other side's `FOR UPDATE`
 * finds no row to wait on, and while that side's write is uncommitted the
 * creator's probe cannot see it under READ COMMITTED, so both commit believing
 * the other absent (PR #359 round 6). An advisory key exists before the row
 * does, so whichever transaction takes it second observes the first's commit.
 *
 * That is the property under test here: the key blocks. The pre-row race it
 * closes is #360's, because it needs two application transactions rather than
 * two statements.
 *
 * The KEY FORMAT is lifted from source rather than retyped (D-360-1). Both
 * sides of a barrier that agreed on a format production no longer uses would
 * block exactly as expected and prove nothing at all, and the format is built
 * in TypeScript a line above the statement that hashes it — so lifting the
 * statement alone would leave the interesting half unpinned.
 */
describe('unit-scope advisory locks (pg_advisory_xact_lock)', () => {
  const UNIT_SCOPE_LOCK = 'libs/plugin/runtime/src/lib/grants/unit-scope-lock.ts';

  /** The statement both functions ship; they differ only in the key they hash. */
  const householdLock = readShippedSql(UNIT_SCOPE_LOCK, ['scopeKey'], {
    after: 'lockHouseholdUnitScope',
    matching: /pg_advisory_xact_lock/,
  });
  const userLock = readShippedSql(UNIT_SCOPE_LOCK, ['scopeKey'], {
    after: 'lockUserUnitScope',
    matching: /pg_advisory_xact_lock/,
  });

  /** The key formats, so a spec cannot quietly invent its own namespace. */
  const householdKey = readShippedValue(UNIT_SCOPE_LOCK, ['householdId', 'pluginId'], {
    after: 'lockHouseholdUnitScope',
  });
  const userKey = readShippedValue(UNIT_SCOPE_LOCK, ['userId', 'pluginId'], { after: 'lockUserUnitScope' });

  let db: TestDatabase;

  beforeAll(() => {
    db = createTestDatabase();
  });

  afterAll(async () => {
    await db.close();
  });

  it('derives a distinct key per axis from the shipped formats', () => {
    // Not a database fact — a guard on everything below. Every blocking case
    // here is only meaningful if the two axes hash different strings, and the
    // formats are what decide that.
    const same = randomUUID();

    expect(bindTemplate(householdKey, [same, 'plugin-1'])).not.toBe(bindTemplate(userKey, [same, 'plugin-1']));
  });

  it('blocks a second transaction taking the same household key', async () => {
    const plugin = await arrangePlugin(db.client);
    const { householdId } = await arrangeHouseholdFor(db.client);
    const key = bindTemplate(householdKey, [householdId, plugin.pluginId]);

    await withBarrier(async (barrier) => {
      const { holder, waiter } = barrier;

      await holder.begin();
      await holder.query(householdLock.text, [key]);

      await waiter.begin();
      const pending = waiter.issue(householdLock.text, [key], 'the second household unit writer');

      await expectBlocked(barrier, pending);

      await holder.commit();

      await expect(pending.result()).resolves.toHaveLength(1);
      await waiter.commit();
    });
  });

  it('blocks a second transaction taking the same user key', async () => {
    const plugin = await arrangePlugin(db.client);
    const { userId } = await arrangeHouseholdFor(db.client);
    const key = bindTemplate(userKey, [userId, plugin.pluginId]);

    await withBarrier(async (barrier) => {
      const { holder, waiter } = barrier;

      await holder.begin();
      await holder.query(userLock.text, [key]);

      await waiter.begin();
      const pending = waiter.issue(userLock.text, [key], 'the second user unit writer');

      await expectBlocked(barrier, pending);

      await holder.commit();

      await expect(pending.result()).resolves.toHaveLength(1);
      await waiter.commit();
    });
  });

  it('releases the key on ROLLBACK as well as COMMIT', async () => {
    // `_xact_` rather than `pg_advisory_lock`, and the distinction is the whole
    // reason the session variant is wrong here: a unit write that throws must
    // free the key with its transaction. The session variant would strand it
    // for the life of the connection — and on a pooled connection, for every
    // request that borrows it afterwards.
    const plugin = await arrangePlugin(db.client);
    const { householdId } = await arrangeHouseholdFor(db.client);
    const key = bindTemplate(householdKey, [householdId, plugin.pluginId]);

    await withBarrier(async (barrier) => {
      const { holder, waiter } = barrier;

      await holder.begin();
      await holder.query(householdLock.text, [key]);

      await waiter.begin();
      const pending = waiter.issue(householdLock.text, [key], 'the writer behind a failed one');

      await expectBlocked(barrier, pending);

      await holder.rollback();

      await expect(pending.result()).resolves.toHaveLength(1);
      await waiter.commit();
    });
  });

  it('does not serialize a different household — the key is per unit, not per plugin', async () => {
    // The control against over-serialization. A key that ignored `scopeId`
    // would pass every blocking case above while funnelling every household's
    // enablement of a popular plugin through one lock.
    const plugin = await arrangePlugin(db.client);
    const first = await arrangeHouseholdFor(db.client);
    const second = await arrangeHouseholdFor(db.client);

    await withBarrier(async (barrier) => {
      const { holder, waiter } = barrier;

      await holder.begin();
      await holder.query(householdLock.text, [bindTemplate(householdKey, [first.householdId, plugin.pluginId])]);

      await waiter.begin();
      const pending = waiter.issue(
        householdLock.text,
        [bindTemplate(householdKey, [second.householdId, plugin.pluginId])],
        "another household's unit writer",
      );

      await expectNotBlocked(barrier, pending);

      await waiter.commit();
      await holder.commit();
    });
  });

  it('does not serialize the two axes against each other, even for identical ids', async () => {
    // The namespace prefix earns its place here. `household_unit` and
    // `user_unit` are separate keyspaces, so a household and a user that
    // happened to share an id do not contend — and the two writers are
    // genuinely independent, touching different tables.
    const plugin = await arrangePlugin(db.client);
    const shared = randomUUID();

    await withBarrier(async (barrier) => {
      const { holder, waiter } = barrier;

      await holder.begin();
      await holder.query(householdLock.text, [bindTemplate(householdKey, [shared, plugin.pluginId])]);

      await waiter.begin();
      const pending = waiter.issue(
        userLock.text,
        [bindTemplate(userKey, [shared, plugin.pluginId])],
        'the user-axis writer',
      );

      await expectNotBlocked(barrier, pending);

      await waiter.commit();
      await holder.commit();
    });
  });

  it('does not block a writer that skips it — which is why every writer must take it', async () => {
    // The uncomfortable control, and the one that makes the doc comment's
    // "do NOT remove the lock from such a site as an optimization" testable.
    // An advisory key guards nothing on its own: a transaction that writes the
    // unit row without taking it sails past a held key. Uniformity is the
    // mechanism, not the lock.
    const plugin = await arrangePlugin(db.client);
    const { householdId } = await arrangeHouseholdFor(db.client);
    const key = bindTemplate(householdKey, [householdId, plugin.pluginId]);

    await withBarrier(async (barrier) => {
      const { holder, waiter } = barrier;

      await holder.begin();
      await holder.query(householdLock.text, [key]);

      await waiter.begin();
      const pending = waiter.issue(
        'INSERT INTO household_plugins (id, household_id, plugin_id, updated_at) VALUES ($1, $2, $3, now()) RETURNING id',
        [randomUUID(), householdId, plugin.pluginId],
        'a unit writer that never took the key',
      );

      await expectNotBlocked(barrier, pending);

      await waiter.commit();
      await holder.commit();

      await expect(db.client.householdPlugin.count({ where: { pluginId: plugin.pluginId } })).resolves.toBe(1);
    });
  });
});
