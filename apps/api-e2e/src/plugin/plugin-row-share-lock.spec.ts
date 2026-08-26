import { randomUUID } from 'node:crypto';
import { expectBlocked, expectNotBlocked, withBarrier } from '../support/lock-barrier';
import { readShippedSql } from '../support/shipped-sql';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import {
  ACTIVATION_VERSION_BUMP,
  arrangeHouseholdFor,
  arrangePlugin,
  FK_PLUGIN_LOCK,
  UNINSTALL_CLAIM,
} from './lock-fixtures';

/**
 * `assertStillLiving`'s share lock on the `plugins` row (#323), the head of the
 * plugin runtime's lock order and the one mechanism #383 exists to prove.
 *
 * Every unit transaction opens by re-reading the plugin row `FOR SHARE`, and the
 * comment at `plugin-unit-lifecycle.service.ts:492` states exactly why that mode
 * and not `FOR UPDATE`: concurrent unit writes for the same plugin must proceed
 * in parallel while an uninstall is blocked. That is a claim about two cells of
 * the Postgres lock-conflict matrix, and until now it was asserted nowhere —
 * the unit suite mocks `$queryRaw` and pins the statement's text.
 *
 * Three modes are in play and only one of them is correct:
 *
 *  - `FOR KEY SHARE` is what a `household_plugins` insert already takes on the
 *    parent, implicitly, through the foreign key. It does NOT conflict with the
 *    uninstall claim's non-key UPDATE — which is why the FK cannot close the
 *    race and an explicit lock was needed at all.
 *  - `FOR SHARE` does conflict with that UPDATE, while remaining compatible
 *    with itself.
 *  - `FOR UPDATE` would also block the uninstall, and would serialize every
 *    unit write for the plugin behind every other — correct but needlessly
 *    strong, and the comment says so.
 *
 * A suite that only showed "the second transaction waited" could not tell those
 * three apart. So the shipped mode is exercised as the guard (it must block),
 * the FK's own mode as a control (it must not), and a second `FOR SHARE` as the
 * parallelism the mode was chosen for (it must not).
 */
describe('plugin row share lock (FOR SHARE)', () => {
  const UNIT_LIFECYCLE = 'libs/plugin/runtime/src/lib/units/plugin-unit-lifecycle.service.ts';

  /**
   * The statement `assertStillLiving` ships, binding `${plugin.id}`.
   *
   * No `after` anchor: the file holds exactly one raw statement, and the
   * extractor refuses loudly the moment it holds two. That refusal is the right
   * failure — whoever adds the second statement names which one this spec means
   * rather than inheriting whichever comes first.
   */
  const shareLock = readShippedSql(UNIT_LIFECYCLE, ['plugin.id'], { matching: /FOR SHARE/ });

  interface PluginRow {
    readonly uninstalled_at: Date | null;
    readonly scope: string;
    readonly version: string;
    readonly installed_at: Date;
  }

  let db: TestDatabase;

  beforeAll(() => {
    db = createTestDatabase();
  });

  afterAll(async () => {
    await db.close();
  });

  it('executes against the real schema and reads the living plugin row', async () => {
    // The cheap half, and not decoration: this is the only thing that runs the
    // statement's column list against real columns. A `@map` rename that the
    // identifier pin somehow survived dies here.
    const plugin = await arrangePlugin(db.client);

    await withBarrier(async ({ holder }) => {
      const rows = await holder.query<PluginRow>(shareLock.text, [plugin.pluginId]);

      expect(rows).toHaveLength(1);
      expect(rows[0]?.uninstalled_at).toBeNull();
      expect(rows[0]?.version).toBe(plugin.version);
      expect(rows[0]?.scope).toBe('Household');
    });
  });

  it('matches nothing for a plugin id that does not exist', async () => {
    // The miss `assertStillLiving` turns into `PluginUnitPluginNotFoundError`.
    await withBarrier(async ({ holder }) => {
      await expect(holder.query(shareLock.text, [randomUUID()])).resolves.toHaveLength(0);
    });
  });

  it("blocks an uninstall's claim while a unit write holds it", async () => {
    // The guard. A unit write in flight stops the uninstall from claiming the
    // row underneath it, which is what keeps the purge from deleting unit rows
    // a committing transaction is still writing.
    const plugin = await arrangePlugin(db.client);

    await withBarrier(async (barrier) => {
      const { holder, waiter } = barrier;

      await holder.begin();
      await expect(holder.query(shareLock.text, [plugin.pluginId])).resolves.toHaveLength(1);

      await waiter.begin();
      const pending = waiter.issue<{ id: string }>(UNINSTALL_CLAIM, [plugin.pluginId], "the uninstall's claim");

      await expectBlocked(barrier, pending);

      await holder.commit();

      await expect(pending.result()).resolves.toHaveLength(1);
      await waiter.commit();

      const row = await db.client.plugin.findUniqueOrThrow({ where: { id: plugin.pluginId } });
      expect(row.uninstalledAt).not.toBeNull();
    });
  });

  it('does not block a second unit write — the reason the mode is SHARE and not UPDATE', async () => {
    // The claim at `:492`, and the one a stronger lock would break silently:
    // `FOR UPDATE` here would pass every other case in this file while
    // serializing every unit write for a plugin behind every other.
    const plugin = await arrangePlugin(db.client);

    await withBarrier(async (barrier) => {
      const { holder, waiter } = barrier;

      await holder.begin();
      await expect(holder.query(shareLock.text, [plugin.pluginId])).resolves.toHaveLength(1);

      await waiter.begin();
      const pending = waiter.issue<PluginRow>(shareLock.text, [plugin.pluginId], "a second unit write's share lock");

      await expectNotBlocked(barrier, pending);
      await expect(pending.result()).resolves.toHaveLength(1);

      await waiter.commit();
      await holder.commit();
    });
  });

  it('re-reads the tombstone after an in-flight uninstall commits, rather than its own snapshot', async () => {
    // The reverse ordering, and the subtle one. Under READ COMMITTED the
    // blocked statement does not return the row version it originally located:
    // on release it re-evaluates against the NEW version (EvalPlanQual) and
    // reports `uninstalled_at` set — which is what makes `assertStillLiving`
    // refuse rather than write units onto a plugin that is being removed.
    //
    // If that assumption were wrong every unit test would still pass, and the
    // unit path would happily enable a feature on a tombstoned plugin.
    const plugin = await arrangePlugin(db.client);

    await withBarrier(async (barrier) => {
      const { holder, waiter } = barrier;

      await holder.begin();
      await expect(holder.query(UNINSTALL_CLAIM, [plugin.pluginId])).resolves.toHaveLength(1);

      await waiter.begin();
      const pending = waiter.issue<PluginRow>(shareLock.text, [plugin.pluginId], "the unit write's share lock");

      await expectBlocked(barrier, pending);

      await holder.commit();

      const rows = await pending.result();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.uninstalled_at).not.toBeNull();

      await waiter.commit();
    });
  });

  it('returns the version a concurrent activation committed, not the pre-transaction one', async () => {
    // The other half of the same re-read, and the reason the statement selects
    // `scope` and `version` at all: the caller re-runs its gates against what
    // this returns. A lock that blocked correctly but handed back the snapshot
    // value would leave every gate judging a manifest that no longer exists,
    // and nothing else in the suite would notice.
    const plugin = await arrangePlugin(db.client);

    await withBarrier(async (barrier) => {
      const { holder, waiter } = barrier;

      await holder.begin();
      await expect(holder.query(ACTIVATION_VERSION_BUMP, [plugin.pluginId, '2.0.0'])).resolves.toHaveLength(1);

      await waiter.begin();
      const pending = waiter.issue<PluginRow>(shareLock.text, [plugin.pluginId], "the unit write's share lock");

      await expectBlocked(barrier, pending);

      await holder.commit();

      const rows = await pending.result();
      expect(rows[0]?.version).toBe('2.0.0');
      expect(rows[0]?.version).not.toBe(plugin.version);

      await waiter.commit();
    });
  });

  it("does not block the uninstall under the FK's own lock mode — which is why the explicit lock exists", async () => {
    // The control. `FOR KEY SHARE` is what a unit insert already takes on the
    // parent plugin row, and it lets the uninstall claim straight through.
    // Without this case, the blocking above would only show that SOMETHING
    // serializes; with it, the gap the explicit `FOR SHARE` closes is visible.
    const plugin = await arrangePlugin(db.client);

    await withBarrier(async (barrier) => {
      const { holder, waiter } = barrier;

      await holder.begin();
      await expect(holder.query(FK_PLUGIN_LOCK, [plugin.pluginId])).resolves.toHaveLength(1);

      await waiter.begin();
      const pending = waiter.issue<{ id: string }>(UNINSTALL_CLAIM, [plugin.pluginId], "the uninstall's claim");

      await expectNotBlocked(barrier, pending);
      await expect(pending.result()).resolves.toHaveLength(1);

      await waiter.commit();
      await holder.commit();
    });
  });

  it('takes that same non-blocking mode when a real unit row is inserted', async () => {
    // The claim above, made against the actual foreign key rather than a
    // statement standing in for it: an in-flight `household_plugins` insert
    // does not stop the plugin from being uninstalled underneath it. This is
    // the race in full, and it is why a unit write cannot rely on the FK alone.
    const plugin = await arrangePlugin(db.client);
    const { householdId } = await arrangeHouseholdFor(db.client);

    await withBarrier(async (barrier) => {
      const { holder, waiter } = barrier;

      await holder.begin();
      await holder.query(
        'INSERT INTO household_plugins (id, household_id, plugin_id, updated_at) VALUES ($1, $2, $3, now())',
        [randomUUID(), householdId, plugin.pluginId],
      );

      await waiter.begin();
      const pending = waiter.issue<{ id: string }>(UNINSTALL_CLAIM, [plugin.pluginId], "the uninstall's claim");

      await expectNotBlocked(barrier, pending);

      await waiter.commit();
      await holder.commit();

      // Both committed: a unit row on a plugin whose `uninstalled_at` is set.
      const row = await db.client.plugin.findUniqueOrThrow({ where: { id: plugin.pluginId } });
      expect(row.uninstalledAt).not.toBeNull();
      await expect(db.client.householdPlugin.count({ where: { pluginId: plugin.pluginId } })).resolves.toBe(1);
    });
  });
});
