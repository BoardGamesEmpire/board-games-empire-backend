import { expectBlocked, withBarrier } from '../support/lock-barrier';
import { readShippedSql } from '../support/shipped-sql';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { ACTIVATION_VERSION_BUMP, arrangePlugin, UNINSTALL_CLAIM } from './lock-fixtures';
import { LOCK_SOURCES } from './lock-order';

/**
 * The consent decision's claim on the `plugins` row, and the claim each
 * post-commit pass opens with (#361), run against Postgres.
 *
 * `decide()` judges a decision against the plugin manifest it read before its
 * transaction. An uninstall or an activation committing in between would leave
 * that judgment stale: a grant written onto an uninstalled plugin, or a consent
 * recorded against a plugin manifest the plugin no longer has. So the
 * transaction claims the row `FOR SHARE` and the same statement reads whether
 * the plugin is uninstalled and compares the stored `manifest_json` with the
 * document the decision read. An uninstalled plugin or a move refuses the
 * decision.
 *
 * The passes that run after the decision commits (late acceptance, and the
 * reconcile path's suspension) are separate transactions. Each claims the row
 * `FOR SHARE` too, and judges against the plugin manifest that claim reads, so a
 * late acceptance arriving after an activation cannot clear a suspension that
 * activation just imposed.
 *
 * The unit suite mocks `$queryRaw`: it pins the statements' text and the
 * service's answer to each row, and nothing about what Postgres returns. Four
 * things are visible only here:
 *
 *  - the decision's claim waits for an uninstall's claim and, once released,
 *    reports the uninstalled plugin rather than the row version it first found.
 *  - the decision's claim waits for an activation's writes and, once released,
 *    reports the new version and a plugin manifest that no longer matches.
 *  - the comparison answers both ways against real columns. A replacement at
 *    the same version is seen; a copy differing only in key order and spacing
 *    is not.
 *  - a pass's claim waits for an activation's write and reads the version and
 *    plugin manifest that activation committed.
 */
describe('the consent decision and its post-commit passes claim the plugin row (FOR SHARE, #361)', () => {
  const { grantService: GRANT_SERVICE } = LOCK_SOURCES;

  /**
   * The statement `decide()` ships, binding the plugin manifest the decision
   * read ahead of `${plugin.id}`: the comparison sits in the SELECT list and the
   * id in the WHERE clause.
   *
   * Anchored on the attempt's declaration because the file ships several
   * `FROM plugins` claims, one per post-commit pass.
   */
  const decisionClaim = readShippedSql(GRANT_SERVICE, ['bindManifest(plugin.manifestJson)', 'plugin.id'], {
    after: 'const attempt',
    matching: /FROM plugins/,
  });

  /**
   * The claim a post-commit pass opens with, lifted from the household
   * late acceptance pass. Its three siblings ship the same text; this one
   * stands for them because a late acceptance is the pass whose stale judgment
   * does the damage.
   */
  const passClaim = readShippedSql(GRANT_SERVICE, ['plugin.id'], {
    after: 'private async maybeReenableSuspendedHousehold',
    matching: /FROM plugins/,
  });

  /**
   * Activation replacing the stored plugin manifest, as the second write of a
   * transaction that has already claimed the row with
   * `ACTIVATION_VERSION_BUMP`.
   */
  const MANIFEST_REPLACEMENT =
    'UPDATE plugins SET manifest_json = $2::jsonb, updated_at = now() WHERE id = $1 RETURNING id';

  interface DecisionClaimRow {
    readonly uninstalled_at: Date | null;
    readonly version: string;
    readonly installed_at: Date;
    readonly manifest_matches: boolean | null;
  }

  interface PassClaimRow {
    readonly slug: string;
    readonly version: string;
    readonly manifest_json: unknown;
    readonly uninstalled_at: Date | null;
  }

  let db: TestDatabase;

  beforeAll(() => {
    db = createTestDatabase();
  });

  afterAll(async () => {
    await db.close();
  });

  /**
   * The row as `loadPlugin` reads it before the transaction. Its document is
   * what the service binds, serialized: compared against what Postgres holds,
   * never rebuilt from the fixture's slug and version.
   */
  const readStored = (pluginId: string) =>
    db.client.plugin.findUniqueOrThrow({
      where: { id: pluginId },
      select: { manifestJson: true, installedAt: true },
    });

  it("waits for an uninstall's claim, then sees the uninstalled plugin", async () => {
    // The uninstall window. A decision that reaches the row while an uninstall
    // holds it must wait, and must then see the uninstalled plugin: under READ
    // COMMITTED the released statement re-evaluates against the committed row
    // (EvalPlanQual). A claim that did not wait, or answered from the row
    // version it first found, would let the upsert write a grant onto a
    // plugin that is gone.
    const plugin = await arrangePlugin(db.client);
    const stored = await readStored(plugin.pluginId);

    await withBarrier(async (barrier) => {
      const { holder, waiter } = barrier;

      await holder.begin();
      await expect(holder.query(UNINSTALL_CLAIM, [plugin.pluginId])).resolves.toHaveLength(1);

      await waiter.begin();
      const pending = waiter.issue<DecisionClaimRow>(
        decisionClaim.text,
        [JSON.stringify(stored.manifestJson), plugin.pluginId],
        "the decision's claim",
      );

      await expectBlocked(barrier, pending);

      await holder.commit();

      const rows = await pending.result();

      expect(rows).toHaveLength(1);
      expect(rows[0]?.uninstalled_at).not.toBeNull();

      await waiter.commit();
    });
  });

  it("waits for an activation's writes, then reports the moved version and plugin manifest", async () => {
    // The window this issue is about. A decision read the plugin manifest,
    // then reaches the row while an activation holds it and replaces the
    // plugin manifest. The claim must wait, and once released must compare
    // against the activation's LAST write: the new version, and content
    // that no longer matches what the decision read. A claim that answered
    // from the row version it first found would report a match and let the
    // decision record consent against a plugin manifest no longer in force.
    const plugin = await arrangePlugin(db.client);
    const stored = await readStored(plugin.pluginId);
    const replaced = {
      ...(stored.manifestJson as Record<string, unknown>),
      version: '2.0.0',
      permissions: ['feedback:write'],
    };

    await withBarrier(async (barrier) => {
      const { holder, waiter } = barrier;

      await holder.begin();
      await expect(holder.query(ACTIVATION_VERSION_BUMP, [plugin.pluginId, '2.0.0'])).resolves.toHaveLength(1);

      await waiter.begin();
      const pending = waiter.issue<DecisionClaimRow>(
        decisionClaim.text,
        [JSON.stringify(stored.manifestJson), plugin.pluginId],
        "the decision's claim",
      );

      await expectBlocked(barrier, pending);

      await expect(
        holder.query(MANIFEST_REPLACEMENT, [plugin.pluginId, JSON.stringify(replaced)]),
      ).resolves.toHaveLength(1);
      await holder.commit();

      const rows = await pending.result();

      expect(rows).toHaveLength(1);
      expect(rows[0]?.version).toBe('2.0.0');
      expect(rows[0]?.manifest_matches).toBe(false);
      // An activation, not a reinstall: the installer is the only writer of
      // `installed_at`, so the decision is refused as `version-activated`.
      expect(rows[0]?.installed_at).toEqual(stored.installedAt);
      expect(rows[0]?.uninstalled_at).toBeNull();

      await waiter.commit();
    });
  });

  it('sees an A→B→A replacement', async () => {
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
      const rows = await holder.query<DecisionClaimRow>(decisionClaim.text, [
        JSON.stringify(before.manifestJson),
        plugin.pluginId,
      ]);

      expect(rows[0]?.manifest_matches).toBe(false);
      // Both classifying columns still agree with the pre-read, so the
      // decision refuses this only because the content was compared.
      expect(rows[0]?.version).toBe(plugin.version);
      expect(rows[0]?.installed_at).toEqual(before.installedAt);
      expect(rows[0]?.uninstalled_at).toBeNull();
    });
  });

  it('does not refuse a key-reordered copy', async () => {
    // The expensive direction: a false mismatch here would 409 every decision
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
      const rows = await holder.query<DecisionClaimRow>(decisionClaim.text, [reordered, plugin.pluginId]);

      expect(rows[0]?.manifest_matches).toBe(true);
    });
  });

  it("a late acceptance's claim waits out an activation, then reads its plugin manifest", async () => {
    // The window the post-commit passes had. A late acceptance running after
    // its decision committed reaches the row while an activation holds it, and the
    // activation then replaces the plugin manifest. A pass that did not wait,
    // or read the row version it first found, would judge against the plugin
    // manifest the activation just replaced and could clear a suspension that
    // activation imposed.
    const plugin = await arrangePlugin(db.client);
    const stored = await readStored(plugin.pluginId);
    const replaced = {
      ...(stored.manifestJson as Record<string, unknown>),
      version: '2.0.0',
      permissions: ['feedback:write'],
    };

    await withBarrier(async (barrier) => {
      const { holder, waiter } = barrier;

      await holder.begin();
      await expect(holder.query(ACTIVATION_VERSION_BUMP, [plugin.pluginId, '2.0.0'])).resolves.toHaveLength(1);

      await waiter.begin();
      const pending = waiter.issue<PassClaimRow>(passClaim.text, [plugin.pluginId], "the late acceptance's claim");

      await expectBlocked(barrier, pending);

      // The activation's second write: the waiting statement's re-evaluation
      // follows the row's update chain to the activation's LAST write, not
      // its first, so the replaced plugin manifest is what it reads.
      await expect(
        holder.query(MANIFEST_REPLACEMENT, [plugin.pluginId, JSON.stringify(replaced)]),
      ).resolves.toHaveLength(1);
      await holder.commit();

      const rows = await pending.result();

      expect(rows).toHaveLength(1);
      expect(rows[0]?.slug).toBe(plugin.slug);
      expect(rows[0]?.version).toBe('2.0.0');
      expect(rows[0]?.manifest_json).toEqual(replaced);
      expect(rows[0]?.uninstalled_at).toBeNull();

      await waiter.commit();
    });
  });
});
