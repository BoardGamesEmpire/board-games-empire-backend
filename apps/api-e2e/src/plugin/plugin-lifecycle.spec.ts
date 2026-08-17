import {
  PluginCategory,
  PluginGrantScope,
  PluginGrantStatus,
  PluginLifecycleEventType,
  PluginScope,
  RiskLevel,
  type Plugin,
} from '@bge/database';
import { createActors, pollUntil, type Actors, type SessionActor } from '@bge/testing-e2e';
import { buildPluginManifest } from '@boardgamesempire/plugin-manifest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

/**
 * The wire half of #320: enable/disable, server config PATCH, and uninstall
 * asserted as PERSISTED STATE and as what a subsequent request can see —
 * the tombstone answering 410, the purge being real rows gone, the
 * lifecycle table carrying the affected units — none of which a mocked
 * `DatabaseService` can observe.
 */
describe('plugin lifecycle (server-level)', () => {
  const baseUrl = requireBaseUrl(process.env);
  const PLUGINS_PATH = '/api/plugins';

  let db: TestDatabase;
  let actors: Actors;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  /**
   * Arranged directly rather than through an install endpoint — none exists
   * (ingress is #84); the row IS the installed state. The slug stays the
   * fixture's own `demo-sink`: the manifest's namespace rules (event, queue,
   * and own-table prefixes) are pinned to it, so an overridden slug fails
   * stored-manifest re-validation — correctly — as corrupted state. The
   * between-test truncate keeps the unique slug collision-free per test.
   */
  const arrangePlugin = async (overrides: Partial<Plugin> = {}): Promise<Plugin> => {
    const manifest = buildPluginManifest();
    const slug = manifest.slug;

    return db.client.plugin.create({
      data: {
        slug,
        version: manifest.version,
        category: PluginCategory.FeedbackSink,
        scope: PluginScope.Server,
        manifestJson: manifest as never,
        enabled: false,
        bundled: false,
        installedSha256: randomUUID(),
        ...(overrides as Record<string, never>),
      },
    });
  };

  const post = (actor: SessionActor, path: string, body: Record<string, unknown> = {}) =>
    request(baseUrl).post(`${PLUGINS_PATH}${path}`).set(actor.headers).send(body);

  const patchConfig = (actor: SessionActor, slug: string, body: Record<string, unknown>) =>
    request(baseUrl).patch(`${PLUGINS_PATH}/${slug}/config`).set(actor.headers).send(body);

  describe('authorization', () => {
    it('refuses a non-admin at the policy gate', async () => {
      const user = await actors.user();
      const plugin = await arrangePlugin();

      await post(user, `/${plugin.slug}/enable`).expect(403);
    });

    it('refuses an unauthenticated caller', async () => {
      const plugin = await arrangePlugin();

      await request(baseUrl).post(`${PLUGINS_PATH}/${plugin.slug}/enable`).send({}).expect(401);
    });
  });

  describe('enable / disable', () => {
    it('enable persists the flag and returns the row with a success message', async () => {
      const admin = await actors.admin();
      const plugin = await arrangePlugin();

      const response = await post(admin, `/${plugin.slug}/enable`).expect(200);

      expect(response.body.plugin.enabled).toBe(true);
      expect(response.body.message).toContain(plugin.slug);

      const row = await db.client.plugin.findUniqueOrThrow({ where: { id: plugin.id } });
      expect(row.enabled).toBe(true);
    });

    it('enable is idempotent over the wire', async () => {
      const admin = await actors.admin();
      const plugin = await arrangePlugin({ enabled: true });

      const response = await post(admin, `/${plugin.slug}/enable`).expect(200);
      expect(response.body.plugin.enabled).toBe(true);
    });

    it('disable persists the flag', async () => {
      const admin = await actors.admin();
      const plugin = await arrangePlugin({ enabled: true });

      await post(admin, `/${plugin.slug}/disable`).expect(200);

      const row = await db.client.plugin.findUniqueOrThrow({ where: { id: plugin.id } });
      expect(row.enabled).toBe(false);
    });

    it('an unknown slug is 404 with the domain code', async () => {
      const admin = await actors.admin();

      const response = await post(admin, `/absent-${randomUUID().slice(0, 8)}/enable`).expect(404);
      expect(response.body.code).toBe('PluginLifecycleNotFoundError');
    });
  });

  describe('server config PATCH', () => {
    it('persists a schema-valid payload', async () => {
      const admin = await actors.admin();
      const plugin = await arrangePlugin();

      const response = await patchConfig(admin, plugin.slug, {
        config: { webhookUrl: 'https://e2e.example.test/hook' },
      }).expect(200);

      expect(response.body.plugin.config).toEqual({ webhookUrl: 'https://e2e.example.test/hook' });

      const row = await db.client.plugin.findUniqueOrThrow({ where: { id: plugin.id } });
      expect(row.config).toEqual({ webhookUrl: 'https://e2e.example.test/hook' });
    });

    it('rejects a schema-violating payload as 422 carrying the issues', async () => {
      const admin = await actors.admin();
      const plugin = await arrangePlugin({ config: { webhookUrl: 'https://before.example.test' } });

      const response = await patchConfig(admin, plugin.slug, { config: { webhookUrl: 42 } }).expect(422);

      expect(response.body.code).toBe('PluginConfigValidationError');
      expect(response.body.slug).toBe(plugin.slug);
      expect(response.body.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: '/webhookUrl', keyword: 'type' })]),
      );

      // The write never happened — LWW does not mean write-then-check.
      const row = await db.client.plugin.findUniqueOrThrow({ where: { id: plugin.id } });
      expect(row.config).toEqual({ webhookUrl: 'https://before.example.test' });
    });

    it('rejects a body without the config wrapper at the validation pipe', async () => {
      const admin = await actors.admin();
      const plugin = await arrangePlugin();

      await patchConfig(admin, plugin.slug, { webhookUrl: 'https://naked.example.test' }).expect(400);
    });
  });

  describe('uninstall', () => {
    const arrangeConsentSurface = async (plugin: Plugin) => {
      await db.client.pluginPermission.create({
        data: { pluginId: plugin.id, slug: `plugin|${plugin.slug}|manage:digest`, riskLevel: RiskLevel.Low },
      });
      // A durable DENIAL — the purge must not preserve it (reinstall is fresh consent).
      await db.client.pluginGrant.create({
        data: {
          pluginId: plugin.id,
          scopeType: PluginGrantScope.Server,
          scopeId: '',
          permissionSlug: 'feedback:read',
          status: PluginGrantStatus.Denied,
          manifestVersion: plugin.version,
          decidedAt: new Date(),
          decidedRiskLevel: RiskLevel.Medium,
        },
      });
    };

    it('tombstones the row, purges consent, clears the staged update, and reports the affected units', async () => {
      const admin = await actors.admin();
      const plugin = await arrangePlugin({
        enabled: true,
        pendingVersion: '1.3.0',
        pendingSha256: 'stale-sha',
        pendingSince: new Date(),
      });
      await arrangeConsentSurface(plugin);
      await db.client.userPlugin.create({ data: { userId: admin.user.id, pluginId: plugin.id, enabled: true } });

      const response = await post(admin, `/${plugin.slug}/uninstall`).expect(200);

      expect(response.body.affectedUnits).toEqual([{ scopeType: 'User', userId: admin.user.id }]);

      const row = await db.client.plugin.findUniqueOrThrow({ where: { id: plugin.id } });
      expect(row.uninstalledAt).not.toBeNull();
      expect(row.enabled).toBe(false);
      expect(row.restartRequired).toBe(true);
      expect(row.pendingVersion).toBeNull();
      expect(row.pendingSha256).toBeNull();
      expect(row.pendingSince).toBeNull();

      await expect(db.client.pluginGrant.count({ where: { pluginId: plugin.id } })).resolves.toBe(0);
      await expect(db.client.pluginPermission.count({ where: { pluginId: plugin.id } })).resolves.toBe(0);
      // Retained by default — the tombstone exists to preserve unit config.
      await expect(db.client.userPlugin.count({ where: { pluginId: plugin.id } })).resolves.toBe(1);
    });

    it('purgeData: true deletes the retained unit config rows', async () => {
      const admin = await actors.admin();
      const plugin = await arrangePlugin();
      await db.client.userPlugin.create({ data: { userId: admin.user.id, pluginId: plugin.id, enabled: true } });

      await post(admin, `/${plugin.slug}/uninstall`, { purgeData: true }).expect(200);

      await expect(db.client.userPlugin.count({ where: { pluginId: plugin.id } })).resolves.toBe(0);
    });

    it('a form-encoded purgeData=false stays an opt-OUT — the retained rows survive', async () => {
      const admin = await actors.admin();
      const plugin = await arrangePlugin();
      await db.client.userPlugin.create({ data: { userId: admin.user.id, pluginId: plugin.id, enabled: true } });

      await request(baseUrl)
        .post(`${PLUGINS_PATH}/${plugin.slug}/uninstall`)
        .set(admin.headers)
        .type('form')
        .send('purgeData=false')
        .expect(200);

      await expect(db.client.userPlugin.count({ where: { pluginId: plugin.id } })).resolves.toBe(1);
    });

    it('writes the lifecycle provenance row carrying the affected units', async () => {
      const admin = await actors.admin();
      const plugin = await arrangePlugin();
      await db.client.userPlugin.create({ data: { userId: admin.user.id, pluginId: plugin.id, enabled: true } });

      await post(admin, `/${plugin.slug}/uninstall`).expect(200);

      // The listener persists post-commit and out-of-band, so the row lands
      // after the response.
      const rows = await pollUntil(
        async () => {
          const found = await db.client.pluginLifecycleEvent.findMany({
            where: { pluginId: plugin.id, event: PluginLifecycleEventType.Uninstalled },
            select: { payload: true, manifestVersion: true },
          });

          return found.length > 0 ? found : undefined;
        },
        { description: `the uninstall lifecycle row for '${plugin.slug}'`, timeoutMs: 5_000 },
      );

      expect(rows).toHaveLength(1);
      expect(rows[0].manifestVersion).toBe(plugin.version);
      expect(rows[0].payload).toEqual({
        affectedUnits: [{ scopeType: 'User', userId: admin.user.id }],
      });
    });

    it('a second uninstall is 410 — the tombstone answers, not a 404', async () => {
      const admin = await actors.admin();
      const plugin = await arrangePlugin();

      await post(admin, `/${plugin.slug}/uninstall`).expect(200);
      const response = await post(admin, `/${plugin.slug}/uninstall`).expect(410);

      expect(response.body.code).toBe('PluginLifecycleTombstonedError');
      expect(response.body.slug).toBe(plugin.slug);
    });

    it('enable answers 410 once the row is tombstoned', async () => {
      const admin = await actors.admin();
      const plugin = await arrangePlugin({ enabled: true });

      await post(admin, `/${plugin.slug}/uninstall`).expect(200);

      await post(admin, `/${plugin.slug}/enable`).expect(410);
    });

    it('the config write answers 410 once the row is tombstoned', async () => {
      const admin = await actors.admin();
      const plugin = await arrangePlugin({ enabled: true });

      await post(admin, `/${plugin.slug}/uninstall`).expect(200);

      await patchConfig(admin, plugin.slug, { config: {} }).expect(410);
    });

    it('refuses a bundled plugin with 409 — disable is the kill switch', async () => {
      const admin = await actors.admin();
      const plugin = await arrangePlugin({ bundled: true, installedSha256: null });

      const response = await post(admin, `/${plugin.slug}/uninstall`).expect(409);

      expect(response.body.code).toBe('PluginUninstallBundledError');
      const row = await db.client.plugin.findUniqueOrThrow({ where: { id: plugin.id } });
      expect(row.uninstalledAt).toBeNull();
    });
  });
});
