import { PluginGrantScope, PluginGrantStatus } from '@bge/database';
import { randomUUID } from 'node:crypto';
import { expectBlocked, expectNotBlocked, withBarrier, type Barrier } from '../support/lock-barrier';
import { bindTemplate, readShippedSql, readShippedValue } from '../support/shipped-sql';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import {
  arrangeGrant,
  arrangeHouseholdFor,
  arrangeHouseholdUnit,
  arrangePlugin,
  arrangeServerGrant,
  arrangeUserUnit,
  GRANT_DECISION_CLAIM,
  SERVER_GRANT_INSERT,
  UNIT_ANCHOR_INSERT,
  UNIT_SUSPEND_CLAIM,
} from './lock-fixtures';
import { LOCK_SOURCES } from './lock-order';

/**
 * The three `FOR UPDATE` statements this issue was filed about — the consent
 * path's row locks, executed under contention for the first time.
 *
 * Their unit suites pin the emitted SQL against mocks, so a weakened mode, a
 * predicate that matches nothing, or a lock that simply does not conflict
 * passes every test that exists. What none of them can show is the property the
 * statements were written for: that a second contender waits.
 *
 * Two of these cases are controls that FAIL to block, and they carry the most
 * information here. A row lock cannot lock a row that does not exist, and the
 * gap that leaves is not a defect — it is the reason the advisory key was added
 * (#323) and the reason #356's comment sends the insert half to the unique
 * index. Proving the locks block without proving where they stop would leave
 * both of those looking like belt and braces.
 */
describe('the consent path row locks (FOR UPDATE)', () => {
  const { grantService: GRANT_SERVICE, updateService: UPDATE_SERVICE, unitScopeLock: UNIT_SCOPE_LOCK } = LOCK_SOURCES;

  /**
   * The two unit locks differ only in table, so `matching` is what says which
   * was lifted — `parameterMismatch` cannot tell them apart when both bind a
   * scope id and a plugin id.
   */
  const householdUnitLock = readShippedSql(GRANT_SERVICE, ['householdId', 'pluginId'], {
    after: 'private async lockHouseholdUnit',
    matching: /household_plugins/,
  });
  // Anchored on the DECLARATION, not the name: `lockUserUnit` is called twice
  // above the statement it names, and the extractor refuses an anchor whose
  // mentions resolve to different templates rather than silently taking the
  // first — which here would be the household lock, binding the same shape.
  const userUnitLock = readShippedSql(GRANT_SERVICE, ['userId', 'pluginId'], {
    after: 'private async lockUserUnit',
    matching: /user_plugins/,
  });
  const serverGrantLock = readShippedSql(UPDATE_SERVICE, ['plugin.id'], { matching: /FOR UPDATE/ });

  const householdKeyFormat = readShippedValue(UNIT_SCOPE_LOCK, ['householdId', 'pluginId'], {
    after: 'lockHouseholdUnitScope',
  });
  const advisoryLock = readShippedSql(UNIT_SCOPE_LOCK, ['scopeKey'], {
    after: 'lockHouseholdUnitScope',
    matching: /pg_advisory_xact_lock/,
  });

  let db: TestDatabase;

  beforeAll(() => {
    db = createTestDatabase();
  });

  afterAll(async () => {
    await db.close();
  });

  const arrangeHouseholdCase = async () => {
    const plugin = await arrangePlugin(db.client);
    const { householdId, userId } = await arrangeHouseholdFor(db.client);
    const unit = await arrangeHouseholdUnit(db.client, householdId, plugin.pluginId);

    return {
      ...plugin,
      householdId,
      userId,
      unitId: unit.unitId,
      advisoryKey: bindTemplate(householdKeyFormat, [householdId, plugin.pluginId]),
    };
  };

  describe('household_plugins', () => {
    it('blocks a second transaction locking the same unit row', async () => {
      const fixture = await arrangeHouseholdCase();

      await withBarrier(async (barrier) => {
        const { holder, waiter } = barrier;

        await holder.begin();
        await holder.query(householdUnitLock.text, [fixture.householdId, fixture.pluginId]);

        await waiter.begin();
        const pending = waiter.issue(
          householdUnitLock.text,
          [fixture.householdId, fixture.pluginId],
          'a second mirror pass on the same household unit',
        );

        await expectBlocked(barrier, pending);

        await holder.commit();

        await expect(pending.result()).resolves.toHaveLength(1);
        await waiter.commit();
      });
    });

    it("re-reads the holder's suspension rather than its own snapshot", async () => {
      // The mirror's short-circuit is `unit === null || unit.suspendedForConsent
      // → return null`, and it is only idempotent if a pass that WAITED sees the
      // suspension the winner wrote. Under READ COMMITTED a blocked locking
      // read re-evaluates against the new row version — so the loser finds the
      // work already done instead of suspending an already-suspended unit and
      // emitting a second lifecycle event for it.
      const fixture = await arrangeHouseholdCase();

      await withBarrier(async (barrier) => {
        const { holder, waiter } = barrier;

        await holder.begin();
        await holder.query(householdUnitLock.text, [fixture.householdId, fixture.pluginId]);
        await holder.query(UNIT_SUSPEND_CLAIM, [fixture.unitId]);

        await waiter.begin();
        const pending = waiter.issue<{ suspended_for_consent: boolean }>(
          householdUnitLock.text,
          [fixture.householdId, fixture.pluginId],
          'the mirror pass that lost the race',
        );

        await expectBlocked(barrier, pending);

        await holder.commit();

        const rows = await pending.result();

        expect(rows[0]?.suspended_for_consent).toBe(true);

        await waiter.commit();
      });
    });

    it('does not serialize a different household', async () => {
      const plugin = await arrangePlugin(db.client);
      const first = await arrangeHouseholdFor(db.client);
      const second = await arrangeHouseholdFor(db.client);
      await arrangeHouseholdUnit(db.client, first.householdId, plugin.pluginId);
      await arrangeHouseholdUnit(db.client, second.householdId, plugin.pluginId);

      await withBarrier(async (barrier) => {
        const { holder, waiter } = barrier;

        await holder.begin();
        await holder.query(householdUnitLock.text, [first.householdId, plugin.pluginId]);

        await waiter.begin();
        const pending = waiter.issue(
          householdUnitLock.text,
          [second.householdId, plugin.pluginId],
          "another household's mirror pass",
        );

        await expectNotBlocked(barrier, pending);

        await waiter.commit();
        await holder.commit();
      });
    });

    it('locks nothing when the row does not exist — the gap the advisory key exists to close', async () => {
      // The uncomfortable control. `FOR UPDATE` on a missing row is a no-op, so
      // a mirror pass and a creator racing on a unit that does not exist yet do
      // not see each other at all: each reads "no row" past the other's
      // uncommitted INSERT. That is the pre-row race (#360 step 5), and it is
      // why every unit writer takes the `(scopeId, pluginId)` key FIRST.
      const plugin = await arrangePlugin(db.client);
      const { householdId } = await arrangeHouseholdFor(db.client);

      await withBarrier(async (barrier) => {
        const { holder, waiter } = barrier;

        await holder.begin();
        const locked = await holder.query(householdUnitLock.text, [householdId, plugin.pluginId]);

        expect(locked).toHaveLength(0);

        await waiter.begin();
        const creator = waiter.issue(
          UNIT_ANCHOR_INSERT,
          [randomUUID(), householdId, plugin.pluginId],
          'a creator of the row the mirror pass just failed to lock',
        );

        await expectNotBlocked(barrier, creator);

        await waiter.commit();
        await holder.commit();
      });
    });

    it('closes that gap once both writers take the key first', async () => {
      // Same fixture, same missing row, same two writers — with the advisory
      // key in front, which is the only difference between this case and the
      // one above.
      const plugin = await arrangePlugin(db.client);
      const { householdId } = await arrangeHouseholdFor(db.client);
      const key = bindTemplate(householdKeyFormat, [householdId, plugin.pluginId]);

      await withBarrier(async (barrier) => {
        const { holder, waiter } = barrier;

        await holder.begin();
        await holder.query(advisoryLock.text, [key]);
        await holder.query(householdUnitLock.text, [householdId, plugin.pluginId]);

        await waiter.begin();
        const creator = waiter.issue(advisoryLock.text, [key], 'the creator, taking the key first');

        await expectBlocked(barrier, creator);

        await holder.commit();

        await expect(creator.result()).resolves.toHaveLength(1);
        await waiter.commit();
      });
    });
  });

  describe('user_plugins', () => {
    it('blocks a second transaction locking the same unit row', async () => {
      const plugin = await arrangePlugin(db.client);
      const { userId } = await arrangeHouseholdFor(db.client);
      await arrangeUserUnit(db.client, userId, plugin.pluginId);

      await withBarrier(async (barrier) => {
        const { holder, waiter } = barrier;

        await holder.begin();
        await holder.query(userUnitLock.text, [userId, plugin.pluginId]);

        await waiter.begin();
        const pending = waiter.issue(
          userUnitLock.text,
          [userId, plugin.pluginId],
          'a second mirror pass on the same user unit',
        );

        await expectBlocked(barrier, pending);

        await holder.commit();

        await expect(pending.result()).resolves.toHaveLength(1);
        await waiter.commit();
      });
    });

    it('does not serialize the two axes against each other', async () => {
      // The household and user locks are different tables, so a household
      // decision and a user decision for the same plugin are independent. A
      // lock too coarse to see that would funnel both through one queue while
      // passing every blocking case above.
      const plugin = await arrangePlugin(db.client);
      const { householdId, userId } = await arrangeHouseholdFor(db.client);
      await arrangeHouseholdUnit(db.client, householdId, plugin.pluginId);
      await arrangeUserUnit(db.client, userId, plugin.pluginId);

      await withBarrier(async (barrier) => {
        const { holder, waiter } = barrier;

        await holder.begin();
        await holder.query(householdUnitLock.text, [householdId, plugin.pluginId]);

        await waiter.begin();
        const pending = waiter.issue(userUnitLock.text, [userId, plugin.pluginId], 'the user-axis mirror pass');

        await expectNotBlocked(barrier, pending);

        await waiter.commit();
        await holder.commit();
      });
    });
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

  describe('decide vs decide, both orders', () => {
    /**
     * Two decisions on the same unit, on DIFFERENT permission slugs.
     *
     * Their grant rows are different rows, so nothing about the decisions
     * themselves conflicts — which is what makes this the interesting pair.
     * What they share is the unit whose suspension they mirror, and the
     * serialization has to come from the unit-scope locks or not at all. So
     * BOTH sides write a grant row here: a follower that only took the key
     * would demonstrate advisory contention, which the mechanics tier already
     * covers, rather than two decisions meeting.
     */
    interface DecideFixture {
      readonly householdId: string;
      readonly pluginId: string;
      readonly advisoryKey: string;
      readonly leaderGrant: string;
      readonly followerGrant: string;
    }

    const arrangeTwoDecisions = async (): Promise<DecideFixture> => {
      const fixture = await arrangeHouseholdCase();
      const scope = { scopeType: PluginGrantScope.Household, scopeId: fixture.householdId };
      const leader = await arrangeGrant(db.client, { pluginId: fixture.pluginId, ...scope });
      const follower = await arrangeGrant(db.client, { pluginId: fixture.pluginId, ...scope });

      return { ...fixture, leaderGrant: leader.grantId, followerGrant: follower.grantId };
    };

    const runBothWays = async (barrier: Barrier, fixture: DecideFixture, first: 'holder' | 'waiter') => {
      const leader = first === 'holder' ? barrier.holder : barrier.waiter;
      const follower = first === 'holder' ? barrier.waiter : barrier.holder;

      // The leader decides, in the order decide() takes: grant row, key, unit.
      await leader.begin();
      await leader.query(GRANT_DECISION_CLAIM, [fixture.leaderGrant, PluginGrantStatus.Denied]);
      await leader.query(advisoryLock.text, [fixture.advisoryKey]);
      await leader.query(householdUnitLock.text, [fixture.householdId, fixture.pluginId]);

      // The follower decides too. Its grant row is a different row, so that
      // half does not wait — proving the serialization below belongs to the
      // unit and not to the decision.
      await follower.begin();
      const ownGrant = follower.issue(
        GRANT_DECISION_CLAIM,
        [fixture.followerGrant, PluginGrantStatus.Denied],
        `the second decision's own grant row, behind ${leader.label}`,
      );

      await expectNotBlocked(barrier, ownGrant);

      // Then it reaches the unit, and stops.
      const pending = follower.issue(
        advisoryLock.text,
        [fixture.advisoryKey],
        `the second decision's unit-scope work, behind ${leader.label}`,
      );

      await expectBlocked(barrier, pending);

      await leader.commit();

      await expect(pending.result()).resolves.toHaveLength(1);
      await follower.commit();
    };

    it('serializes at the unit when the holder decides first', async () => {
      const fixture = await arrangeTwoDecisions();

      await withBarrier((barrier) => runBothWays(barrier, fixture, 'holder'));
    });

    it('serializes at the unit when the waiter decides first — the same claim, run the other way round', async () => {
      // Not redundant. The two connections differ in which one the observer was
      // opened after, and an assertion that read the wrong backend would pass
      // one direction and fail the other — which is exactly the defect
      // `PendingStatement.pid` was added to rule out.
      const fixture = await arrangeTwoDecisions();

      await withBarrier((barrier) => runBothWays(barrier, fixture, 'waiter'));
    });
  });
});
