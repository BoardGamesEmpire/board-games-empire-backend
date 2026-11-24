import type { Plugin } from '@bge/database';
import { PluginGrantScope, PluginGrantStatus, PluginScope, ResourceType, RiskLevel } from '@bge/database';
import type { Actors, SessionActor } from '@bge/testing-e2e';
import { createActors } from '@bge/testing-e2e';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Caller } from '../support/api-key';
import { mintApiKey } from '../support/api-key';
import { requireBaseUrl } from '../support/e2e-env';
import type { TestDatabase } from '../support/test-db';
import { createTestDatabase } from '../support/test-db';
import { arrangeInventoryPlugin } from './inventory-fixtures';
import type { Check } from './manifest-checks';
import { FIXTURE_ACT_ID } from './plugin-row-fixtures';

/**
 * The wire half of #354 — the only plugin reads that answer before a slug is
 * known. Pinned here: the column gate on the server surface (the one
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

  const arrangePlugin = (row: Record<string, unknown> = {}, checks: readonly Check[] = []): Promise<Plugin> =>
    arrangeInventoryPlugin(db.client, { row, checks });

  /**
   * REQUIRED at server scope. `read:safe_http_policy` is a seeded core
   * permission, Medium today; a consent decision recorded below that is a
   * risk rise, arranged on the decision because the catalog outlives each
   * test (#1336).
   */
  const POLICY_REQUIRED: Check = {
    slug: 'read:safe_http_policy',
    required: true,
    reason: { en: 'Inspects the outbound policy before scheduling digest delivery.' },
    consentScope: 'server',
  };

  /** A Server-unit consent decision, arranged on the row. */
  const seedServerDecision = (pluginId: string, permissionSlug: string, decidedRiskLevel: RiskLevel) =>
    db.client.pluginGrant.create({
      data: {
        pluginId,
        scopeType: PluginGrantScope.Server,
        scopeId: '',
        permissionSlug,
        status: PluginGrantStatus.Granted,
        actId: FIXTURE_ACT_ID,
        decidedAt: new Date(),
        decidedRiskLevel,
      },
    });

  /**
   * A plugin a household can hold a unit enablement under. The scope is the
   * manifest's, which the row's column follows: a row saying Household over a
   * manifest saying server describes no plugin an install can produce, and
   * its household units read `unavailable` (#1151).
   */
  const arrangeHouseholdPlugin = (): Promise<Plugin> =>
    arrangeInventoryPlugin(db.client, { manifest: { scope: 'household' } });

  const listServer = (actor: Caller, query = '') => request(baseUrl).get(`/api/plugins${query}`).set(actor.headers);
  const readOne = (actor: Caller, slug: string) => request(baseUrl).get(`/api/plugins/${slug}`).set(actor.headers);
  const listHousehold = (actor: Caller, householdId: string, query = '') =>
    request(baseUrl).get(`/api/households/${householdId}/plugins${query}`).set(actor.headers);
  const listUser = (actor: SessionActor, query = '') =>
    request(baseUrl).get(`/api/users/me/plugins${query}`).set(actor.headers);

  /** The entry for a specific slug — these reads enumerate, so never index by position. */
  const entryFor = (body: { plugins: Array<Record<string, unknown>> }, slug: string) =>
    body.plugins.find((entry) => entry['slug'] === slug);

  const slugsOf = (body: { plugins: Array<Record<string, unknown>> }) =>
    body.plugins.map((entry) => entry['slug'] as string).sort();

  const SERVER_READS: readonly { readonly name: string; readonly path: (slug: string) => string }[] = [
    { name: 'GET /plugins', path: () => '/api/plugins' },
    { name: 'GET /plugins/:slug', path: (slug) => `/api/plugins/${slug}` },
    { name: 'GET /plugins/:slug/consent', path: (slug) => `/api/plugins/${slug}/consent` },
    { name: 'GET /plugins/:slug/update/pending', path: (slug) => `/api/plugins/${slug}/update/pending` },
    { name: 'GET /plugins/:slug/features', path: (slug) => `/api/plugins/${slug}/features` },
  ];

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
      });
      // One provenance shape, with no kind to tell apart, because every plugin
      // is installed from a plugin artifact (#696).
      expect(entryFor(response.body, plugin.slug)?.['provenance']).toStrictEqual({
        sha256: 'a'.repeat(64),
        url: 'https://registry.test/fixture.tgz',
        registrySlug: null,
      });
    });

    it('the database refuses an installed checksum in any other form, so no row can fail the list (#1117)', async () => {
      // The read refuses a checksum that is not 64 lowercase hex characters,
      // and it maps every row, so one such row would fail the read for all.
      const plugin = await arrangePlugin();

      const failure = await db.client.plugin
        .update({ where: { id: plugin.id }, data: { installedSha256: 'A'.repeat(64) } })
        .catch((err: unknown) => err);

      // Prisma's driver adapter may put Postgres's words in the message, the
      // cause or the meta, so every own property is searched.
      const text = (value: unknown, depth = 0): string =>
        depth > 4 || value === null || value === undefined
          ? ''
          : typeof value !== 'object'
            ? String(value)
            : Object.getOwnPropertyNames(value)
                .map((key) => text((value as Record<string, unknown>)[key], depth + 1))
                .join(' ');

      expect(failure).toBeInstanceOf(Error);
      expect(text(failure)).toContain('plugins_installed_sha256_format');
      const row = await db.client.plugin.findUniqueOrThrow({ where: { id: plugin.id } });
      expect(row.installedSha256).toBe('a'.repeat(64));
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

    it("GET /api/plugins lists the Server unit's state and consent standing, and agrees with GET /api/plugins/:slug/features (#1336)", async () => {
      const admin = await actors.admin();
      // Granted at Low while the catalog says Medium today: the consent
      // decision no longer covers, so the Server unit owes a review.
      const plugin = await arrangePlugin({}, [POLICY_REQUIRED]);
      await seedServerDecision(plugin.id, `plugin|${plugin.slug}|manage:digest`, RiskLevel.Low);
      await seedServerDecision(plugin.id, POLICY_REQUIRED.slug, RiskLevel.Low);

      const list = await listServer(admin, '?limit=100').expect(200);
      const unit = entryFor(list.body, plugin.slug)?.['unit'];

      expect(unit).toEqual({
        state: 'review_pending',
        dormancy: null,
        consent: {
          outstanding: [
            expect.objectContaining({ slug: POLICY_REQUIRED.slug, kind: 'risk_raised', riskLevel: RiskLevel.Medium }),
          ],
          optionalOff: [],
        },
      });

      const features = await request(baseUrl)
        .get(`/api/plugins/${plugin.slug}/features`)
        .set(admin.headers)
        .expect(200);
      const { state, dormancy, consent } = features.body.featureState;

      expect(unit).toEqual({ state, dormancy, consent });

      const single = await readOne(admin, plugin.slug).expect(200);

      expect(single.body.plugin.unit).toEqual(unit);
    });

    it('a page holding a plugin whose stored manifest cannot be read still answers 200, and that row reads unavailable with nothing owed (#1336)', async () => {
      const admin = await actors.admin();
      const broken = await arrangePlugin();
      const sound = await arrangePlugin();
      await db.client.plugin.update({ where: { id: broken.id }, data: { manifestJson: { nonsense: true } } });

      const response = await listServer(admin, '?limit=100').expect(200);

      expect(entryFor(response.body, broken.slug)?.['unit']).toEqual({
        state: 'unavailable',
        dormancy: 'unavailable',
        consent: { outstanding: [], optionalOff: [] },
      });
      // The sound row's required manage:digest was never decided, so it owes
      // that and nothing else: the broken row takes nothing from it.
      expect(entryFor(response.body, sound.slug)?.['unit']).toMatchObject({
        state: 'review_pending',
        dormancy: null,
        consent: { outstanding: [expect.objectContaining({ kind: 'never_asked' })] },
      });
    });

    // The list is every installed plugin, and the caller's ceiling clips it.
    // Admin's reaches every row, so the key's scope is all that narrows it.
    it("narrows the list to the one plugin an API key's scope names", async () => {
      const admin = await actors.admin();
      const [scoped, other] = await Promise.all([arrangePlugin(), arrangePlugin()]);
      const key = await mintApiKey(baseUrl, db.client, admin, {
        slugs: ['read:plugin'],
        resourceType: ResourceType.Plugin,
        resourceId: scoped.id,
      });

      // The control: the key's owner lists both.
      const own = await listServer(admin, '?limit=100').expect(200);
      expect(slugsOf(own.body)).toEqual(expect.arrayContaining([scoped.slug, other.slug]));

      const response = await listServer(key, '?limit=100').expect(200);
      expect(slugsOf(response.body)).toEqual([scoped.slug]);
      expect(response.body.pagination.total).toBe(1);
    });

    // The pinned grant passes the gate, and the identity-column grant beside
    // it reads every installed plugin. The ceiling comes from the rules that
    // read the gate's column, so the second adds nothing.
    it('keeps a key to its pinned plugin when it also holds the identity-column grant', async () => {
      const admin = await actors.admin();
      const [scoped, other] = await Promise.all([arrangePlugin(), arrangePlugin()]);
      const key = await mintApiKey(baseUrl, db.client, admin, [
        { slugs: ['read:plugin'], resourceType: ResourceType.Plugin, resourceId: scoped.id },
        { slugs: ['read:plugin:installed'], resourceType: ResourceType.Plugin },
      ]);

      // The control: the key's owner lists both.
      const own = await listServer(admin, '?limit=100').expect(200);
      expect(slugsOf(own.body)).toEqual(expect.arrayContaining([scoped.slug, other.slug]));

      const response = await listServer(key, '?limit=100').expect(200);
      expect(slugsOf(response.body)).toEqual([scoped.slug]);
      expect(response.body.pagination.total).toBe(1);
    });
  });

  // Every user holds `read:plugin:installed` for the unit lists, and a bare
  // type check would pass on it. The server reads serve what that grant's
  // field list leaves out, so they gate on one of those columns instead.
  describe('the server reads refuse the grant every user holds', () => {
    const statuses = async (actor: Caller, slug: string): Promise<Record<string, number>> => {
      const answered: Record<string, number> = {};

      for (const route of SERVER_READS) {
        answered[route.name] = (await request(baseUrl).get(route.path(slug)).set(actor.headers)).status;
      }

      return answered;
    };

    it('answers 403 to a plain user on all five', async () => {
      const user = await actors.user();
      const plugin = await arrangePlugin();

      // The control: the user does hold a rule on Plugin, so the refusals below
      // are the column gate's and not a missing grant's.
      const own = await listUser(user, '?limit=100').expect(200);
      expect(entryFor(own.body, plugin.slug)).toBeDefined();

      await expect(statuses(user, plugin.slug)).resolves.toEqual(
        Object.fromEntries(SERVER_READS.map((route) => [route.name, 403])),
      );
    });

    // Nothing is staged, so the pending read is the service's 409.
    const PASSED = {
      'GET /plugins': 200,
      'GET /plugins/:slug': 200,
      'GET /plugins/:slug/consent': 200,
      'GET /plugins/:slug/update/pending': 409,
      'GET /plugins/:slug/features': 200,
    };

    it('lets Admin through on all five', async () => {
      const admin = await actors.admin();
      const plugin = await arrangePlugin();

      await expect(statuses(admin, plugin.slug)).resolves.toEqual(PASSED);
    });

    // An API key is held to its grant's field list as a user is. Without that,
    // a staff member's key holding only the grant every user holds passed on
    // its owner's say, and read what the grant leaves out.
    it("answers 403 to an Admin's key that holds only the grant every user holds", async () => {
      const admin = await actors.admin();
      const plugin = await arrangePlugin();
      const keyFor = (slug: string) =>
        mintApiKey(baseUrl, db.client, admin, { slugs: [slug], resourceType: ResourceType.Plugin });

      // The control: a key on the unfielded grant passes, so the refusals below
      // are the field list's and not every key's.
      await expect(statuses(await keyFor('read:plugin'), plugin.slug)).resolves.toEqual(PASSED);

      await expect(statuses(await keyFor('read:plugin:installed'), plugin.slug)).resolves.toEqual(
        Object.fromEntries(SERVER_READS.map((route) => [route.name, 403])),
      );
    });
  });

  /**
   * The read gate is type-level, so a key whose `read:plugin` is pinned to one
   * plugin passes it on every slug, and the services read by slug alone. Each
   * route now resolves its slug under the actor's ceiling first, and answers
   * a plugin outside the key's scope exactly as it answers a slug never
   * installed: same status, same code. That holds whatever state the other
   * plugin is in, since the check runs before the service draws its 410 or
   * 409.
   */
  describe('a key scoped to one plugin (#789)', () => {
    const SINGLE_READS = SERVER_READS.filter((route) => route.name !== 'GET /plugins');

    const answers = async (actor: Caller, slug: string): Promise<Record<string, [number, unknown]>> => {
      const answered: Record<string, [number, unknown]> = {};

      for (const route of SINGLE_READS) {
        const response = await request(baseUrl).get(route.path(slug)).set(actor.headers);
        answered[route.name] = [response.status, response.body.code];
      }

      return answered;
    };

    const statusesOf = (answered: Record<string, [number, unknown]>) =>
      Object.values(answered).map(([status]) => status);

    /** `read:plugin`, pinned to `scoped` when it is given. */
    const readKey = (owner: SessionActor, scoped?: Plugin) =>
      mintApiKey(baseUrl, db.client, owner, {
        slugs: ['read:plugin'],
        resourceType: ResourceType.Plugin,
        resourceId: scoped?.id,
      });

    it('answers 404 on the four single reads for any other plugin, whatever its state', async () => {
      const admin = await actors.admin();
      const [scoped, live, gone, staged] = await Promise.all([
        arrangePlugin(),
        arrangePlugin(),
        arrangePlugin({ uninstalledAt: new Date() }),
        arrangeInventoryPlugin(db.client, { stagedVersion: '9.9.9' }),
      ]);
      const key = await readKey(admin, scoped);
      const missing = `missing-${randomUUID()}`;

      // What each route answers a slug never installed: its own code, the one
      // its service draws for an unknown slug.
      const unknown = await answers(admin, missing);
      expect(unknown).toEqual({
        'GET /plugins/:slug': [404, 'PLUGIN_INVENTORY_NOT_FOUND'],
        'GET /plugins/:slug/consent': [404, 'PLUGIN_CONSENT_PRESENTATION_NOT_FOUND'],
        'GET /plugins/:slug/update/pending': [404, 'PLUGIN_UPDATE_PLUGIN_NOT_FOUND'],
        'GET /plugins/:slug/features': [404, 'PLUGIN_FEATURE_STATE_NOT_FOUND'],
      });

      // The controls: the key reads its own plugin, and an unpinned key from
      // the same owner reads the others in their states, so the 404s below
      // are the pin's.
      expect(statusesOf(await answers(key, scoped.slug))).toEqual([200, 200, 409, 200]);
      const unpinned = await readKey(admin);
      expect(statusesOf(await answers(unpinned, live.slug))).toEqual([200, 200, 409, 200]);
      await readOne(unpinned, gone.slug).expect(410);
      await request(baseUrl).get(`/api/plugins/${staged.slug}/update/pending`).set(unpinned.headers).expect(200);

      const others = { missing, live: live.slug, gone: gone.slug, staged: staged.slug };
      const answered: Record<string, unknown> = {};
      for (const [state, slug] of Object.entries(others)) {
        answered[state] = await answers(key, slug);
      }

      expect(answered).toEqual(Object.fromEntries(Object.keys(others).map((state) => [state, unknown])));
    });

    // The pinned grant passes the gate, and the identity-column grant beside
    // it reads every row. The ceiling comes from the rules that read the
    // gate's column, as the list's does, so the second adds nothing.
    it('keeps a key to its scoped plugin when it also holds the identity-column grant', async () => {
      const admin = await actors.admin();
      const [scoped, live] = await Promise.all([arrangePlugin(), arrangePlugin()]);
      const key = await mintApiKey(baseUrl, db.client, admin, [
        { slugs: ['read:plugin'], resourceType: ResourceType.Plugin, resourceId: scoped.id },
        { slugs: ['read:plugin:installed'], resourceType: ResourceType.Plugin },
      ]);

      // The control: the key reads its own plugin.
      await readOne(key, scoped.slug).expect(200);

      expect(statusesOf(await answers(key, live.slug))).toEqual([404, 404, 404, 404]);
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
      expect(missing.body.code).toBe('PLUGIN_INVENTORY_NOT_FOUND');

      await readOne(user, plugin.slug).expect(403);
    });

    it('is 410 for a tombstone, with no flag able to override it (D-CH)', async () => {
      const admin = await actors.admin();
      const plugin = await arrangePlugin({ uninstalledAt: new Date() });

      const gone = await readOne(admin, plugin.slug).expect(410);
      expect(gone.body.code).toBe('PLUGIN_INVENTORY_TOMBSTONED');
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
      expect(response.body.code).toBe('PLUGIN_INVENTORY_MANIFEST');
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

    it('lists a household-scope plugin with no unit enablement, with no dormancy: the row set is plugin-driven (#1151)', async () => {
      const owner = await actors.user();
      const fixture = await actors.householdWithMembers({ owner });
      // A household with no unit enablement is judged on `{}`, which the
      // fixture's schema accepts, so nothing stands in the way but the switch.
      const plugin = await arrangeInventoryPlugin(db.client, { manifest: { scope: 'household' } });

      const response = await listHousehold(owner, fixture.household.id, '?limit=100').expect(200);

      expect(entryFor(response.body, plugin.slug)).toMatchObject({
        serverEnabled: true,
        unit: {
          anchored: false,
          enabled: false,
          state: 'off',
          dormancy: null,
          consent: { outstanding: expect.any(Array), optionalOff: expect.any(Array) },
        },
      });
      // Dormancy is reported through `unit.state` and `unit.dormancy`, never
      // as a stored reason (#1149, #1151).
      expect(entryFor(response.body, plugin.slug)).not.toHaveProperty('dormantReason');
    });

    /**
     * The two causes of dormancy, each arranged as the cause itself: a unit
     * enablement on a plugin whose manifest has no household surface, and one
     * holding a document the active schema rejects. Nothing about dormancy is
     * written to the unit enablement; the read works it out (#1151).
     */
    const REQUIRING_SCHEMA = {
      type: 'object',
      properties: { webhookUrl: { type: 'string' } },
      required: ['webhookUrl'],
    };

    const arrangeDormantUnits = async (householdId: string, enabled: boolean) => {
      const serverScoped = await arrangeInventoryPlugin(db.client);
      const rejectedConfig = await arrangeInventoryPlugin(db.client, {
        manifest: { scope: 'household', config: { schema: REQUIRING_SCHEMA, requiresHouseholdConfig: false } },
      });

      await db.client.householdPlugin.create({ data: { householdId, pluginId: serverScoped.id, enabled } });
      await db.client.householdPlugin.create({
        data: { householdId, pluginId: rejectedConfig.id, enabled, config: { webhookUrl: 42 } },
      });

      return { serverScoped, rejectedConfig };
    };

    it('reports unavailable for a unit enablement on a server-scope plugin and needs_configuration for one whose document the schema rejects (#1151)', async () => {
      const owner = await actors.user();
      const fixture = await actors.householdWithMembers({ owner });
      const { serverScoped, rejectedConfig } = await arrangeDormantUnits(fixture.household.id, true);

      const response = await listHousehold(owner, fixture.household.id, '?limit=100').expect(200);

      expect(entryFor(response.body, serverScoped.slug)).toMatchObject({
        // The admin's own switch stays as they left it, so a re-scope back
        // restores their choice rather than a default (#369).
        unit: { anchored: true, enabled: true, state: 'unavailable', dormancy: 'unavailable' },
      });
      expect(entryFor(response.body, rejectedConfig.slug)).toMatchObject({
        unit: { anchored: true, enabled: true, state: 'needs_configuration', dormancy: 'needs_configuration' },
      });
    });

    it('reports off with the dormancy that would refuse a switch-on (#1151)', async () => {
      // `off` outranks dormancy in `state`, and `dormancy` ignores the switch,
      // so a client can say why switching on would not help before the admin
      // tries it.
      const owner = await actors.user();
      const fixture = await actors.householdWithMembers({ owner });
      const { serverScoped, rejectedConfig } = await arrangeDormantUnits(fixture.household.id, false);

      const response = await listHousehold(owner, fixture.household.id, '?limit=100').expect(200);

      expect(entryFor(response.body, serverScoped.slug)).toMatchObject({
        unit: { anchored: true, enabled: false, state: 'off', dormancy: 'unavailable' },
      });
      expect(entryFor(response.body, rejectedConfig.slug)).toMatchObject({
        unit: { anchored: true, enabled: false, state: 'off', dormancy: 'needs_configuration' },
      });
    });

    it('serves no provenance, version or install history, and accepts no tombstone flag', async () => {
      const owner = await actors.user();
      const fixture = await actors.householdWithMembers({ owner });
      const plugin = await arrangeHouseholdPlugin();

      const response = await listHousehold(owner, fixture.household.id, '?limit=100').expect(200);
      const entry = entryFor(response.body, plugin.slug);

      for (const field of ['provenance', 'version', 'installedAt', 'restartRequired', 'pendingUpdate', 'enabled']) {
        expect(entry).not.toHaveProperty(field);
      }

      await listHousehold(owner, fixture.household.id, '?includeUninstalled=true').expect(400);
    });

    // A plugin whose scope has no household axis is listed by THIS
    // household's row of it. Another household's row must not list it here.
    it('leaves out a server-scope plugin that only another household holds a row for', async () => {
      const [owner, otherOwner] = await Promise.all([actors.user(), actors.user()]);
      const [fixture, otherFixture] = await Promise.all([
        actors.householdWithMembers({ owner }),
        actors.householdWithMembers({ owner: otherOwner }),
      ]);
      const plugin = await arrangePlugin({ scope: PluginScope.Server });
      await db.client.householdPlugin.create({
        data: { householdId: otherFixture.household.id, pluginId: plugin.id, enabled: true },
      });

      const response = await listHousehold(owner, fixture.household.id, '?limit=100').expect(200);
      expect(entryFor(response.body, plugin.slug)).toBeUndefined();

      // The control: the household that holds the row lists it.
      const others = await listHousehold(otherOwner, otherFixture.household.id, '?limit=100').expect(200);
      expect(entryFor(others.body, plugin.slug)).toBeDefined();
    });

    /**
     * Owned by Admin, so the instance check admits the household whatever its
     * state: a deleted household drops out of a member's graph and a member's
     * key would meet 403 there instead. The key reads no households, so the
     * route's liveness guard lets it through, and the list checks liveness
     * itself. It answers such a key 403, as the writes' re-check does, so the
     * key is not told which household was deleted.
     */
    describe("through a staff member's API key", () => {
      const keyOf = (owner: SessionActor, pluginId?: string) =>
        mintApiKey(baseUrl, db.client, owner, [
          { slugs: ['read:plugin:household'], resourceType: ResourceType.HouseholdPlugin },
          { slugs: ['read:plugin:installed'], resourceType: ResourceType.Plugin, resourceId: pluginId },
        ]);

      it('narrows the list to the one plugin its scope names, and refuses it once the household is deleted', async () => {
        const admin = await actors.admin();
        const { household } = await actors.householdWithMembers({ owner: await actors.user() });
        const [scoped, other] = await Promise.all([arrangeHouseholdPlugin(), arrangeHouseholdPlugin()]);

        // The control: unpinned, the key lists both.
        const unpinned = await listHousehold(await keyOf(admin), household.id, '?limit=100').expect(200);
        expect(slugsOf(unpinned.body)).toEqual(expect.arrayContaining([scoped.slug, other.slug]));

        const key = await keyOf(admin, scoped.id);
        const pinned = await listHousehold(key, household.id, '?limit=100').expect(200);
        expect(slugsOf(pinned.body)).toEqual([scoped.slug]);
        expect(pinned.body.pagination.total).toBe(1);

        await db.client.household.update({ where: { id: household.id }, data: { deletedAt: new Date() } });

        await listHousehold(key, household.id).expect(403);
      });

      // The single reads have no write to re-check liveness in either, so they
      // check it as the list does, and answer the same 403.
      it('refuses the consent and feature-state reads once the household is deleted (#790)', async () => {
        const admin = await actors.admin();
        const { household } = await actors.householdWithMembers({ owner: await actors.user() });
        const plugin = await arrangeHouseholdPlugin();
        const key = await keyOf(admin);
        const reads = (path: string) =>
          request(baseUrl).get(`/api/households/${household.id}/plugins/${plugin.slug}/${path}`).set(key.headers);

        // The control: the household is live, so the key reads both.
        await reads('consent').expect(200);
        await reads('features').expect(200);

        await db.client.household.update({ where: { id: household.id }, data: { deletedAt: new Date() } });

        await reads('consent').expect(403);
        await reads('features').expect(403);
      });

      // The rows are plugins. A key with no rule on them is refused, not served
      // an empty page.
      it('refuses a key that reads household plugins but not plugins', async () => {
        const admin = await actors.admin();
        const { household } = await actors.householdWithMembers({ owner: await actors.user() });
        const key = await mintApiKey(baseUrl, db.client, admin, {
          slugs: ['read:plugin:household'],
          resourceType: ResourceType.HouseholdPlugin,
        });

        await listHousehold(key, household.id).expect(403);
      });
    });
  });

  describe('GET /users/me/plugins', () => {
    it('is readable by any session user and narrows by no plugin scope (#225, D-CE)', async () => {
      const user = await actors.user();
      const serverScoped = await arrangePlugin({ scope: PluginScope.Server });

      const response = await listUser(user, '?limit=100').expect(200);

      // Server-scope plugins are addressable on this axis: user consent is
      // legal at any plugin scope, so a user unit on one has no dormancy
      // (#1151).
      expect(entryFor(response.body, serverScoped.slug)).toMatchObject({
        serverEnabled: true,
        unit: { anchored: false, dormancy: null },
      });
      expect(entryFor(response.body, serverScoped.slug)).not.toHaveProperty('dormantReason');
    });

    it('reflects an existing anchor', async () => {
      const user = await actors.user();
      const plugin = await arrangePlugin();
      await db.client.userPlugin.create({ data: { userId: user.user.id, pluginId: plugin.id, enabled: false } });

      const response = await listUser(user, '?limit=100').expect(200);

      expect(entryFor(response.body, plugin.slug)?.['unit']).toMatchObject({ anchored: true, enabled: false });
    });

    it("does not report another user's anchor as the caller's", async () => {
      const [user, other] = await Promise.all([actors.user(), actors.user()]);
      const plugin = await arrangePlugin();
      await db.client.userPlugin.create({ data: { userId: other.user.id, pluginId: plugin.id, enabled: true } });

      const response = await listUser(user, '?limit=100').expect(200);

      expect(entryFor(response.body, plugin.slug)?.['unit']).toMatchObject({ anchored: false, enabled: false });
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
