import { PluginCategory, PluginGrantStatus, PluginScope, RiskLevel, type Plugin } from '@bge/database';
import { createActors, type Actors, type SessionActor } from '@bge/testing-e2e';
import { buildPluginManifest, type PluginManifest } from '@boardgamesempire/plugin-manifest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

/**
 * The wire half of #323: household and user unit enablement plus the
 * feature-state read (#60), over real rows. Pinned here: the inline-config
 * gate (409 with the retained document's issues[], 422 with the supplied
 * document's), the born-suspended creation and its late-acceptance
 * heal through decide(), the serving predicate (`enabled &&
 * !suspendedForConsent`) surviving an admin enable flip, the scope-coherence
 * refusal, the user axis's no-row 404 (decide() stays the only creator,
 * #225), and the feature read's reason/blockingSlugs pairing per unit
 * viewpoint.
 *
 * Plugin state is arranged directly on the rows (the install ingress is
 * #84's), same as the other C4 suites. Core checks reference SEEDED
 * permissions only: `read:household_member` (Low, household-conditioned)
 * and `update:user:profile:own` (Low, user-conditioned).
 */
describe('plugin unit enablement + feature state (#323)', () => {
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

  type Check = PluginManifest['permissions']['checks'][number];

  const MANAGE_DIGEST_CHECK: Check = {
    slug: 'manage:digest',
    required: true,
    reason: { en: 'Stores and manages the digest configuration it owns.' },
    consentScope: 'server',
  };

  /** REQUIRED household check bound to the fixture feature — the feature read and the born-suspended probe both key on it. */
  const HOUSEHOLD_CHECK: Check = {
    slug: 'read:household_member',
    required: true,
    reason: { en: 'Addresses the digest to the household roster.' },
    consentScope: 'household',
    feature: 'weekly-digest',
  };

  const USER_CHECK: Check = {
    slug: 'update:user:profile:own',
    required: false,
    reason: { en: 'Records each member’s digest delivery preference on their profile.' },
    consentScope: 'user',
  };

  const CONFIG_SCHEMA = {
    type: 'object',
    properties: { webhookUrl: { type: 'string' } },
    required: ['webhookUrl'],
  };

  const arrangePlugin = async (
    manifestOverrides: Parameters<typeof buildPluginManifest>[0] = {},
    rowOverrides: Record<string, unknown> = {},
  ): Promise<Plugin> => {
    const manifest = buildPluginManifest({
      scope: 'household',
      bgeCompat: '>=0.0.0',
      permissions: { checks: [MANAGE_DIGEST_CHECK, HOUSEHOLD_CHECK, USER_CHECK] },
      ...manifestOverrides,
    });

    const plugin = await db.client.plugin.create({
      data: {
        slug: manifest.slug,
        version: manifest.version,
        category: PluginCategory.FeedbackSink,
        scope: manifest.scope === 'server' ? PluginScope.Server : PluginScope.Household,
        manifestJson: manifest as never,
        enabled: true,
        bundled: false,
        installedSha256: randomUUID(),
        ...rowOverrides,
      },
    });
    await db.client.pluginPermission.create({
      data: { pluginId: plugin.id, slug: `plugin|${plugin.slug}|manage:digest`, riskLevel: RiskLevel.Low },
    });

    return plugin;
  };

  const hhPath = (householdId: string, slug: string, tail: string) =>
    `/api/households/${householdId}/plugins/${slug}/${tail}`;
  const userPath = (slug: string, tail: string) => `/api/users/me/plugins/${slug}/${tail}`;

  const enableHousehold = (
    actor: SessionActor,
    householdId: string,
    slug: string,
    body: Record<string, unknown> = {},
  ) =>
    request(baseUrl)
      .post(hhPath(householdId, slug, 'enable'))
      .set(actor.headers)
      .send(body);
  const disableHousehold = (actor: SessionActor, householdId: string, slug: string) =>
    request(baseUrl)
      .post(hhPath(householdId, slug, 'disable'))
      .set(actor.headers)
      .send({});
  const patchHouseholdConfig = (actor: SessionActor, householdId: string, slug: string, config: unknown) =>
    request(baseUrl)
      .patch(hhPath(householdId, slug, 'config'))
      .set(actor.headers)
      .send({ config });
  const readHouseholdFeatures = (actor: SessionActor, householdId: string, slug: string) =>
    request(baseUrl)
      .get(hhPath(householdId, slug, 'features'))
      .set(actor.headers);

  const enableUser = (actor: SessionActor, slug: string) =>
    request(baseUrl).post(userPath(slug, 'enable')).set(actor.headers).send({});
  const disableUser = (actor: SessionActor, slug: string) =>
    request(baseUrl).post(userPath(slug, 'disable')).set(actor.headers).send({});
  const readUserFeatures = (actor: SessionActor, slug: string) =>
    request(baseUrl).get(userPath(slug, 'features')).set(actor.headers);

  const decideHousehold = (actor: SessionActor, householdId: string, slug: string, body: Record<string, unknown>) =>
    request(baseUrl)
      .post(hhPath(householdId, slug, 'grants'))
      .set(actor.headers)
      .send(body);
  const decideUser = (actor: SessionActor, slug: string, body: Record<string, unknown>) =>
    request(baseUrl).post(userPath(slug, 'grants')).set(actor.headers).send(body);

  const unitRow = (householdId: string, pluginId: string) =>
    db.client.householdPlugin.findUnique({ where: { householdId_pluginId: { householdId, pluginId } } });

  describe('household enable/disable', () => {
    it('first enable creates the row; the admin switch round-trips; disable flips it back', async () => {
      const owner = await actors.user();
      const { household } = await actors.householdWithMembers({ owner });
      const plugin = await arrangePlugin();

      const enabled = await enableHousehold(owner, household.id, plugin.slug).expect(200);
      expect(enabled.body.unit).toMatchObject({ enabled: true, suspendedForConsent: false, config: {} });

      // Idempotent re-enable: same state back, still one row.
      await enableHousehold(owner, household.id, plugin.slug).expect(200);
      expect(await db.client.householdPlugin.count({ where: { pluginId: plugin.id } })).toBe(1);

      const disabled = await disableHousehold(owner, household.id, plugin.slug).expect(200);
      expect(disabled.body.unit.enabled).toBe(false);
      expect((await unitRow(household.id, plugin.id))?.enabled).toBe(false);
    });

    it('disable before any enable is a 404 — enable is the row creator', async () => {
      const owner = await actors.user();
      const { household } = await actors.householdWithMembers({ owner });
      const plugin = await arrangePlugin();

      const response = await disableHousehold(owner, household.id, plugin.slug).expect(404);
      expect(response.body.code).toBe('PluginUnitNotEnrolledError');
      expect(response.body.scopeType).toBe('Household');
    });

    it('authority: a plain member and an admin of ANOTHER household are refused; the row stays untouched', async () => {
      const owner = await actors.user();
      const member = await actors.user();
      const otherOwner = await actors.user();
      const { household } = await actors.householdWithMembers({
        owner,
        members: [{ actor: member, role: 'HouseholdMember' }],
      });
      await actors.householdWithMembers({ owner: otherOwner });
      const plugin = await arrangePlugin();

      await enableHousehold(member, household.id, plugin.slug).expect(403);
      await enableHousehold(otherOwner, household.id, plugin.slug).expect(403);
      expect(await unitRow(household.id, plugin.id)).toBeNull();
    });

    it('refuses the household surface for a server-scope plugin — scope coherence at the writer AND the feature read', async () => {
      const owner = await actors.user();
      const { household } = await actors.householdWithMembers({ owner });
      const plugin = await arrangePlugin({ scope: 'server', permissions: { checks: [MANAGE_DIGEST_CHECK] } });

      const response = await enableHousehold(owner, household.id, plugin.slug).expect(422);
      expect(response.body.code).toBe('PluginUnitScopeError');

      // The read refuses identically: a served-false body here would
      // present impossible unit state as a real degraded unit, and the
      // "enable it" lever the client offers from it would 422.
      const read = await readHouseholdFeatures(owner, household.id, plugin.slug).expect(422);
      expect(read.body.code).toBe('PluginUnitScopeError');
    });

    it('410s a tombstone and 404s an unknown slug', async () => {
      const owner = await actors.user();
      const { household } = await actors.householdWithMembers({ owner });
      const plugin = await arrangePlugin({}, { uninstalledAt: new Date(), enabled: false });

      const gone = await enableHousehold(owner, household.id, plugin.slug).expect(410);
      expect(gone.body.code).toBe('PluginUnitPluginTombstonedError');

      const missing = await enableHousehold(owner, household.id, 'no-such-plugin').expect(404);
      expect(missing.body.code).toBe('PluginUnitPluginNotFoundError');
    });
  });

  describe('born suspended over a durable required denial, healed by late acceptance', () => {
    it('a row created beside a required household denial starts suspended; the Granted flip re-enables it', async () => {
      const owner = await actors.user();
      const { household } = await actors.householdWithMembers({ owner });
      const plugin = await arrangePlugin();

      // The durable refusal lands first — rowless, so nothing suspends yet.
      await decideHousehold(owner, household.id, plugin.slug, {
        permissionSlug: 'read:household_member',
        status: PluginGrantStatus.Denied,
      }).expect(200);

      const enabled = await enableHousehold(owner, household.id, plugin.slug).expect(200);
      expect(enabled.body.unit).toMatchObject({ enabled: true, suspendedForConsent: true });
      expect(enabled.body.unit.suspendedAt).not.toBeNull();

      // The serving predicate holds: enabled by the admin, still not served.
      const blocked = await readHouseholdFeatures(owner, household.id, plugin.slug).expect(200);
      expect(blocked.body.featureState.served).toBe(false);

      // Late acceptance is the heal — the admin switch never was.
      await decideHousehold(owner, household.id, plugin.slug, {
        permissionSlug: 'read:household_member',
        status: PluginGrantStatus.Granted,
      }).expect(200);

      const row = await unitRow(household.id, plugin.id);
      expect(row).toMatchObject({ enabled: true, suspendedForConsent: false, suspendedAt: null });
    });

    it('a suspended unit stays suspended across an admin enable flip', async () => {
      const owner = await actors.user();
      const { household } = await actors.householdWithMembers({ owner });
      const plugin = await arrangePlugin();
      await db.client.householdPlugin.create({
        data: {
          householdId: household.id,
          pluginId: plugin.id,
          enabled: false,
          suspendedForConsent: true,
          suspendedAt: new Date(),
        },
      });

      const enabled = await enableHousehold(owner, household.id, plugin.slug).expect(200);
      expect(enabled.body.unit).toMatchObject({ enabled: true, suspendedForConsent: true });
    });
  });

  describe('the household config gate', () => {
    const requiringConfig = { config: { schema: CONFIG_SCHEMA, requiresHouseholdConfig: true } };

    it('enable without config 409s with empty issues when nothing is retained; inline config satisfies the gate', async () => {
      const owner = await actors.user();
      const { household } = await actors.householdWithMembers({ owner });
      const plugin = await arrangePlugin(requiringConfig);

      const refused = await enableHousehold(owner, household.id, plugin.slug).expect(409);
      expect(refused.body.code).toBe('PluginUnitConfigRequiredError');
      expect(refused.body.issues).toEqual([]);
      expect(await unitRow(household.id, plugin.id)).toBeNull();

      const enabled = await enableHousehold(owner, household.id, plugin.slug, {
        config: { webhookUrl: 'https://example.test/hook' },
      }).expect(200);
      expect(enabled.body.unit.config).toEqual({ webhookUrl: 'https://example.test/hook' });
    });

    it('schema-invalid inline config is a 422 carrying the validator issues[] (client renders the form from them)', async () => {
      const owner = await actors.user();
      const { household } = await actors.householdWithMembers({ owner });
      const plugin = await arrangePlugin(requiringConfig);

      const response = await enableHousehold(owner, household.id, plugin.slug, {
        config: { webhookUrl: 42 },
      }).expect(422);

      expect(response.body.code).toBe('PluginConfigValidationError');
      expect(response.body.issues).toEqual([expect.objectContaining({ path: '/webhookUrl', keyword: 'type' })]);
      expect(await unitRow(household.id, plugin.id)).toBeNull();
    });

    it('a RETAINED config that no longer satisfies the active schema fails the gate with its violations', async () => {
      const owner = await actors.user();
      const { household } = await actors.householdWithMembers({ owner });
      const plugin = await arrangePlugin(requiringConfig);
      // A disabled unit whose config predates the schema requirement — the
      // uninstall-retention / update shape.
      await db.client.householdPlugin.create({
        data: { householdId: household.id, pluginId: plugin.id, enabled: false, config: {} },
      });

      const refused = await enableHousehold(owner, household.id, plugin.slug).expect(409);
      expect(refused.body.code).toBe('PluginUnitConfigRequiredError');
      expect(refused.body.issues).toEqual([expect.objectContaining({ keyword: 'required' })]);
      expect((await unitRow(household.id, plugin.id))?.enabled).toBe(false);
    });

    it('idempotency outranks the gate: re-enabling an ALREADY-ENABLED unit with stale retained config stays 200', async () => {
      const owner = await actors.user();
      const { household } = await actors.householdWithMembers({ owner });
      const plugin = await arrangePlugin(requiringConfig);
      // An enabled, serving unit whose config predates the schema
      // requirement — a retry of a previously successful enable must not
      // 409 a unit that never left service.
      await db.client.householdPlugin.create({
        data: { householdId: household.id, pluginId: plugin.id, enabled: true, config: {} },
      });

      const response = await enableHousehold(owner, household.id, plugin.slug).expect(200);
      expect(response.body.unit).toMatchObject({ enabled: true });
    });

    it('config PATCH validates, persists last-writer-wins, and 404s a never-enabled household', async () => {
      const owner = await actors.user();
      const { household } = await actors.householdWithMembers({ owner });
      const plugin = await arrangePlugin(requiringConfig);

      await patchHouseholdConfig(owner, household.id, plugin.slug, { webhookUrl: 'x' }).expect(404);

      await enableHousehold(owner, household.id, plugin.slug, { config: { webhookUrl: 'https://a' } }).expect(200);

      const invalid = await patchHouseholdConfig(owner, household.id, plugin.slug, { webhookUrl: 7 }).expect(422);
      expect(invalid.body.issues).toHaveLength(1);

      const updated = await patchHouseholdConfig(owner, household.id, plugin.slug, {
        webhookUrl: 'https://b',
      }).expect(200);
      expect(updated.body.unit.config).toEqual({ webhookUrl: 'https://b' });
      expect((await unitRow(household.id, plugin.id))?.config).toEqual({ webhookUrl: 'https://b' });
    });

    it('an explicit config: null is a 400 at the pipe, while true absence still reaches the gate', async () => {
      const owner = await actors.user();
      const { household } = await actors.householdWithMembers({ owner });
      const plugin = await arrangePlugin(requiringConfig);

      // The wire is the only place these decorators run: the controller
      // specs call the methods directly and the service specs pass typed
      // inputs, so neither one executes the pipe. The enable DTO guards
      // `config` with ValidateIf rather than @IsOptional precisely because
      // @IsOptional waves null through, and the service treats "present"
      // as `!== undefined` — an explicit null would reach a non-nullable
      // Json column as a 500.
      await enableHousehold(owner, household.id, plugin.slug, { config: null }).expect(400);
      expect(await unitRow(household.id, plugin.id)).toBeNull();

      // ValidateIf's other half: absence is not a validation failure, so
      // the request reaches the config gate and is refused there instead.
      await enableHousehold(owner, household.id, plugin.slug).expect(409);

      await enableHousehold(owner, household.id, plugin.slug, {
        config: { webhookUrl: 'https://example.test/hook' },
      }).expect(200);

      // The PATCH DTO declares `config` required, so a null fails the same
      // way without needing ValidateIf.
      await patchHouseholdConfig(owner, household.id, plugin.slug, null).expect(400);
      expect((await unitRow(household.id, plugin.id))?.config).toEqual({ webhookUrl: 'https://example.test/hook' });
    });
  });

  describe('user enable/disable (#225: decide() stays the creator)', () => {
    it('404s with no anchor row, then round-trips the switch once a Granted decision created one', async () => {
      const user = await actors.user();
      const plugin = await arrangePlugin();

      const missing = await enableUser(user, plugin.slug).expect(404);
      expect(missing.body.code).toBe('PluginUnitNotEnrolledError');
      expect(missing.body.scopeType).toBe('User');

      await decideUser(user, plugin.slug, {
        permissionSlug: 'update:user:profile:own',
        status: PluginGrantStatus.Granted,
      }).expect(200);

      const disabled = await disableUser(user, plugin.slug).expect(200);
      expect(disabled.body.unit).toMatchObject({ enabled: false, suspendedForConsent: false });

      const enabled = await enableUser(user, plugin.slug).expect(200);
      expect(enabled.body.unit.enabled).toBe(true);
    });

    it('the user axis is a real surface on a SERVER-scope plugin — the switch and the read both work there', async () => {
      // The manifest gate refuses household consent on a server-scope
      // plugin but permits user consent at any scope (#225), and decide()
      // creates a real anchor there. So the household 422 must not
      // generalize to this axis: the user would be toggling a unit whose
      // blocked features they could never read.
      const user = await actors.user();
      const plugin = await arrangePlugin({
        scope: 'server',
        permissions: { checks: [MANAGE_DIGEST_CHECK, { ...USER_CHECK, required: true, feature: 'weekly-digest' }] },
      });

      // Readable before any anchor exists: never-enabled, not impossible.
      const rowless = await readUserFeatures(user, plugin.slug).expect(200);
      expect(rowless.body.featureState).toMatchObject({
        served: false,
        unit: { scopeType: 'User', userId: user.user.id },
      });

      await decideUser(user, plugin.slug, {
        permissionSlug: 'update:user:profile:own',
        status: PluginGrantStatus.Granted,
      }).expect(200);

      const served = await readUserFeatures(user, plugin.slug).expect(200);
      expect(served.body.featureState.served).toBe(true);

      await disableUser(user, plugin.slug).expect(200);
      expect((await readUserFeatures(user, plugin.slug).expect(200)).body.featureState.served).toBe(false);
    });
  });

  describe('feature-state read (#60)', () => {
    it('pairs each blocked feature with its reason AND the blocking slugs, per household viewpoint', async () => {
      const owner = await actors.user();
      const { household } = await actors.householdWithMembers({ owner });
      const plugin = await arrangePlugin();
      await enableHousehold(owner, household.id, plugin.slug).expect(200);

      // Nothing granted yet: the bound required household check is pending.
      const pending = await readHouseholdFeatures(owner, household.id, plugin.slug).expect(200);
      expect(pending.body.featureState).toMatchObject({
        plugin: { slug: plugin.slug },
        unit: { scopeType: 'Household', householdId: household.id },
        served: true,
        suspendedForConsent: false,
      });
      const digest = pending.body.featureState.features.find(
        (feature: { name: string }) => feature.name === 'weekly-digest',
      );
      expect(digest).toMatchObject({
        state: 'disabled',
        reason: 'pending',
        blockingSlugs: ['read:household_member'],
      });

      // A durable denial upgrades the reason — same pairing, actionable why.
      await decideHousehold(owner, household.id, plugin.slug, {
        permissionSlug: 'read:household_member',
        status: PluginGrantStatus.Denied,
      }).expect(200);

      const denied = await readHouseholdFeatures(owner, household.id, plugin.slug).expect(200);
      const deniedDigest = denied.body.featureState.features.find(
        (feature: { name: string }) => feature.name === 'weekly-digest',
      );
      expect(deniedDigest).toMatchObject({ reason: 'denied', blockingSlugs: ['read:household_member'] });
      // The required denial also suspended the unit — reported at the
      // unit level while the per-feature slot keeps the actionable reason.
      expect(denied.body.featureState).toMatchObject({ served: false, suspendedForConsent: true });
    });

    it('a household-consented check is per-unit from the USER viewpoint, never a false green or a false block', async () => {
      const user = await actors.user();
      const plugin = await arrangePlugin();
      await decideUser(user, plugin.slug, {
        permissionSlug: 'update:user:profile:own',
        status: PluginGrantStatus.Granted,
      }).expect(200);

      const response = await readUserFeatures(user, plugin.slug).expect(200);
      const digest = response.body.featureState.features.find(
        (feature: { name: string }) => feature.name === 'weekly-digest',
      );

      expect(digest).toMatchObject({ state: 'active', blockingSlugs: [], perUnitSlugs: ['read:household_member'] });
    });

    it('the read carries the status contract: 403 for an admin of another household, 404 unknown, 410 tombstone', async () => {
      const owner = await actors.user();
      const otherOwner = await actors.user();
      const { household } = await actors.householdWithMembers({ owner });
      await actors.householdWithMembers({ owner: otherOwner });
      const plugin = await arrangePlugin();

      await readHouseholdFeatures(otherOwner, household.id, plugin.slug).expect(403);
      await readHouseholdFeatures(owner, household.id, 'no-such-plugin').expect(404);

      await db.client.plugin.update({ where: { id: plugin.id }, data: { uninstalledAt: new Date() } });
      const gone = await readHouseholdFeatures(owner, household.id, plugin.slug).expect(410);
      expect(gone.body.code).toBe('PluginFeatureStateTombstonedError');
    });
  });
});
