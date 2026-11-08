import { PluginGrantStatus } from '@bge/database';
import { randomUUID } from 'node:crypto';
import { expectBlocked, expectNotBlocked, withBarrier } from '../support/lock-barrier';
import { readShippedSql } from '../support/shipped-sql';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { arrangePlugin, arrangeServerGrant, GRANT_DECISION_CLAIM, SERVER_GRANT_INSERT } from './lock-fixtures';
import { LOCK_SOURCES } from './lock-order';

/**
 * The consent path's row lock on `plugin_grants` (#356), executed under
 * contention.
 *
 * This file once covered three `FOR UPDATE` statements. The two on the unit
 * rows (`household_plugins`, `user_plugins`) belonged to the passes that kept a
 * stored suspension in step with the grants, and went with them when consent
 * standing became a read-time derivation (#1149): a decision now writes its
 * grant row and, for a user's first grant, the user's unit enablement, and
 * nothing locks a unit row by raw SQL. Ordering the unit writers that remain is
 * the advisory key's job (`unit-scope-advisory-lock.spec.ts`) and the claimed
 * lock order's (`plugin-lock-order.spec.ts`).
 *
 * The unit suites pin the emitted SQL against mocks, so a weakened mode, a
 * predicate that matches nothing, or a lock that simply does not conflict
 * passes every test that exists. What none of them can show is the property the
 * statement was written for: that a second contender waits.
 *
 * Two of these cases are controls that FAIL to block, and they carry the most
 * information here. A row lock cannot lock a row that does not exist, and the
 * gap that leaves is not a defect — it is the reason #356's comment sends the
 * insert half to the unique index. Proving the lock blocks without proving
 * where it stops would leave that looking like belt and braces.
 */
describe("the consent path's grant row lock (FOR UPDATE)", () => {
  const { updateService: UPDATE_SERVICE } = LOCK_SOURCES;

  // Anchored on the declaration — #370 added a second `FOR UPDATE`
  // statement to this file (the plugin-config lock, guarding `Plugin.config`
  // against a concurrent server config PATCH), so a bare `/FOR UPDATE/` no
  // longer resolves to one statement without help locating it.
  const serverGrantLock = readShippedSql(UPDATE_SERVICE, ['plugin.id'], {
    after: 'lockedGrantRows',
    matching: /FOR UPDATE/,
  });

  let db: TestDatabase;

  beforeAll(() => {
    db = createTestDatabase();
  });

  afterAll(async () => {
    await db.close();
  });

  describe('plugin_grants (#356)', () => {
    it('blocks a decision flipping a grant it has locked', async () => {
      const plugin = await arrangePlugin(db.client);
      const grant = await arrangeServerGrant(db.client, plugin.pluginId);

      await withBarrier(async (barrier) => {
        const { holder, waiter } = barrier;

        await holder.begin();
        await holder.query(serverGrantLock.text, [plugin.pluginId]);

        await waiter.begin();
        const decision = waiter.issue(
          GRANT_DECISION_CLAIM,
          [grant.grantId, PluginGrantStatus.Denied],
          'a Granted → Denied flip mid-activation',
        );

        await expectBlocked(barrier, decision);

        await holder.commit();

        await expect(decision.result()).resolves.toHaveLength(1);
        await waiter.commit();
      });
    });

    it('does not block a decision on a DIFFERENT plugin', async () => {
      const locked = await arrangePlugin(db.client);
      const other = await arrangePlugin(db.client);
      await arrangeServerGrant(db.client, locked.pluginId);
      const otherGrant = await arrangeServerGrant(db.client, other.pluginId);

      await withBarrier(async (barrier) => {
        const { holder, waiter } = barrier;

        await holder.begin();
        await holder.query(serverGrantLock.text, [locked.pluginId]);

        await waiter.begin();
        const decision = waiter.issue(
          GRANT_DECISION_CLAIM,
          [otherGrant.grantId, PluginGrantStatus.Denied],
          "a decision on another plugin's grant",
        );

        await expectNotBlocked(barrier, decision);

        await waiter.commit();
        await holder.commit();
      });
    });

    it('does not block a NEW grant row — the insert half #356 leaves to the unique index', async () => {
      // Stated as a claim in the comment above the statement, and untestable
      // against mocks. A lock covers rows that exist; a decision taking the
      // insert arm has no row to block on, so activation's seeding and that
      // decision can only be ordered by the unique index and the retry above
      // it. Worth pinning: if this ever DID block, the retry would be dead code
      // and nobody would find out from a passing suite.
      const plugin = await arrangePlugin(db.client);
      await arrangeServerGrant(db.client, plugin.pluginId, 'read:safe_http_policy');

      await withBarrier(async (barrier) => {
        const { holder, waiter } = barrier;

        await holder.begin();
        const locked = await holder.query(serverGrantLock.text, [plugin.pluginId]);

        // A control that fails to block proves nothing unless the holder is
        // holding something: a statement matching zero rows locks nothing and
        // lets everything past.
        expect(locked).toHaveLength(1);

        await waiter.begin();
        const insertion = waiter.issue(
          SERVER_GRANT_INSERT,
          [randomUUID(), plugin.pluginId, 'read:game'],
          'a decision on a slug with no row yet',
        );

        await expectNotBlocked(barrier, insertion);

        await waiter.commit();
        await holder.commit();
      });
    });
  });
});
