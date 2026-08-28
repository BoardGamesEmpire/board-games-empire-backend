import { PluginGrantStatus } from '@bge/database';
import { randomUUID } from 'node:crypto';
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
  SERVER_GRANT_INSERT,
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

  /**
   * Stage 1: the plugin row, as the unit paths take it. Binds the expected
   * manifest ahead of the id — the content comparison #368 added sits in the
   * SELECT list — and every replay here binds NULL for it, the calling mode of
   * the paths that derive nothing from a manifest. What this file pins is the
   * ORDER stages are taken in, which no predicate of theirs changes.
   */
  const pluginShareLock = readShippedSql(UNIT_LIFECYCLE, ['expectedManifest', 'plugin.id'], {
    matching: /FOR SHARE/,
  });
  const NO_SNAPSHOT = null;

  /**
   * Stage 2: the server grant rows, as activation takes them (#356).
   * Anchored on the declaration — D-CN (#370) added a second `FOR UPDATE`
   * statement to this file (the plugin-config lock), so a bare
   * `/FOR UPDATE/` no longer resolves to one statement without help.
   */
  const grantRowLock = readShippedSql(UPDATE_SERVICE, ['plugin.id'], {
    after: 'lockedGrantRows',
    matching: /FOR UPDATE/,
  });

  /** Stage 3: the `(scopeId, pluginId)` key, and the format it is built from. */
  const advisoryLock = readShippedSql(UNIT_SCOPE_LOCK, ['scopeKey'], {
    after: 'lockHouseholdUnitScope',
    matching: /pg_advisory_xact_lock/,
  });
  const advisoryKeyFormat = readShippedValue(UNIT_SCOPE_LOCK, ['householdId', 'pluginId'], {
    after: 'lockHouseholdUnitScope',
  });

  /**
   * Stage 1, as `decide()` now takes it (#398). Lifted from the grant service
   * rather than reusing `pluginShareLock` above: the two statements are the same
   * MODE on the same row but not the same text — the unit path's carries #368's
   * manifest comparison and this one reads `id` and nothing else — and a barrier
   * case that replayed the wrong file's statement would report a lock the
   * decision path does not actually take.
   */
  const decisionPluginClaim = readShippedSql(GRANT_SERVICE, ['plugin.id'], {
    after: 'const attempt = async ()',
    matching: /FOR SHARE/,
  });

  /**
   * Activation's own plugin-row claim (D-CN, #370) — the explicit `FOR UPDATE`
   * over `Plugin.config`, lifted rather than stood in for.
   *
   * `ACTIVATION_VERSION_BUMP` cannot serve the #398 cases: it writes non-key
   * columns only, so it takes `FOR NO KEY UPDATE`, and that mode does NOT
   * conflict with the `FOR KEY SHARE` an FK takes. The cycle those cases are
   * about needs the mode activation really holds.
   */
  const activationPluginClaim = readShippedSql(UPDATE_SERVICE, ['plugin.id'], {
    after: 'const [current] = await tx.$queryRaw',
    matching: /FOR UPDATE/,
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

    it('holds every table-scoped stage to the whole table name, not to something that starts with it', () => {
      // The same failure one character further out, and the reason the fix
      // above is not finished by scoping alone: `FROM plugins` with nothing
      // after it is a PREFIX match, so a `plugins_archive` added later would
      // date the plugin-row stage without being the plugin row.
      //
      // The other two forms are why the boundary is a lookahead rather than
      // `\b`: a word boundary ends the name at any non-word character, but `$`
      // is a legal Postgres identifier character and a trailing `.` makes the
      // name a SCHEMA — `FROM plugins.audit` locks some other table entirely,
      // and would have dated this stage while doing it.
      //
      // `relationLock` states that rule once and `shipped-function.spec.ts`
      // tests it directly, so this case is not the rule's test — it is the
      // wiring's. Each stage is asserted separately because what it denies is
      // a stage that stopped going through the builder, which no test of the
      // builder can see. Nothing in the schema collides today, which is why
      // this is cheap now and would be a puzzle later.
      const cases = [
        { stage: 'plugin row', suffix: 'FOR SHARE', table: 'plugins' },
        // D-CN (#370): the plugin row is now also recognised by a raw
        // `FOR UPDATE`, since activation's config lock takes it that way.
        { stage: 'plugin row', suffix: 'FOR UPDATE', table: 'plugins' },
        { stage: 'grant row', suffix: 'FOR UPDATE', table: 'plugin_grants' },
        { stage: 'unit row', suffix: 'FOR UPDATE', table: 'household_plugins' },
      ] as const;

      for (const { stage, suffix, table } of cases) {
        const { pattern } = stageNamed(stage);

        expect(`SELECT id FROM ${table} WHERE id = $1 ${suffix}`).toMatch(pattern);
        expect(`SELECT id FROM ${table}_archive WHERE id = $1 ${suffix}`).not.toMatch(pattern);
        expect(`SELECT id FROM ${table}.audit WHERE id = $1 ${suffix}`).not.toMatch(pattern);
        expect(`SELECT id FROM ${table}$archive WHERE id = $1 ${suffix}`).not.toMatch(pattern);
      }
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
        await holder.query(pluginShareLock.text, [NO_SNAPSHOT, plugin.pluginId]);
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
        const inverted = holder.issue(
          pluginShareLock.text,
          [NO_SNAPSHOT, plugin.pluginId],
          'the key-first unit transaction',
        );

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

    /**
     * The cycle #398 reported, and the reason the two source pins below could
     * both be green while it existed.
     *
     * `decide()`'s upsert takes a plugin-row lock nobody wrote: `plugin_grants`
     * has an FK to `plugins`, referential-integrity checks are AFTER ROW
     * triggers, and the mode is `FOR KEY SHARE` — which conflicts with the
     * `FOR UPDATE` activation is holding. Because the trigger fires after the
     * row is written, the decision ends up holding the grant tuple while it
     * waits for the plugin row, and activation's own seeding INSERT of the same
     * key then waits on that tuple. Neither can finish.
     *
     * The INSERT arm specifically: a decision on a slug that already has a row
     * takes the UPDATE arm and collides on the row lock instead, which queues.
     */
    it('deadlocks when a decision writes its grant row before claiming the plugin row (#398)', async () => {
      const plugin = await arrangeContendedPlugin();
      const undecidedSlug = `probe:${randomUUID()}`;

      await withBarrier(async (barrier) => {
        const { holder, waiter } = barrier;

        await holder.begin();
        await holder.query(activationPluginClaim.text, [plugin.pluginId]);

        await waiter.begin();

        // Half the cycle: the tuple is written, then the FK trigger asks for the
        // plugin row activation is holding.
        const decision = waiter.issue(
          SERVER_GRANT_INSERT,
          [randomUUID(), plugin.pluginId, undecidedSlug],
          "the decision's grant INSERT",
        );

        await expectBlocked(barrier, decision);

        // Closing it. Deliberately NOT asserted as blocked: from here Postgres
        // aborts a victim it chooses, and an assertion that both are waiting
        // races that abort (#330).
        const seeding = holder.issue(
          SERVER_GRANT_INSERT,
          [randomUUID(), plugin.pluginId, undecidedSlug],
          "activation's seeding INSERT",
        );
        const outcomes = await Promise.allSettled([decision.result(), seeding.result()]);
        const victims = outcomes.filter(
          (outcome) => outcome.status === 'rejected' && (outcome.reason as { code?: string }).code === '40P01',
        );

        // Exactly one, and never which one: the victim is Postgres's choice.
        expect(victims).toHaveLength(1);
        expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      });
    });

    /**
     * The control that makes the case above about the ORDER rather than about
     * these two statements. Identical fixtures, identical INSERTs, identical
     * interleaving — the decision simply claims the plugin row before writing
     * anything, which is what the fix ships.
     *
     * The loser still loses; what changes is HOW. It waits before it has written
     * anything, so nothing can be waiting on it, and when activation commits it
     * finds a committed row and raises a unique violation — the failure
     * activation's bounded retry already exists to answer.
     */
    it('does not deadlock when the decision claims the plugin row first, same contention (#398)', async () => {
      const plugin = await arrangeContendedPlugin();
      const undecidedSlug = `probe:${randomUUID()}`;

      await withBarrier(async (barrier) => {
        const { holder, waiter } = barrier;

        await holder.begin();
        await holder.query(activationPluginClaim.text, [plugin.pluginId]);

        await waiter.begin();

        const claim = waiter.issue(decisionPluginClaim.text, [plugin.pluginId], "the decision's plugin-row claim");

        await expectBlocked(barrier, claim);

        // Free, and that is the whole difference: the decision holds no grant
        // tuple for this to wait on.
        await holder.query(SERVER_GRANT_INSERT, [randomUUID(), plugin.pluginId, undecidedSlug]);
        await holder.commit();
        await claim.result();

        const collision = await waiter
          .query(SERVER_GRANT_INSERT, [randomUUID(), plugin.pluginId, undecidedSlug])
          .then(() => undefined)
          .catch((error: unknown) => error);

        // unique_violation, not deadlock_detected: P2002, which the activation
        // service retries and `decide()`'s upsert resolves in place.
        expect((collision as { code?: string } | undefined)?.code).toBe('23505');
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
        await holder.query(pluginShareLock.text, [NO_SNAPSHOT, plugin.pluginId]);
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
