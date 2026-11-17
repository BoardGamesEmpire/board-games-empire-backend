import { randomUUID } from 'node:crypto';
import { expectBlocked, withBarrier } from '../support/lock-barrier';
import { childRelationsOf } from '../support/schema-relations';
import {
  claimsIncludingDelegates,
  orderMismatch,
  readShippedBranch,
  readShippedFunction,
} from '../support/shipped-function';
import { bindTemplate, readShippedSource, readShippedSql, readShippedValue } from '../support/shipped-sql';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import {
  ACTIVATION_VERSION_BUMP,
  arrangeHouseholdFor,
  arrangeHouseholdUnit,
  arrangePlugin,
  arrangeServerGrant,
  GRANT_ROW_LOCK,
  SERVER_GRANT_INSERT,
  UNIT_ROW_LOCK,
} from './lock-fixtures';
import {
  CLAIMED_LOCK_ORDER,
  FK_CHILD_PARENT,
  FK_CHILD_TABLES,
  fkChildWriteAudit,
  fkChildWriteShapes,
  fkChildWritesOutsideScope,
  LOCK_ORDER_PATHS,
  LOCK_SOURCES,
  PLUGIN_ROW_CLAIM_EXEMPTIONS,
  pluginDataGatewayRowPlacements,
  stageNamed,
  stagesNamed,
  type LockStageName,
} from './lock-order';

/**
 * The claimed total order — `plugin row -> advisory key -> grant row -> unit
 * row`, with the household row ahead of it since #548 and the key ahead of the
 * grant rows since #1150 — proven the only two ways it can be (#360).
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
 * Why this is not a race over HTTP. Firing a consent act and an approval at
 * each other would exercise the real code, but a deadlock is probabilistic: a green
 * run proves nothing, and making contention reliable enough to prove something
 * is the shape #330 tracks. So the two application transactions are replayed as
 * the statements they ship — every stage below is lifted from source except the
 * grant row and the unit enablement, which no shipped statement locks by raw
 * SQL (#1336, #1149), and only the sequencing is this spec's — and the
 * sequencing itself is pinned back against the shipped text.
 */
describe('the plugin consent path is one lock order (#360)', () => {
  const { unitLifecycle: UNIT_LIFECYCLE, unitScopeLock: UNIT_SCOPE_LOCK } = LOCK_SOURCES;
  const { serverConsentActService: SERVER_CONSENT_ACT_SERVICE, updateService: UPDATE_SERVICE } = LOCK_SOURCES;

  /**
   * Stage 0: the household row, as a household-scope write takes it (#548).
   * Lifted from `@bge/database`, where the statement lives (#552); the plugin
   * paths reach it by calling the helper.
   */
  const householdShareLock = readShippedSql(LOCK_SOURCES.householdShareLock, ['householdId'], {
    after: 'lockLiveHousehold',
    matching: /FOR SHARE/,
  });

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

  /** Stage 2: the `(scopeId, pluginId)` key, and the format it is built from. */
  const advisoryLock = readShippedSql(UNIT_SCOPE_LOCK, ['scopeKey'], {
    after: 'lockHouseholdUnitScope',
    matching: /pg_advisory_xact_lock/,
  });
  const advisoryKeyFormat = readShippedValue(UNIT_SCOPE_LOCK, ['householdId', 'pluginId'], {
    after: 'lockHouseholdUnitScope',
  });

  /**
   * Stage 3: the server grant rows, as an approval takes them. Replayed from a
   * fixture rather than lifted: activation writes the Server unit's decisions
   * through `pluginGrant.upsert` and takes no raw lock on the grants table
   * (#1336). `GRANT_ROW_LOCK` says why it may stand in for the upserts.
   */
  const grantRowLock = { text: GRANT_ROW_LOCK };

  /**
   * Stage 1, as the server consent act takes it before it writes the Server
   * unit's consent decisions (#398, #1336). Lifted from that service rather
   * than reusing `pluginShareLock` above: the two statements are the same MODE
   * on the same row but not the same text — they select different columns, and
   * the act compares the sha in code, not in the statement — and a barrier case
   * that replayed the wrong file's statement would report a lock the act does
   * not actually take.
   */
  const serverActPluginClaim = readShippedSql(SERVER_CONSENT_ACT_SERVICE, ['pluginId'], {
    after: 'private async claimPluginForAct',
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

  /**
   * Stage 4: the unit enablement (the `unit row` stage). The one stage replayed from a fixture rather than
   * lifted: since #1149 no shipped statement locks the unit enablement by raw SQL,
   * and the unit writers take it through Prisma writes. `UNIT_ROW_LOCK` says
   * why it may stand in for them.
   */
  const unitRowLock = { text: UNIT_ROW_LOCK };

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
    await arrangeServerGrant(db.client, plugin.pluginId);
    await arrangeHouseholdUnit(db.client, householdId, plugin.pluginId);

    return {
      ...plugin,
      householdId,
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
        { stage: 'household row', suffix: 'FOR SHARE', table: 'households' },
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

  /**
   * The stages above are matched from source, and Postgres takes locks no
   * source mentions. The server's first decision writer is the proof: it
   * claimed the two stages it wrote, took a third through the `plugin_grants`
   * FK, and deadlocked against activation while every pin here stayed green
   * (#398).
   *
   * This is the general form of that fix (#399) — not a fifth stage, but the
   * requirement stated directly. A write to any table carrying an FK to
   * `plugins` must be preceded, on every path that reaches it, by a plugin-row
   * claim. Where it is not, an exemption has to say why that is safe.
   */
  describe('the locks nobody wrote — FK-implied parent locks (#399)', () => {
    const {
      installerService: INSTALLER_SERVICE,
      consentActService: CONSENT_ACT_SERVICE,
      pluginDataGatewayRow: DATA_GATEWAY_ROW,
    } = LOCK_SOURCES;
    const { dataGatewayService: DATA_GATEWAY_SERVICE, gatewayInterviewService: GATEWAY_INTERVIEW_SERVICE } =
      LOCK_SOURCES;

    /**
     * Every FK-child write in the scanned scope, and what the audit says about
     * it. Written out rather than counted, because a count is satisfied by the
     * wrong seven.
     */
    const KNOWN_FK_CHILD_WRITES = [
      // The consent act writes the decisions and the unit enablement under its
      // own claim, `claimPluginForAct` (#1150).
      { file: CONSENT_ACT_SERVICE, enclosing: 'commit', write: 'pluginGrant.upsert', claimed: true },
      { file: CONSENT_ACT_SERVICE, enclosing: 'commit', write: 'householdPlugin.create', claimed: true },
      { file: CONSENT_ACT_SERVICE, enclosing: 'commit', write: 'userPlugin.upsert', claimed: true },
      // The server act writes the Server unit's decisions under its own
      // `claimPluginForAct` the same way (#1336).
      { file: SERVER_CONSENT_ACT_SERVICE, enclosing: 'commit', write: 'pluginGrant.upsert', claimed: true },
      // The one write that sets `data_gateways.plugin_id` (#1083). Unclaimed
      // where the audit reads it and exempt on the strength of its caller,
      // which the placement case below pins.
      { file: DATA_GATEWAY_ROW, enclosing: 'placePluginDataGatewayRow', write: 'dataGateway.create', claimed: false },
      { file: INSTALLER_SERVICE, enclosing: 'persist', write: 'pluginPermission.create', claimed: false },
      { file: INSTALLER_SERVICE, enclosing: 'persist', write: 'pluginGrant.create', claimed: false },
      { file: UPDATE_SERVICE, enclosing: 'activateInTransaction', write: 'pluginPermission.create', claimed: true },
      { file: UPDATE_SERVICE, enclosing: 'activateInTransaction', write: 'pluginGrant.upsert', claimed: true },
      // The FK-child writes outside the plugin runtime (#1083). Most
      // `data_gateways` rows belong to no plugin, and the DataGateway routes
      // and the interview write them in their own libraries. None of the three
      // can set the key, so none takes the implied lock and none is claimed:
      // each carries an exemption saying why it needs no claim. The update and
      // the interview's write are reported for the reason the two updates above
      // are, an unreadable `data`, and the create because every insert is.
      { file: DATA_GATEWAY_SERVICE, enclosing: 'create', write: 'dataGateway.create', claimed: false },
      { file: DATA_GATEWAY_SERVICE, enclosing: 'update', write: 'dataGateway.update', claimed: false },
      { file: GATEWAY_INTERVIEW_SERVICE, enclosing: 'storeOver', write: 'dataGateway.updateMany', claimed: false },
    ];

    it('reads the FK-child tables out of the schema rather than trusting the list here', () => {
      // Both halves are load-bearing. Deriving alone can find nothing — a
      // relation syntax this reader stops recognising returns an empty set, and
      // an empty set has no violations in it. The literal alone goes stale on
      // the next child table, which is the event the whole check exists for.
      expect(
        childRelationsOf(FK_CHILD_PARENT)
          .map((child) => child.table)
          .sort(),
      ).toEqual([...FK_CHILD_TABLES]);
    });

    it('finds every FK-child write in the scanned scope, not only the ones pinned above', () => {
      // The self-test on the scan. A source scan that quietly matches nothing
      // reports a clean tree, so what is asserted is the enumeration itself —
      // and it deliberately reaches `plugin-installer.service.ts`, which writes
      // two of these tables and has no entry in LOCK_ORDER_PATHS at all, and
      // the two libraries outside the plugin runtime that write
      // `data_gateways` (#1083).
      expect(
        fkChildWriteAudit().map((site) => ({
          file: site.file,
          enclosing: site.enclosing,
          write: /(\w+\.\w+)\(/.exec(site.text)?.[1],
          claimed: site.claimed,
        })),
      ).toEqual(KNOWN_FK_CHILD_WRITES);
    });

    it('recognises every write shape against a sample, so a dead pattern cannot read as a clean tree', () => {
      // The enumeration above pins what the tree HAS. It cannot tell a shape
      // that correctly matches nothing from one that stopped matching — and one
      // shape genuinely matches nothing today: the tree ships no raw child
      // write at all, of either kind. So each shape is exercised against a
      // sample of what it claims to recognise, which is the same guard
      // `recognises every stage of the claimed order in some shipped body` puts
      // on the stages.
      const children = childRelationsOf(FK_CHILD_PARENT);
      const samples = [
        ...children.flatMap((child) => [`tx.${child.accessor}.create`, `tx.${child.accessor}.updateMany`]),
        ...children.map((child) => `INSERT INTO ${child.table} (id) VALUES ($1)`),
        ...children.map((child) => `UPDATE ${child.table} SET ${child.column} = $1 WHERE id = $2`),
        'tx.plugin.update',
      ];
      // The guards are exercised too. Three shapes carry one and the nested
      // shape rests on it entirely, so a `withArguments` that stopped matching
      // would skip every write it guards — the same clean-tree failure, one
      // field along from the one this case was written for.
      const payloads = [
        ...children.map((child) => `{ ${child.foreignKey}: next }`),
        '{ grants: { create: [{ pluginId }] } }',
        '{ permissions: { createMany: { data } } }',
        '{ grants: { connectOrCreate: { where, create } } }',
      ];
      const shapes = fkChildWriteShapes(children);
      const unrecognised = shapes.filter(
        (shape) =>
          !samples.some((sample) => shape.pattern.test(sample)) ||
          (shape.withArguments !== undefined && !payloads.some((payload) => shape.withArguments?.test(payload))),
      );

      expect(unrecognised.map((shape) => String(shape.pattern))).toEqual([]);
    });

    it('writes these tables nowhere outside the scanned scope', () => {
      // The audit reads a short list of directories, which is the same
      // hand-scoping the derived table list exists to refuse — one level
      // further out. A child write added in another library, in the app, or in
      // a scanned library above `src/lib` takes the same implied lock,
      // deadlocks the same way, and every case above stays green. So the scope
      // is not asserted to be the right one; it is asserted to be ALL of them.
      //
      // Two of the directories are there for `data_gateways`, which the
      // DataGateway routes and the interview write (#1083). They are scanned,
      // not excused from this case, so their sites are enumerated above like
      // every other.
      //
      // The candidates are judged by the audit's own shapes rather than by a
      // grep pattern written here; `fkChildWritesOutsideScope` says why.
      expect(fkChildWritesOutsideScope()).toEqual([]);
    });

    it('leaves no FK-child write both unclaimed and unexplained', () => {
      // The check itself. Everything above is the guard on it.
      const unexplained = fkChildWriteAudit()
        .filter((site) => !site.claimed && site.exemption === undefined)
        .map(
          (site) =>
            `${site.file}:${site.line} (${site.enclosing}) ${site.text} — writes an FK child without claiming the ` +
            `plugin row first, so the FK's own FOR KEY SHARE lands AFTER the child tuple and this path holds the ` +
            `plugin row LAST. Against activation's FOR UPDATE that is a cycle, not a queue (#398).`,
        );

      expect(unexplained).toEqual([]);
    });

    it('holds every exemption to naming a site that would otherwise fail', () => {
      // An exemption is a claim too. One whose site started passing on its own
      // is not harmless — it is a comment asserting a danger that no longer
      // exists, sitting beside the mechanism that would have reported it, and
      // the next reader takes it for a live hazard.
      const stale = PLUGIN_ROW_CLAIM_EXEMPTIONS.filter(
        (exemption) => !fkChildWriteAudit().some((site) => site.exemption === exemption && !site.claimed),
      );

      expect(stale.map((exemption) => `${exemption.file} ${exemption.enclosing} ${String(exemption.site)}`)).toEqual(
        [],
      );
    });

    it('recognises the plugin-row claim through the delegates the unit paths use', () => {
      // `updateHouseholdConfig` holds the plugin row and nothing in its own
      // text says so — the lock is two calls away, in `assertStillLiving`.
      // Asserted here because it is the difference between this check being
      // usable and it reporting a compliant unit path as a violation. Its
      // write names every key it sets and no foreign key, so the audit reports
      // no site there (#1151); the claim the audit would credit it with is
      // asserted against the delegates the audit resolves instead.
      const pluginRow = stageNamed('plugin row').pattern;
      const configWrite = readShippedFunction(UNIT_LIFECYCLE, 'updateHouseholdConfig').body;

      expect(configWrite).not.toMatch(pluginRow);
      expect(configWrite).toMatch(
        claimsIncludingDelegates(readShippedSource(UNIT_LIFECYCLE), UNIT_LIFECYCLE, pluginRow),
      );
    });

    it('places a plugin DataGateway’s row only where the plugin row is already held, from persist() and from activation, as its exemption claims (#1083)', () => {
      // The one exemption whose reason is not in the function it names.
      // `placePluginDataGatewayRow` holds the only write that sets
      // `data_gateways.plugin_id`, so it does take the implied lock, and it
      // claims nothing itself. What makes it safe is its caller, a file away,
      // where the audit's delegate resolution deliberately stops. So the caller
      // is pinned here: every call in the shipped tree, and whether the plugin
      // row is claimed or created on every path that reaches it.
      //
      // Two calls. One in `persist()`, below the `if/else` that creates the
      // plugin row on a fresh install and claims it on a reinstall. One in
      // `activateInTransaction()`, for an update that makes the plugin a
      // data-gateway plugin, below the `FOR UPDATE` on the plugin row. A third
      // caller, or either of these moved above its claim or onto a path that
      // skips it, would lock a plugin row another transaction may already
      // hold, and lock it AFTER writing the plugin's DataGateway row — the
      // #398 shape — while the exemption went on saying otherwise.
      expect(
        pluginDataGatewayRowPlacements().map(({ file, enclosing, claimed }) => ({ file, enclosing, claimed })),
      ).toEqual([
        { file: INSTALLER_SERVICE, enclosing: 'persist', claimed: true },
        { file: UPDATE_SERVICE, enclosing: 'activateInTransaction', claimed: true },
      ]);
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

    it('queues a server consent act behind an activation that got to the grant row first', async () => {
      // A server consent act against an activation. The replay leaves out the
      // act's plugin-row claim (#398) and starts at its grant-row write, so the
      // grant row is where they meet: an approval holding a server-scope
      // decision it re-wrote holds that row to the end of its transaction
      // (#1336), and an act's upsert of the same row waits for it.
      const plugin = await arrangeContendedPlugin();

      await withBarrier(async (barrier) => {
        const { holder, waiter } = barrier;

        await holder.begin();
        await holder.query(ACTIVATION_VERSION_BUMP, [plugin.pluginId, '2.0.0']);
        await holder.query(grantRowLock.text, [plugin.pluginId]);

        await waiter.begin();
        const decision = waiter.issue(
          grantRowLock.text,
          [plugin.pluginId],
          "the server consent act's upsert of the decision activation holds",
        );

        await expectBlocked(barrier, decision);

        await holder.commit();

        await expect(decision.result()).resolves.toHaveLength(1);
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
     * A consent decision's upsert takes a plugin-row lock nobody wrote:
     * `plugin_grants` has an FK to `plugins`, referential-integrity checks are
     * AFTER ROW triggers, and the mode is `FOR KEY SHARE` — which conflicts
     * with the `FOR UPDATE` activation is holding. Because the trigger fires
     * after the row is written, a writer that has not claimed the plugin row
     * ends up holding the grant tuple while it waits for the plugin row, and
     * activation's own INSERT of the same key (the insert arm of an approval's
     * upsert) then waits on that tuple. Neither can finish.
     *
     * The INSERT arm specifically: a decision on a slug that already has a row
     * takes the UPDATE arm and collides on the row lock instead, which queues.
     */
    it('deadlocks when a server consent act writes its grant row before claiming the plugin row (#398, #1336)', async () => {
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
          "the act's grant INSERT",
        );

        await expectBlocked(barrier, decision);

        // Closing it. Deliberately NOT asserted as blocked: from here Postgres
        // aborts a victim it chooses, and an assertion that both are waiting
        // races that abort (#330).
        const approvalWrite = holder.issue(
          SERVER_GRANT_INSERT,
          [randomUUID(), plugin.pluginId, undecidedSlug],
          "activation's grant INSERT",
        );
        const outcomes = await Promise.allSettled([decision.result(), approvalWrite.result()]);
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
     * interleaving — the writer simply claims the plugin row before writing
     * anything, as the server consent act's `claimPluginForAct` does.
     *
     * The loser still loses; what changes is HOW. It waits before it has written
     * anything, so nothing can be waiting on it, and when activation commits it
     * finds a committed row: the raw INSERT raises a unique violation, where
     * the upsert it stands for takes its update arm.
     */
    it('does not deadlock when the server consent act claims the plugin row first, same contention (#398, #1336)', async () => {
      const plugin = await arrangeContendedPlugin();
      const undecidedSlug = `probe:${randomUUID()}`;

      await withBarrier(async (barrier) => {
        const { holder, waiter } = barrier;

        await holder.begin();
        await holder.query(activationPluginClaim.text, [plugin.pluginId]);

        await waiter.begin();

        const claim = waiter.issue(serverActPluginClaim.text, [plugin.pluginId], "the server act's plugin-row claim");

        await expectBlocked(barrier, claim);

        // Free, and that is the whole difference: the act holds no grant
        // tuple for this to wait on.
        await holder.query(SERVER_GRANT_INSERT, [randomUUID(), plugin.pluginId, undecidedSlug]);
        await holder.commit();
        await claim.result();

        const collision = await waiter
          .query(SERVER_GRANT_INSERT, [randomUUID(), plugin.pluginId, undecidedSlug])
          .then(() => undefined)
          .catch((error: unknown) => error);

        // unique_violation, not deadlock_detected: the conflict the act's
        // upsert resolves in place.
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
      // convincingly, and three of these five files ship a `pg_advisory_xact_lock`
      // or a `FOR UPDATE` of their own.
      //
      // Asserting EXACTLY one match rather than at-least-one is what keeps this
      // from restating the `matching:` option the lift already enforced: a stage
      // pattern that grew loose enough to claim a neighbour's statement fails
      // here even though every lift still succeeds.
      const replayed: ReadonlyArray<readonly [LockStageName, string]> = [
        ['household row', householdShareLock.text],
        ['plugin row', pluginShareLock.text],
        ['advisory key', advisoryLock.text],
        ['grant row', grantRowLock.text],
        ['unit row', unitRowLock.text],
      ];

      for (const [name, text] of replayed) {
        const matched = CLAIMED_LOCK_ORDER.filter((stage) => stage.pattern.test(text));

        expect(matched.map((stage) => stage.name)).toEqual([name]);
      }

      // And every stage is replayed, so the five above cannot quietly become four.
      expect(replayed.map(([name]) => name)).toEqual(stagesNamed(replayed.map(([name]) => name)).map((s) => s.name));
      expect(replayed).toHaveLength(CLAIMED_LOCK_ORDER.length);
    });
  });
});
