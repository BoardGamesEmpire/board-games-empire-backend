import { PluginGrantStatus } from '@bge/database';
import { expectBlocked, withBarrier } from '../support/lock-barrier';
import { orderMismatch, readShippedBranch, readShippedFunction } from '../support/shipped-function';
import { bindTemplate, readShippedSql, readShippedValue } from '../support/shipped-sql';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import {
  ACTIVATION_VERSION_BUMP,
  arrangeHouseholdFor,
  arrangeHouseholdUnit,
  arrangePlugin,
  arrangeServerGrant,
  GRANT_DECISION_CLAIM,
} from './lock-fixtures';
import {
  CLAIMED_LOCK_ORDER,
  LOCK_ORDER_PATHS,
  LOCK_SOURCES,
  stageNamed,
  stagesNamed,
  type LockStageName,
} from './lock-order';

/**
 * The claimed total order — `plugin row -> grant row -> advisory key -> unit
 * row` — proven the only two ways it can be (#360).
 *
 * Neither half counts alone, and saying which is which is the point:
 *
 *  - The BARRIER cases below show what the order does. Taken consistently it
 *    queues; taken inverted by one writer it deadlocks, which is a property of
 *    Postgres and says nothing about this application.
 *  - The SOURCE PINS show which order the application takes. That is a property
 *    of the shipped text and says nothing about whether it is safe.
 *
 * Ship only the barrier and these specs go on passing over a service that
 * reordered its locks — not hypothetically: the branch that became #323 opened
 * advisory-first, closing `advisory -> plugin -> grant -> advisory`, and it was
 * caught in review rather than by a test. Ship only the pins and the order is
 * proven written, never proven safe.
 *
 * Why this is not a race over HTTP. Firing a decision and an approval at each
 * other would exercise the real code, but a deadlock is probabilistic: a green
 * run proves nothing, and making contention reliable enough to prove something
 * is the shape #330 tracks. So the two application transactions are replayed as
 * the statements they ship — every stage below is lifted from source, only the
 * sequencing is this spec's — and the sequencing itself is pinned back against
 * the shipped text.
 */
describe('the plugin consent path is one lock order (#360)', () => {
  const { unitLifecycle: UNIT_LIFECYCLE, unitScopeLock: UNIT_SCOPE_LOCK } = LOCK_SOURCES;
  const { grantService: GRANT_SERVICE, updateService: UPDATE_SERVICE } = LOCK_SOURCES;

  /** Stage 1: the plugin row, as the unit paths take it. */
  const pluginShareLock = readShippedSql(UNIT_LIFECYCLE, ['plugin.id'], { matching: /FOR SHARE/ });

  /** Stage 2: the server grant rows, as activation takes them (#356). */
  const grantRowLock = readShippedSql(UPDATE_SERVICE, ['plugin.id'], { matching: /FOR UPDATE/ });

  /** Stage 3: the `(scopeId, pluginId)` key, and the format it is built from. */
  const advisoryLock = readShippedSql(UNIT_SCOPE_LOCK, ['scopeKey'], {
    after: 'lockHouseholdUnitScope',
    matching: /pg_advisory_xact_lock/,
  });
  const advisoryKeyFormat = readShippedValue(UNIT_SCOPE_LOCK, ['householdId', 'pluginId'], {
    after: 'lockHouseholdUnitScope',
  });

  /** Stage 4: the unit row, as the mirror passes take it. */
  // Anchored on the DECLARATION, like the user twin: `lockHouseholdUnit` is
  // called twice above the statement it names, and resolving by bare name works
  // only while this method happens to be declared before its sibling.
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

  /**
   * The rows all four stages need, plus the advisory key bound from the shipped
   * format rather than retyped — a barrier holding a key nothing contends for
   * blocks nobody and reports a false negative.
   */
  const arrangeContendedPlugin = async () => {
    const plugin = await arrangePlugin(db.client);
    const { householdId } = await arrangeHouseholdFor(db.client);
    const grant = await arrangeServerGrant(db.client, plugin.pluginId);
    await arrangeHouseholdUnit(db.client, householdId, plugin.pluginId);

    return {
      ...plugin,
      householdId,
      grantId: grant.grantId,
      advisoryKey: bindTemplate(advisoryKeyFormat, [householdId, plugin.pluginId]),
    };
  };

  describe('the order the application takes — pinned from source', () => {
    it.each(LOCK_ORDER_PATHS)(
      '$label takes them in the claimed order',
      ({ label, file, functionName, stages, because, branch }) => {
        const { body } =
          branch === undefined
            ? readShippedFunction(file, functionName)
            : readShippedBranch(file, functionName, branch);

        // A path takes a SUBSET of the order, and which subset is a claim of its
        // own — so the reason rides into the failure message, where whoever
        // reordered the locks will be reading it.
        expect(orderMismatch(body, stagesNamed(stages), `${label} — ${because}`)).toBeUndefined();
      },
    );

    it('refuses a claim that cannot mean what it says, rather than passing it', () => {
      // The guard on the pins above. `orderMismatch` judges an empty claim in
      // order vacuously and a repeated name collapses in the filter, so either
      // one turns a pin that reads as asserting an order into one that asserts
      // nothing — the same silent-pass this file exists to close, arriving
      // through the claim instead of through the service.
      //
      // `LockStageName` already refuses a misspelt or empty claim written in
      // this repo. These are the runtime half, which is what catches a list
      // built from data and what makes the reason readable when it fires.
      expect(() => stagesNamed([])).toThrow(/asserts nothing/);
      expect(() => stagesNamed(['grant row', 'grant row'])).toThrow(/more than once/);
      expect(() => stagesNamed(['grant row', 'plugin roe'])).toThrow(/is not a stage of the claimed lock order/);
    });

    it('does not let a share lock on another table stand in for the plugin row', () => {
      // Order is judged by first occurrence, so a stage pattern that matches
      // something it did not mean does not merely over-match — it DATES the
      // stage to the wrong statement, and a plugin row genuinely taken later
      // reports as taken early. The two stages that lock by raw SQL below
      // scope themselves to their table; this is the one that has to be held
      // to the same rule, and nothing in a pinned body reaches its SQL
      // alternative today, which is precisely when looseness goes unnoticed.
      const pluginRow = stageNamed('plugin row');

      expect('SELECT id FROM households WHERE id = $1 FOR SHARE').not.toMatch(pluginRow.pattern);
      expect('SELECT uninstalled_at FROM plugins WHERE id = $1 FOR SHARE').toMatch(pluginRow.pattern);
    });

    it('recognises every stage of the claimed order in some shipped body', () => {
      // Catches the quiet failure of this whole file: a stage whose pattern
      // stopped matching anything. Comparing the two hand-written lists in
      // `lock-order.ts` against each other would not — a renamed helper leaves
      // the stage listed under four paths and recognised in none.
      const bodies = LOCK_ORDER_PATHS.map(
        (path) =>
          (path.branch === undefined
            ? readShippedFunction(path.file, path.functionName)
            : readShippedBranch(path.file, path.functionName, path.branch)
          ).body,
      );
      const unrecognised = CLAIMED_LOCK_ORDER.filter((stage) => !bodies.some((body) => stage.pattern.test(body)));

      expect(unrecognised.map((stage) => stage.name)).toEqual([]);
    });
  });

  describe('what that order does — replayed against Postgres', () => {
    it('queues a unit transaction and an activation at the plugin row, their first shared lock', async () => {
      const plugin = await arrangeContendedPlugin();

      await withBarrier(async (barrier) => {
        const { holder, waiter } = barrier;

        // A unit transaction, in full: plugin row, key, unit row.
        await holder.begin();
        await holder.query(pluginShareLock.text, [plugin.pluginId]);
        await holder.query(advisoryLock.text, [plugin.advisoryKey]);
        await holder.query(unitRowLock.text, [plugin.householdId, plugin.pluginId]);

        // An activation arrives. Its first stage is the same first stage, so it
        // waits there rather than deeper in, holding nothing the unit
        // transaction is about to want.
        await waiter.begin();
        const claim = waiter.issue(ACTIVATION_VERSION_BUMP, [plugin.pluginId, '2.0.0'], 'the activation claim');

        await expectBlocked(barrier, claim);

        await holder.commit();

        await expect(claim.result()).resolves.toHaveLength(1);

        // And having waited, it proceeds through the rest of the order.
        await waiter.query(grantRowLock.text, [plugin.pluginId]);
        await waiter.commit();
      });
    });

    it('queues a decision behind an activation that got to the grant row first', async () => {
      // decide()-vs-activation, order one. The two paths never share a first
      // lock — a decision does not touch the plugin row at all — so the grant
      // row is where they meet, which is the whole reason #356 put a lock there.
      const plugin = await arrangeContendedPlugin();

      await withBarrier(async (barrier) => {
        const { holder, waiter } = barrier;

        await holder.begin();
        await holder.query(ACTIVATION_VERSION_BUMP, [plugin.pluginId, '2.0.0']);
        await holder.query(grantRowLock.text, [plugin.pluginId]);

        await waiter.begin();
        const decision = waiter.issue(
          GRANT_DECISION_CLAIM,
          [plugin.grantId, PluginGrantStatus.Denied],
          'a decision flipping the grant it locked',
        );

        await expectBlocked(barrier, decision);

        await holder.commit();

        await expect(decision.result()).resolves.toHaveLength(1);
        await waiter.commit();
      });
    });

    it('queues an activation behind a decision that got to the grant row first', async () => {
      // Order two, and not a mirror image for free: `FOR UPDATE` and the
      // decision's non-key UPDATE have to conflict in BOTH directions for the
      // pair to serialize, and only one of those directions is the one #356's
      // comment reasons about.
      const plugin = await arrangeContendedPlugin();

      await withBarrier(async (barrier) => {
        const { holder, waiter } = barrier;

        await holder.begin();
        await holder.query(GRANT_DECISION_CLAIM, [plugin.grantId, PluginGrantStatus.Denied]);

        await waiter.begin();
        await waiter.query(ACTIVATION_VERSION_BUMP, [plugin.pluginId, '2.0.0']);
        const activation = waiter.issue(grantRowLock.text, [plugin.pluginId], "the activation's server-grant lock");

        await expectBlocked(barrier, activation);

        await holder.commit();

        // EvalPlanQual: the activation's re-read returns the row as the
        // decision left it, not as its own snapshot saw it. That is the
        // property #356's refusal depends on — it must SEE the denial to
        // refuse over it.
        const rows = await activation.result();

        expect(rows).toContainEqual(expect.objectContaining({ status: PluginGrantStatus.Denied }));

        await waiter.commit();
      });
    });

    it('deadlocks when one writer takes the advisory key before the plugin row', async () => {
      // The cycle that reached review on #323's branch, reproduced. The unit
      // transaction here takes the key FIRST — the order that branch originally
      // shipped — while an activation takes the plugin row first. Neither can
      // finish.
      //
      // This is the case that gives the consistent-order claim content. Without
      // it, "the merged order queues" is indistinguishable from "these two
      // statements happen not to conflict".
      const plugin = await arrangeContendedPlugin();

      await withBarrier(async (barrier) => {
        const { holder, waiter } = barrier;

        await holder.begin();
        await holder.query(advisoryLock.text, [plugin.advisoryKey]);

        await waiter.begin();
        await waiter.query(ACTIVATION_VERSION_BUMP, [plugin.pluginId, '2.0.0']);

        // Half the cycle: the inverted unit transaction now wants the plugin
        // row the activation is holding.
        const inverted = holder.issue(pluginShareLock.text, [plugin.pluginId], 'the key-first unit transaction');

        await expectBlocked(barrier, inverted);

        // Closing it. Deliberately NOT asserted as blocked: from here Postgres
        // aborts a victim it chooses, and an assertion that both are waiting
        // races that abort (#330, and the same omission as the quota deadlock
        // case).
        const activation = waiter.issue(advisoryLock.text, [plugin.advisoryKey], 'the activation wanting the key');
        const outcomes = await Promise.allSettled([inverted.result(), activation.result()]);
        const victims = outcomes.filter(
          (outcome) => outcome.status === 'rejected' && (outcome.reason as { code?: string }).code === '40P01',
        );

        // Exactly one, and never which one: the victim is Postgres's choice.
        expect(victims).toHaveLength(1);
        expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      });
    });

    it('does not deadlock when both writers take the plugin row first, same contention', async () => {
      // The control that makes the case above about the ORDER rather than about
      // these two statements. Identical fixtures, identical locks, identical
      // interleaving — only the unit transaction's first two stages are
      // swapped back into the claimed order, and the cycle disappears.
      const plugin = await arrangeContendedPlugin();

      await withBarrier(async (barrier) => {
        const { holder, waiter } = barrier;

        await holder.begin();
        await holder.query(pluginShareLock.text, [plugin.pluginId]);
        await holder.query(advisoryLock.text, [plugin.advisoryKey]);

        await waiter.begin();
        const claim = waiter.issue(ACTIVATION_VERSION_BUMP, [plugin.pluginId, '2.0.0'], 'the activation claim');

        await expectBlocked(barrier, claim);

        const key = holder.issue(advisoryLock.text, [plugin.advisoryKey], 're-taking the key it already holds');

        // Re-entrant, so the holder never joins the wait: the only backend
        // waiting is the activation, and it is waiting on a transaction that
        // can still finish.
        await expect(key.result()).resolves.toHaveLength(1);

        await holder.commit();
        await expect(claim.result()).resolves.toHaveLength(1);
        await waiter.commit();
      });
    });
  });

  describe('the pins and the replay are about the same locks', () => {
    it('replays one statement per stage, and no statement answers for two', () => {
      // The lifts above already refuse a moved statement, so this case is about
      // something they cannot see: whether what was lifted is what the stage
      // NAMES claim. A statement lifted from the wrong file blocks just as
      // convincingly, and three of these four files ship a `pg_advisory_xact_lock`
      // or a `FOR UPDATE` of their own.
      //
      // Asserting EXACTLY one match rather than at-least-one is what keeps this
      // from restating the `matching:` option the lift already enforced: a stage
      // pattern that grew loose enough to claim a neighbour's statement fails
      // here even though every lift still succeeds.
      const replayed: ReadonlyArray<readonly [LockStageName, string]> = [
        ['plugin row', pluginShareLock.text],
        ['grant row', grantRowLock.text],
        ['advisory key', advisoryLock.text],
        ['unit row', unitRowLock.text],
      ];

      for (const [name, text] of replayed) {
        const matched = CLAIMED_LOCK_ORDER.filter((stage) => stage.pattern.test(text));

        expect(matched.map((stage) => stage.name)).toEqual([name]);
      }

      // And every stage is replayed, so the four above cannot quietly become three.
      expect(replayed.map(([name]) => name)).toEqual(stagesNamed(replayed.map(([name]) => name)).map((s) => s.name));
      expect(replayed).toHaveLength(CLAIMED_LOCK_ORDER.length);
    });
  });
});
