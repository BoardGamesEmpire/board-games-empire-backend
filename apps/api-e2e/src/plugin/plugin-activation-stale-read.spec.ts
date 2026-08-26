import { randomUUID } from 'node:crypto';
import { expectBlocked, expectNotBlocked, withBarrier } from '../support/lock-barrier';
import { readShippedFunction } from '../support/shipped-function';
import { bindTemplate, readShippedSql, readShippedValue } from '../support/shipped-sql';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import {
  ACTIVATION_UNIT_SCAN,
  arrangeHouseholdFor,
  arrangeHouseholdUnit,
  arrangePlugin,
  UNIT_ANCHOR_INSERT,
  UNIT_SUSPEND_CLAIM,
} from './lock-fixtures';
import { LOCK_SOURCES, stageNamed } from './lock-order';

/**
 * A TRIP-WIRE, not a guarantee. Every case here records behaviour that #361 is
 * expected to CHANGE.
 *
 * Activation's batched suspension pass reads its unit set outside any lock. It
 * is a deliberate trade — a per-unit loop would put the transaction's duration
 * on the number of installs, and blowing the interactive-transaction timeout
 * would fail an activation for the crime of being popular — and it leaves
 * decide-vs-activation eventually consistent BY DESIGN. The advisory key
 * serializes the writes; it does not make activation's read wait.
 *
 * Until now that residual lived in a doc comment, which is the state this whole
 * issue is a reaction to. So it is written down as tests instead: what the read
 * can and cannot see, and where the ordering that DOES exist starts.
 *
 * ## When these go red
 *
 * Do not "fix" the test. Going red is the intended outcome of #361, which
 * proposes to re-read the plugin row inside the decision transaction and may
 * add a plugin-row lock to it. If that lands and activation starts joining the
 * unit-scope scheme, delete or invert these cases as part of that work, and say
 * so in its PR — the residual will have stopped being real.
 */
describe('activation reads its unit set unlocked (characterization — #361)', () => {
  const { updateService: UPDATE_SERVICE, unitScopeLock: UNIT_SCOPE_LOCK } = LOCK_SOURCES;
  const { grantService: GRANT_SERVICE, unitLifecycle: UNIT_LIFECYCLE } = LOCK_SOURCES;

  const advisoryLock = readShippedSql(UNIT_SCOPE_LOCK, ['scopeKey'], {
    after: 'lockHouseholdUnitScope',
    matching: /pg_advisory_xact_lock/,
  });
  const householdKeyFormat = readShippedValue(UNIT_SCOPE_LOCK, ['householdId', 'pluginId'], {
    after: 'lockHouseholdUnitScope',
  });
  const unitRowLock = readShippedSql(GRANT_SERVICE, ['householdId', 'pluginId'], {
    after: 'private async lockHouseholdUnit',
    matching: /household_plugins/,
  });

  let db: TestDatabase;

  beforeAll(() => {
    db = createTestDatabase();
  });

  afterAll(async () => {
    await db.close();
  });

  const arrangeUnit = async () => {
    const plugin = await arrangePlugin(db.client);
    const { householdId } = await arrangeHouseholdFor(db.client);
    const unit = await arrangeHouseholdUnit(db.client, householdId, plugin.pluginId);

    return {
      ...plugin,
      householdId,
      unitId: unit.unitId,
      advisoryKey: bindTemplate(householdKeyFormat, [householdId, plugin.pluginId]),
    };
  };

  it('takes no advisory key at all, which is the whole residual', () => {
    // The source half. Activation's transaction never enters the unit-scope
    // scheme, so nothing it does is ordered against a unit writer by the key —
    // only by the rows they both touch. If this ever starts matching, the
    // barrier cases below are describing a service that no longer exists.
    const advisory = stageNamed('advisory key');

    // Calibration first. A negative source assertion decays to true the moment
    // the pattern stops recognising the lock — a renamed helper would leave
    // this file confidently documenting a residual that had been fixed — so a
    // path that DOES take the key has to still be recognised.
    expect(readShippedFunction(UNIT_LIFECYCLE, 'openHouseholdUnit').body).toMatch(advisory.pattern);

    expect(readShippedFunction(UPDATE_SERVICE, 'activateInTransaction').body).not.toMatch(advisory.pattern);
  });

  it('is not held up by a unit writer holding the key', async () => {
    // The consequence, demonstrated. A decision can be mid-flight, holding the
    // key for this exact unit, and activation's suspension write goes straight
    // past it — because activation never asks for the key.
    const fixture = await arrangeUnit();

    await withBarrier(async (barrier) => {
      const { holder, waiter } = barrier;

      await holder.begin();
      await holder.query(advisoryLock.text, [fixture.advisoryKey]);

      await waiter.begin();
      const suspension = waiter.issue(
        UNIT_SUSPEND_CLAIM,
        [fixture.unitId],
        "activation's suspension write, which took no key",
      );

      await expectNotBlocked(barrier, suspension);
      await waiter.commit();

      // The control that makes that result mean something, and it has to come
      // AFTER it. An `expectNotBlocked` against a key nobody wants passes
      // whatever the holder is doing — so the same key, still held, is now
      // shown to stop a writer that DOES take it.
      //
      // Ordered this way on purpose: a blocked statement and the ROLLBACK that
      // would abandon it share one connection, and pg serialises them. Leaving
      // the contender waiting would queue the rollback behind it until
      // `lock_timeout` fired, spending ten seconds to reach the same assertion
      // and reporting a timeout rather than a release.
      await waiter.begin();
      const contender = waiter.issue(advisoryLock.text, [fixture.advisoryKey], 'a unit writer taking the key');

      await expectBlocked(barrier, contender);

      await holder.commit();

      await expect(contender.result()).resolves.toHaveLength(1);
      await waiter.commit();
    });
  });

  it('cannot see a unit row a key-holding creator has not committed', async () => {
    // The precise shape of the residual, and the reason the case above matters.
    // A household enabling the plugin right now holds the key and has inserted
    // its row; under READ COMMITTED that row is invisible to activation's scan,
    // and nothing about the scan waits for it. So the unit is created against
    // the OLD manifest, activation suspends the units it could see, and the new
    // one is left serving without the re-consent the escalation demanded.
    //
    // Eventually consistent, not lost: the creator's own transaction re-reads
    // the plugin row under `FOR SHARE` and refuses if the manifest moved. What
    // has no owner today is the window in between, which is #361's.
    //
    // The scan here is retyped rather than lifted — Prisma's `findMany` is not
    // a template — so it copies the application's predicate as well as its
    // mode. If #361 narrows that predicate this case keeps returning zero rows
    // and stops describing anything; the fixture's own doc says so.
    const plugin = await arrangePlugin(db.client);
    const { householdId } = await arrangeHouseholdFor(db.client);
    const key = bindTemplate(householdKeyFormat, [householdId, plugin.pluginId]);

    await withBarrier(async (barrier) => {
      const { holder, waiter } = barrier;

      // A household enable, mid-transaction: key taken, row inserted, not yet
      // committed.
      await holder.begin();
      await holder.query(advisoryLock.text, [key]);
      await holder.query(UNIT_ANCHOR_INSERT, [randomUUID(), householdId, plugin.pluginId]);

      // Activation's scan, arriving now.
      await waiter.begin();
      const scan = waiter.issue(ACTIVATION_UNIT_SCAN, [plugin.pluginId], "activation's unit-set read");

      await expectNotBlocked(barrier, scan);
      await expect(scan.result()).resolves.toHaveLength(0);

      await waiter.commit();
      await holder.commit();

      // And the row is there the moment the creator commits — activation simply
      // looked a moment too early, with nothing to make it look again.
      await expect(db.client.householdPlugin.count({ where: { pluginId: plugin.pluginId } })).resolves.toBe(1);
    });
  });

  it('IS ordered against a unit row that already exists — the residual is the set, not the write', async () => {
    // The boundary, and the reason this file is a characterization rather than
    // a bug report. Once a unit row exists, activation's write contends for it
    // like any other writer: a mirror pass holding it blocks activation until
    // it commits. What is unordered is which rows activation SAW, not what it
    // does to the ones it did.
    const fixture = await arrangeUnit();

    await withBarrier(async (barrier) => {
      const { holder, waiter } = barrier;

      await holder.begin();
      await holder.query(unitRowLock.text, [fixture.householdId, fixture.pluginId]);

      await waiter.begin();
      const suspension = waiter.issue(
        UNIT_SUSPEND_CLAIM,
        [fixture.unitId],
        "activation's suspension write against a locked unit row",
      );

      await expectBlocked(barrier, suspension);

      await holder.commit();

      await expect(suspension.result()).resolves.toHaveLength(1);
      await waiter.commit();
    });
  });
});
