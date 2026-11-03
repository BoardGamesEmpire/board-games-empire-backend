import { randomUUID } from 'node:crypto';

import { expectBlocked, expectNotBlocked, withBarrier } from '../support/lock-barrier';
import { readShippedSql } from '../support/shipped-sql';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { arrangePlugin, SERVER_GRANT_INSERT } from './lock-fixtures';
import { LOCK_SOURCES } from './lock-order';

/**
 * The server config PATCH's claim on the `plugins` row (#578), run against
 * Postgres.
 *
 * `updateConfig` validates the submitted document against the plugin manifest
 * it read before its transaction. An activation committing in between replaces
 * that plugin manifest, and the write would then store a document checked
 * against a schema the plugin no longer has. So the transaction opens by
 * claiming the row `FOR NO KEY UPDATE`, and the same statement compares the
 * stored `manifest_json` with the document the PATCH validated against.
 *
 * The unit suite mocks `$queryRaw`: it pins the statement's text and that it
 * runs before the write, and nothing about what Postgres answers. Four things
 * are visible only here:
 *
 *  - the comparison runs against real columns and answers both ways. A
 *    replacement at the same version is seen; a copy differing only in key
 *    order and spacing is not.
 *  - the claim waits for activation's own `FOR UPDATE` on the row and, once
 *    released, compares against what activation committed rather than the row
 *    version it first found.
 *  - two PATCHes queue, and the second reads the config the first wrote. That
 *    is why the mode is not the `FOR SHARE` the unit paths take: this
 *    transaction goes on to write the row, and two share locks each waiting to
 *    be upgraded past the other is a deadlock. A control shows that deadlock
 *    with the rejected mode, so the queueing case is about the mode and not
 *    about these two statements.
 *  - a grant insert for the plugin is not held up. Its foreign key takes
 *    `FOR KEY SHARE`, which `FOR NO KEY UPDATE` allows and `FOR UPDATE` would
 *    not. A control shows `FOR UPDATE` holding it.
 */
describe('the server config PATCH claims the plugin row (FOR NO KEY UPDATE, #578)', () => {
  const { lifecycleService: LIFECYCLE_SERVICE, updateService: UPDATE_SERVICE } = LOCK_SOURCES;

  /**
   * The statement `updateConfig` ships, binding the expected plugin manifest
   * ahead of `${plugin.id}`: the comparison sits in the SELECT list and the id
   * in the WHERE clause.
   *
   * Anchored on the declaration even though the file holds one raw statement
   * today. A second one added below it is then a named failure rather than a
   * lift that quietly follows whichever comes first.
   */
  const configClaim = readShippedSql(LIFECYCLE_SERVICE, ['bindManifest(plugin.manifestJson)', 'plugin.id'], {
    after: 'async updateConfig',
    matching: /FOR NO KEY UPDATE/,
  });

  /**
   * Activation's read of `config`, the first lock its transaction takes on the
   * plugin row, lifted rather than stood in for. The anchor is the one the
   * lock-order spec uses: the file ships a second `FOR UPDATE` (the grant
   * rows), so the shape alone does not name one statement.
   */
  const activationConfigClaim = readShippedSql(UPDATE_SERVICE, ['plugin.id'], {
    after: 'const [current] = await tx.$queryRaw',
    matching: /SELECT config FROM plugins/,
  });

  /**
   * The PATCH's write as a statement a barrier can hold open, standing in for
   * the shipped `plugin.update`: `config` only. It writes a non-key column, so
   * it takes `FOR NO KEY UPDATE`, which conflicts with a `FOR SHARE` held by
   * another transaction and never with this transaction's own claim.
   */
  const CONFIG_WRITE = 'UPDATE plugins SET config = $2::jsonb, updated_at = now() WHERE id = $1 RETURNING id';

  /**
   * Activation replacing the stored plugin manifest and leaving the version
   * where it was: an A→B→A pair as the row ends up after it. Only the content
   * comparison can see that move, which makes it the sharpest test of whether
   * the comparison ran against the committed row.
   */
  const MANIFEST_REPLACEMENT =
    'UPDATE plugins SET manifest_json = $2::jsonb, updated_at = now() WHERE id = $1 RETURNING id';

  /**
   * The mode #578 first proposed and the shipped claim does not take, as the
   * smallest statement that takes it.
   */
  const SHARE_CLAIM = 'SELECT id FROM plugins WHERE id = $1 FOR SHARE';

  /**
   * The mode the claim took before review, as the smallest statement that
   * takes it: the control for the grant-insert case.
   */
  const EXCLUSIVE_CLAIM = 'SELECT id FROM plugins WHERE id = $1 FOR UPDATE';

  interface ClaimedRow {
    readonly uninstalled_at: Date | null;
    readonly version: string;
    readonly installed_at: Date;
    readonly config: unknown;
    readonly manifest_matches: boolean | null;
  }

  let db: TestDatabase;

  beforeAll(() => {
    db = createTestDatabase();
  });

  afterAll(async () => {
    await db.close();
  });

  /**
   * The row as `loadLiving` reads it before the transaction. Its document is
   * what the service binds, serialized: compared against what Postgres holds,
   * never rebuilt from the fixture's slug and version.
   */
  const readStored = (pluginId: string) =>
    db.client.plugin.findUniqueOrThrow({
      where: { id: pluginId },
      select: { manifestJson: true, installedAt: true },
    });

  it('executes against the real schema and matches the stored plugin manifest', async () => {
    // The only place the statement's column list and its `::jsonb` cast meet
    // real columns. A `@map` rename, which the unit suite's text pin cannot
    // see, dies here.
    const plugin = await arrangePlugin(db.client);
    const stored = await readStored(plugin.pluginId);

    await withBarrier(async ({ holder }) => {
      const rows = await holder.query<ClaimedRow>(configClaim.text, [
        JSON.stringify(stored.manifestJson),
        plugin.pluginId,
      ]);

      expect(rows).toHaveLength(1);
      expect(rows[0]?.manifest_matches).toBe(true);
      expect(rows[0]?.uninstalled_at).toBeNull();
      expect(rows[0]?.version).toBe(plugin.version);
      expect(rows[0]?.installed_at).toEqual(stored.installedAt);
    });
  });

  it('sees a replacement at the same version', async () => {
    const plugin = await arrangePlugin(db.client);
    const before = await readStored(plugin.pluginId);

    // An activation pair as the row ends up after it: content replaced,
    // version back where it started, and `installed_at` untouched, since the
    // installer is its only writer and no installer ran.
    await db.client.plugin.update({
      where: { id: plugin.pluginId },
      data: {
        manifestJson: { ...(before.manifestJson as Record<string, unknown>), permissions: ['feedback:write'] },
      },
    });

    await withBarrier(async ({ holder }) => {
      const rows = await holder.query<ClaimedRow>(configClaim.text, [
        JSON.stringify(before.manifestJson),
        plugin.pluginId,
      ]);

      expect(rows[0]?.manifest_matches).toBe(false);
      // Both classifying columns still agree with the pre-read, so the PATCH
      // refuses this only because the content was compared.
      expect(rows[0]?.version).toBe(plugin.version);
      expect(rows[0]?.installed_at).toEqual(before.installedAt);
    });
  });

  it('does not refuse a key-reordered copy of the stored plugin manifest', async () => {
    // The expensive direction: a false mismatch here would 409 every PATCH
    // behind a round-tripped plugin manifest, forever. Written as text on
    // purpose, since a JS object literal cannot express the difference: the
    // serializer would decide the order.
    const plugin = await arrangePlugin(db.client);
    const stored = await readStored(plugin.pluginId);
    const document = stored.manifestJson as Record<string, unknown>;
    const keys = Object.keys(document);
    const reordered = `{\n  ${keys
      .reverse()
      .map((key) => `${JSON.stringify(key)} :  ${JSON.stringify(document[key])}`)
      .join(',\n  ')}\n}`;

    // Guards the guard: with one key, reversing proves nothing and this case
    // would pass while testing spacing alone.
    expect(keys.length).toBeGreaterThan(1);
    expect(reordered).not.toBe(JSON.stringify(stored.manifestJson));

    await withBarrier(async ({ holder }) => {
      const rows = await holder.query<ClaimedRow>(configClaim.text, [reordered, plugin.pluginId]);

      expect(rows[0]?.manifest_matches).toBe(true);
    });
  });

  it("waits for activation's config claim, then reads what activation wrote", async () => {
    // The window #578 reported. The PATCH reaches the row while activation
    // holds it, and activation then replaces the plugin manifest. A claim that
    // did not wait would compare against the old document and pass; one that
    // waited but answered from the row version it first found would too.
    // Under READ COMMITTED the released statement re-evaluates against the
    // committed row (EvalPlanQual), the comparison in its SELECT list
    // included, and that is the answer the PATCH refuses on.
    const plugin = await arrangePlugin(db.client);
    const stored = await readStored(plugin.pluginId);
    const replaced = { ...(stored.manifestJson as Record<string, unknown>), permissions: ['feedback:write'] };

    await withBarrier(async (barrier) => {
      const { holder, waiter } = barrier;

      await holder.begin();
      await expect(holder.query(activationConfigClaim.text, [plugin.pluginId])).resolves.toHaveLength(1);

      await waiter.begin();
      const pending = waiter.issue<ClaimedRow>(
        configClaim.text,
        [JSON.stringify(stored.manifestJson), plugin.pluginId],
        "the server config PATCH's claim",
      );

      await expectBlocked(barrier, pending);

      // Written after the PATCH is already waiting, so the statement's own
      // snapshot predates it: only the re-evaluation can see it.
      await expect(
        holder.query(MANIFEST_REPLACEMENT, [plugin.pluginId, JSON.stringify(replaced)]),
      ).resolves.toHaveLength(1);
      await holder.commit();

      const rows = await pending.result();

      expect(rows).toHaveLength(1);
      expect(rows[0]?.manifest_matches).toBe(false);
      expect(rows[0]?.version).toBe(plugin.version);

      await waiter.commit();
    });
  });

  it('two config writes queue rather than deadlock', async () => {
    // Why the mode is exclusive. Each PATCH claims the row and then writes it;
    // under this mode the second claim waits for the whole first transaction,
    // so it never holds anything the first is waiting for.
    const plugin = await arrangePlugin(db.client);
    const stored = await readStored(plugin.pluginId);
    const expected = JSON.stringify(stored.manifestJson);
    const first = { webhookUrl: 'https://first.example.test' };
    const second = { webhookUrl: 'https://second.example.test' };

    await withBarrier(async (barrier) => {
      const { holder, waiter } = barrier;

      await holder.begin();
      await expect(holder.query<ClaimedRow>(configClaim.text, [expected, plugin.pluginId])).resolves.toEqual([
        expect.objectContaining({ manifest_matches: true }),
      ]);

      await waiter.begin();
      const pending = waiter.issue<ClaimedRow>(
        configClaim.text,
        [expected, plugin.pluginId],
        "the second PATCH's claim",
      );

      await expectBlocked(barrier, pending);

      await expect(holder.query(CONFIG_WRITE, [plugin.pluginId, JSON.stringify(first)])).resolves.toHaveLength(1);
      await holder.commit();

      // Released and not refused: a config write moves no plugin manifest, so
      // the second PATCH still matches and goes on to win. Last-writer-wins
      // between PATCHes is unchanged by #578. The claim also reads the first
      // PATCH's document, which is what the second one's event reports as the
      // config it replaced.
      const rows = await pending.result();

      expect(rows[0]?.manifest_matches).toBe(true);
      expect(rows[0]?.config).toEqual(first);
      await expect(waiter.query(CONFIG_WRITE, [plugin.pluginId, JSON.stringify(second)])).resolves.toHaveLength(1);
      await waiter.commit();

      const row = await db.client.plugin.findUniqueOrThrow({
        where: { id: plugin.pluginId },
        select: { config: true },
      });

      expect(row.config).toEqual(second);
    });
  });

  it('the rejected FOR SHARE shape deadlocks two writers (control)', async () => {
    // The same two PATCHes and the same write, with the claim taken in share
    // mode. Both claims are granted at once, since share is compatible with
    // share, and each write then needs the lock the other's claim holds.
    // Without this case the queueing above could be a property of these
    // statements rather than of the mode.
    const plugin = await arrangePlugin(db.client);

    await withBarrier(async (barrier) => {
      const { holder, waiter } = barrier;

      await holder.begin();
      await expect(holder.query(SHARE_CLAIM, [plugin.pluginId])).resolves.toHaveLength(1);

      await waiter.begin();
      await expect(waiter.query(SHARE_CLAIM, [plugin.pluginId])).resolves.toHaveLength(1);

      // Half the cycle: the first write waits on the second claim's share lock.
      const firstWrite = holder.issue(
        CONFIG_WRITE,
        [plugin.pluginId, JSON.stringify({ webhookUrl: 'https://first.example.test' })],
        "the first PATCH's write",
      );

      await expectBlocked(barrier, firstWrite);

      // Closing it. Deliberately NOT asserted as blocked: from here Postgres
      // aborts a victim it chooses, and an assertion that both are waiting
      // races that abort (#330).
      const secondWrite = waiter.issue(
        CONFIG_WRITE,
        [plugin.pluginId, JSON.stringify({ webhookUrl: 'https://second.example.test' })],
        "the second PATCH's write",
      );
      const outcomes = await Promise.allSettled([firstWrite.result(), secondWrite.result()]);
      const victims = outcomes.filter(
        (outcome) => outcome.status === 'rejected' && (outcome.reason as { code?: string }).code === '40P01',
      );

      // Exactly one, and never which one: the victim is Postgres's choice.
      expect(victims).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    });
  });

  it('does not hold up a grant insert for the plugin while the PATCH is open', async () => {
    // A decision or activation inserting a grant row takes `FOR KEY SHARE` on
    // the plugin row through the foreign key. A config write has nothing to
    // order against it, so the claim must not make it wait.
    const plugin = await arrangePlugin(db.client);
    const stored = await readStored(plugin.pluginId);

    await withBarrier(async (barrier) => {
      const { holder, waiter } = barrier;

      await holder.begin();
      await expect(
        holder.query<ClaimedRow>(configClaim.text, [JSON.stringify(stored.manifestJson), plugin.pluginId]),
      ).resolves.toHaveLength(1);

      await waiter.begin();
      const insert = waiter.issue(
        SERVER_GRANT_INSERT,
        [randomUUID(), plugin.pluginId, `probe:${randomUUID()}`],
        'a grant insert for the plugin',
      );

      await expectNotBlocked(barrier, insert);
      await expect(insert.result()).resolves.toHaveLength(1);

      await waiter.commit();
      await holder.commit();
    });
  });

  it('the earlier FOR UPDATE shape holds that grant insert up (control)', async () => {
    // Without this case the one above could pass because the insert takes no
    // lock on the plugin row at all, rather than because of the claim's mode.
    const plugin = await arrangePlugin(db.client);

    await withBarrier(async (barrier) => {
      const { holder, waiter } = barrier;

      await holder.begin();
      await expect(holder.query(EXCLUSIVE_CLAIM, [plugin.pluginId])).resolves.toHaveLength(1);

      await waiter.begin();
      const insert = waiter.issue(
        SERVER_GRANT_INSERT,
        [randomUUID(), plugin.pluginId, `probe:${randomUUID()}`],
        'a grant insert for the plugin',
      );

      await expectBlocked(barrier, insert);
      await holder.commit();
      await expect(insert.result()).resolves.toHaveLength(1);
      await waiter.commit();
    });
  });
});
