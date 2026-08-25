import { PluginCategory, PluginScope, RiskLevel, type Plugin } from '@bge/database';
import { createActors, type Actors, type SessionActor } from '@bge/testing-e2e';
import { buildPluginManifest } from '@boardgamesempire/plugin-manifest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

/**
 * The wire half of #354 — the only plugin reads that answer before a slug is
 * known. Pinned here: the `read:plugin` gate on the server surface (the one
 * that serves provenance), the household instance gate, the actor-kind floor
 * on the user surface, the #230 envelope, the D-CH tombstone asymmetry, the
 * D-CF orphan flag, the D-CG per-row degradation, and the privilege split
 * that keeps provenance and version off the two unit reads.
 *
 * Plugin state is arranged directly on the rows (the install ingress is
 * #84's), same as the other C4 suites.
 */
describe('installed-plugin inventory (#354)', () => {
  const baseUrl = requireBaseUrl(process.env);

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
   * A distinct slug per plugin, because these reads ENUMERATE: a suite-wide
   * fixture slug would let one test's rows appear in another's page. Tests
   * therefore assert against their own slug rather than on page contents.
   */
  const arrangePlugin = async (rowOverrides: Record<string, unknown> = {}): Promise<Plugin> => {
    const slug = `inv-${randomUUID().slice(0, 8)}`;
    const manifest = buildPluginManifest({
      slug,
      bgeCompat: '>=0.0.0',
      displayName: { en: 'Inventory Fixture', de: 'Bestandsvorrichtung' },
      description: { en: 'Fixture for the inventory reads.' },
      events: { emits: [`plugin.${slug}.digest-sent`], subscribes: ['feedback.created'] },
      jobs: { queues: [`plugin:${slug}:digest`] },
      storage: { ownTables: [`plugin_${slug.replace(/-/g, '_')}_digests`] },
      permissions: {
        declares: ['manage:digest'],
        checks: [
          {
            slug: 'manage:digest',
            required: true,
            reason: { en: 'Stores and manages the digest configuration it owns.' },
            consentScope: 'server',
            feature: 'weekly-digest',
          },
        ],
      },
    });

    const plugin = await db.client.plugin.create({
      data: {
        slug,
        version: manifest.version,
        category: PluginCategory.FeedbackSink,
        scope: manifest.scope === 'server' ? PluginScope.Server : PluginScope.Household,
        manifestJson: manifest as never,
        enabled: true,
        bundled: false,
        installedSha256: 'a'.repeat(64),
        installedFromUrl: 'https://registry.test/fixture.tgz',
        ...rowOverrides,
      },
    });
    await db.client.pluginPermission.create({
      data: { pluginId: plugin.id, slug: `plugin|${slug}|manage:digest`, riskLevel: RiskLevel.Low },
    });

    return plugin;
  };

  const listServer = (actor: SessionActor, query = '') =>
    request(baseUrl).get(`/api/plugins${query}`).set(actor.headers);
  const readOne = (actor: SessionActor, slug: string) =>
    request(baseUrl).get(`/api/plugins/${slug}`).set(actor.headers);
  const listHousehold = (actor: SessionActor, householdId: string, query = '') =>
    request(baseUrl).get(`/api/households/${householdId}/plugins${query}`).set(actor.headers);
  const listUser = (actor: SessionActor, query = '') =>
    request(baseUrl).get(`/api/users/me/plugins${query}`).set(actor.headers);

  /** The entry for a specific slug — these reads enumerate, so never index by position. */
  const entryFor = (body: { plugins: Array<Record<string, unknown>> }, slug: string) =>
    body.plugins.find((entry) => entry['slug'] === slug);

  describe('GET /plugins — the server surface', () => {
    it('requires read:plugin, and is 401 unauthenticated', async () => {
      const user = await actors.user();

      await listServer(user).expect(403);
      await request(baseUrl).get('/api/plugins').expect(401);
    });

    it('returns the #230 envelope with the localized entry and its provenance', async () => {
      const admin = await actors.admin();
      const plugin = await arrangePlugin();

      const response = await listServer(admin, '?limit=100').expect(200);

      expect(response.body.pagination).toMatchObject({
        page: 1,
        limit: 100,
        total: expect.any(Number),
        totalPages: expect.any(Number),
        hasMore: expect.any(Boolean),
      });

      expect(entryFor(response.body, plugin.slug)).toMatchObject({
        slug: plugin.slug,
        version: plugin.version,
        enabled: true,
        displayName: 'Inventory Fixture',
        manifestUnreadable: false,
        provenance: { kind: 'installed', sha256: 'a'.repeat(64), url: 'https://registry.test/fixture.tgz' },
      });
    });

    // Only `en` ships as a supported catalog (#135), so the resolver never
    // hands this read a `de` locale even though the fixture manifest carries a
    // German displayName — the manifest chain's own resolution is proven in
    // the service spec, where the locale is supplied directly. What e2e can
    // pin is that an unsupported tag degrades to the default instead of
    // erroring or emptying the field.
    it('falls back to the default catalog for a locale the server does not ship', async () => {
      const admin = await actors.admin();
      const plugin = await arrangePlugin();

      const response = await listServer(admin, '?limit=100').set('Accept-Language', 'de').expect(200);

      expect(entryFor(response.body, plugin.slug)?.['displayName']).toBe('Inventory Fixture');
    });

    it('rejects the retired offset parameter rather than ignoring it (D-230-1)', async () => {
      const admin = await actors.admin();

      await listServer(admin, '?offset=10').expect(400);
    });

    it('excludes a tombstone by default and admits it only on request (D-CH)', async () => {
      const admin = await actors.admin();
      const plugin = await arrangePlugin({ uninstalledAt: new Date() });

      const excluded = await listServer(admin, '?limit=100').expect(200);
      expect(entryFor(excluded.body, plugin.slug)).toBeUndefined();

      const included = await listServer(admin, '?limit=100&includeUninstalled=true').expect(200);
      expect(entryFor(included.body, plugin.slug)?.['uninstalledAt']).not.toBeNull();
    });

    it('lists a plugin whose stored manifest is corrupt, marked and stripped (D-CG)', async () => {
      const admin = await actors.admin();
      const plugin = await arrangePlugin();
      await db.client.plugin.update({ where: { id: plugin.id }, data: { manifestJson: { nonsense: true } } });

      const response = await listServer(admin, '?limit=100').expect(200);

      expect(entryFor(response.body, plugin.slug)).toMatchObject({
        slug: plugin.slug,
        version: plugin.version,
        displayName: null,
        description: null,
        manifestUnreadable: true,
      });
    });
  });

  describe('GET /plugins/:slug — the single read', () => {
    it('adds the manifest detail a page has no room for', async () => {
      const admin = await actors.admin();
      const plugin = await arrangePlugin();

      const response = await readOne(admin, plugin.slug).expect(200);

      expect(response.body.plugin).toMatchObject({ slug: plugin.slug, executionMode: 'InProcess' });
      expect(response.body.plugin.features).toEqual([
        { name: 'weekly-digest', displayName: 'Weekly digest', description: expect.any(String) },
      ]);
    });

    it('is 404 for an unknown slug and 403 for a caller without read:plugin', async () => {
      const admin = await actors.admin();
      const user = await actors.user();
      const plugin = await arrangePlugin();

      const missing = await readOne(admin, `absent-${randomUUID().slice(0, 8)}`).expect(404);
      expect(missing.body.code).toBe('PluginInventoryNotFoundError');

      await readOne(user, plugin.slug).expect(403);
    });

    it('is 410 for a tombstone, with no flag able to override it (D-CH)', async () => {
      const admin = await actors.admin();
      const plugin = await arrangePlugin({ uninstalledAt: new Date() });

      const gone = await readOne(admin, plugin.slug).expect(410);
      expect(gone.body.code).toBe('PluginInventoryTombstonedError');
      expect(gone.body.uninstalledAt).toBeDefined();

      // The list's opt-in cannot reach this route: it binds no query DTO, so
      // the parameter is ignored rather than rejected, and 410 holds with it
      // present. That is the property that matters — no query string turns a
      // tombstone into a 200 here.
      await request(baseUrl).get(`/api/plugins/${plugin.slug}?includeUninstalled=true`).set(admin.headers).expect(410);
    });

    it('fails loud on a corrupt manifest — the list degrades, this does not (D-CG)', async () => {
      const admin = await actors.admin();
      const plugin = await arrangePlugin();
      await db.client.plugin.update({ where: { id: plugin.id }, data: { manifestJson: { nonsense: true } } });

      const response = await readOne(admin, plugin.slug).expect(500);
      expect(response.body.code).toBe('PluginInventoryManifestError');
    });
  });

  describe('GET /households/:householdId/plugins', () => {
    it("refuses another household's admin at the instance gate (D-AZ)", async () => {
      const ownerA = await actors.user();
      const ownerB = await actors.user();
      const fixtureA = await actors.householdWithMembers({ owner: ownerA });
      await actors.householdWithMembers({ owner: ownerB });

      await listHousehold(ownerA, fixtureA.household.id).expect(200);
      await listHousehold(ownerB, fixtureA.household.id).expect(403);
    });

    it('lists a household-scope plugin unanchored — the row set is plugin-driven (D-CE)', async () => {
      const owner = await actors.user();
      const fixture = await actors.householdWithMembers({ owner });
      const plugin = await arrangePlugin({ scope: PluginScope.Household });

      const response = await listHousehold(owner, fixture.household.id, '?limit=100').expect(200);

      expect(entryFor(response.body, plugin.slug)).toMatchObject({
        serverEnabled: true,
        scopeOrphaned: false,
        unit: { anchored: false, enabled: false, suspendedForConsent: false },
      });
    });

    it('flags a row whose plugin scope no longer admits the household axis (D-CF, #369)', async () => {
      const owner = await actors.user();
      const fixture = await actors.householdWithMembers({ owner });
      // Server-scope plugin the household nonetheless holds a row for: the
      // state a narrowing activation leaves behind, arranged directly.
      const plugin = await arrangePlugin({ scope: PluginScope.Server });
      await db.client.householdPlugin.create({
        data: { householdId: fixture.household.id, pluginId: plugin.id, enabled: true },
      });

      const response = await listHousehold(owner, fixture.household.id, '?limit=100').expect(200);

      expect(entryFor(response.body, plugin.slug)).toMatchObject({
        scopeOrphaned: true,
        unit: { anchored: true, enabled: true },
      });
    });

    it('serves no provenance, version or install history, and accepts no tombstone flag', async () => {
      const owner = await actors.user();
      const fixture = await actors.householdWithMembers({ owner });
      const plugin = await arrangePlugin({ scope: PluginScope.Household });

      const response = await listHousehold(owner, fixture.household.id, '?limit=100').expect(200);
      const entry = entryFor(response.body, plugin.slug);

      for (const field of ['provenance', 'version', 'installedAt', 'restartRequired', 'pendingUpdate', 'enabled']) {
        expect(entry).not.toHaveProperty(field);
      }

      await listHousehold(owner, fixture.household.id, '?includeUninstalled=true').expect(400);
    });
  });

  describe('GET /users/me/plugins', () => {
    it('is readable by any session user and narrows by no plugin scope (#225, D-CE)', async () => {
      const user = await actors.user();
      const serverScoped = await arrangePlugin({ scope: PluginScope.Server });

      const response = await listUser(user, '?limit=100').expect(200);

      // Server-scope plugins are addressable on this axis: user consent is
      // legal at any plugin scope, so there is no orphan state to report.
      expect(entryFor(response.body, serverScoped.slug)).toMatchObject({
        serverEnabled: true,
        unit: { anchored: false },
      });
      expect(entryFor(response.body, serverScoped.slug)).not.toHaveProperty('scopeOrphaned');
    });

    it('reflects an existing anchor', async () => {
      const user = await actors.user();
      const plugin = await arrangePlugin();
      await db.client.userPlugin.create({ data: { userId: user.user.id, pluginId: plugin.id, enabled: false } });

      const response = await listUser(user, '?limit=100').expect(200);

      expect(entryFor(response.body, plugin.slug)?.['unit']).toMatchObject({ anchored: true, enabled: false });
    });

    it('serves no provenance, version or install history, and accepts no tombstone flag', async () => {
      const user = await actors.user();
      const plugin = await arrangePlugin();

      const response = await listUser(user, '?limit=100').expect(200);
      const entry = entryFor(response.body, plugin.slug);

      for (const field of ['provenance', 'version', 'installedAt', 'restartRequired', 'pendingUpdate', 'enabled']) {
        expect(entry).not.toHaveProperty(field);
      }

      await listUser(user, '?includeUninstalled=true').expect(400);
    });

    it('is 401 unauthenticated', async () => {
      await request(baseUrl).get('/api/users/me/plugins').expect(401);
    });
  });
});
