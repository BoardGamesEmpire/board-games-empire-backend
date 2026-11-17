import { PluginGrantScope, PluginGrantStatus, PluginScope, RiskLevel, type Plugin } from '@bge/database';
import { createActors, type Actors, type SessionActor } from '@bge/testing-e2e';
import { buildPluginManifest, type PluginManifest } from '@boardgamesempire/plugin-manifest';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { readConsentSurface, sendSwitchOn, switchOnBody } from './consent-act-fixtures';
import { pluginAbilitySlugsForHousehold } from './plugin-ability-fixtures';
import { FIXTURE_ACT_ID, pluginRowData } from './plugin-row-fixtures';

/**
 * The wire half of #323: household and user unit enablement plus the
 * feature-state read (#60), over real rows. Pinned here: the inline-config
 * gate (409 with the retained document's issues[], 422 with the supplied
 * document's), the scope-coherence refusal, the user axis's no-row 404 on
 * disable (the switch-on is the creator, #1150), and the feature read's
 * reason/blockingSlugs pairing per unit viewpoint. A household or user is
 * switched on by a switch-on consent act (#1150), its body built from the
 * consent surface.
 *
 * Plugin state is arranged directly on the rows (the install ingress is
 * #84's), same as the other C4 suites. Core checks reference SEEDED
 * permissions only: `read:game:public` and `read:game_collection:public`
 * (both Low), allowlisted public reads a household and a user may consent
 * to (#591).
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

  /**
   * REQUIRED household check bound to the fixture feature — the feature read and the consent-standing probe both key on it.
   * An allowlisted public read, which a household-scope consent may hold (#591).
   */
  const HOUSEHOLD_CHECK: Check = {
    slug: 'read:game:public',
    required: true,
    reason: { en: 'Lists the public games the household digest features.' },
    consentScope: 'household',
    feature: 'weekly-digest',
  };

  /** An allowlisted public read, which a user-scope consent may hold (#591). */
  const USER_CHECK: Check = {
    slug: 'read:game_collection:public',
    required: false,
    reason: { en: 'Shows public collections in each member’s digest.' },
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
      data: pluginRowData({
        slug: manifest.slug,
        version: manifest.version,
        scope: manifest.scope === 'server' ? PluginScope.Server : PluginScope.Household,
        manifestJson: manifest as never,
        enabled: true,
        ...rowOverrides,
      }),
    });
    await db.client.pluginPermission.create({
      data: { pluginId: plugin.id, slug: `plugin|${plugin.slug}|manage:digest`, riskLevel: RiskLevel.Low },
    });

    return plugin;
  };

  const hhPath = (householdId: string, slug: string, tail: string) =>
    `/api/households/${householdId}/plugins/${slug}/${tail}`;
  const userPath = (slug: string, tail: string) => `/api/users/me/plugins/${slug}/${tail}`;

  /**
   * A household switch-on (#1150) that grants the required household check,
   * its body built from the consent surface `options.surfaceFrom` read: by
   * default the plugin's own, read by the acting admin. A refused actor, a
   * tombstone or an unknown slug has no consent surface of its own to read, so
   * those tests name the surface the body is built from.
   */
  const enableHousehold = (
    actor: SessionActor,
    householdId: string,
    slug: string,
    options: {
      readonly config?: Record<string, unknown> | null;
      readonly surfaceFrom?: { readonly reader: SessionActor; readonly slug?: string };
    } = {},
  ) => ({
    // Shaped like a supertest chain so call sites keep `.expect(status)`; the
    // consent surface is read first, inside it.
    expect: async (status: number) => {
      const unit = { householdId };
      const surface = await readConsentSurface(
        baseUrl,
        options.surfaceFrom?.reader ?? actor,
        unit,
        options.surfaceFrom?.slug ?? slug,
      );
      const requiredHere = surface.checks.some((check) => check.slug === HOUSEHOLD_CHECK.slug && check.decidableByUnit);
      const body = switchOnBody(surface, requiredHere ? { [HOUSEHOLD_CHECK.slug]: PluginGrantStatus.Granted } : {});

      return sendSwitchOn(
        baseUrl,
        actor,
        unit,
        slug,
        options.config === undefined ? body : { ...body, config: options.config },
      ).expect(status);
    },
  });
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

  /** A user switch-on (#1150) answering the given permissions, built from the user's own consent surface. */
  const enableUser = (
    actor: SessionActor,
    slug: string,
    answers: Readonly<Record<string, typeof PluginGrantStatus.Granted | typeof PluginGrantStatus.Denied>> = {},
  ) => ({
    expect: async (status: number) => {
      const surface = await readConsentSurface(baseUrl, actor, 'me', slug);

      return sendSwitchOn(baseUrl, actor, 'me', slug, switchOnBody(surface, answers)).expect(status);
    },
  });
  const disableUser = (actor: SessionActor, slug: string) =>
    request(baseUrl).post(userPath(slug, 'disable')).set(actor.headers).send({});
  const readUserFeatures = (actor: SessionActor, slug: string) =>
    request(baseUrl).get(userPath(slug, 'features')).set(actor.headers);

  /**
   * A household consent decision written on the rows. Used only for a state
   * no consent act leaves (#1150) but an update can: a household switched on
   * whose required permission is refused, or not yet answered.
   */
  const arrangeHouseholdDecision = (
    householdId: string,
    pluginId: string,
    permissionSlug: string,
    status: PluginGrantStatus,
  ) =>
    db.client.pluginGrant.create({
      data: {
        pluginId,
        scopeType: PluginGrantScope.Household,
        scopeId: householdId,
        permissionSlug,
        status,
        actId: FIXTURE_ACT_ID,
        decidedAt: new Date(),
        decidedRiskLevel: RiskLevel.Low,
      },
    });

  const unitRow = (householdId: string, pluginId: string) =>
    db.client.householdPlugin.findUnique({ where: { householdId_pluginId: { householdId, pluginId } } });

  describe('household enable/disable', () => {
    it('first enable creates the row; the admin switch round-trips; disable flips it back', async () => {
      const owner = await actors.user();
      const { household } = await actors.householdWithMembers({ owner });
      const plugin = await arrangePlugin();

      const enabled = await enableHousehold(owner, household.id, plugin.slug).expect(200);
      expect(enabled.body.unit).toMatchObject({ enabled: true, config: {} });

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
      expect(response.body.code).toBe('PLUGIN_UNIT_NOT_ENROLLED');
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

      // Neither can be refused before the body is built, so it is built from
      // the household admin's consent surface.
      await enableHousehold(member, household.id, plugin.slug, { surfaceFrom: { reader: owner } }).expect(403);
      await enableHousehold(otherOwner, household.id, plugin.slug, { surfaceFrom: { reader: owner } }).expect(403);
      expect(await unitRow(household.id, plugin.id)).toBeNull();
      expect(await db.client.pluginConsentAct.count({ where: { pluginId: plugin.id } })).toBe(0);
    });

    it('refuses the household surface for a server-scope plugin — scope coherence at the writer AND the feature read', async () => {
      const owner = await actors.user();
      const { household } = await actors.householdWithMembers({ owner });
      const plugin = await arrangePlugin({ scope: 'server', permissions: { checks: [MANAGE_DIGEST_CHECK] } });

      const response = await enableHousehold(owner, household.id, plugin.slug).expect(422);
      expect(response.body.code).toBe('PLUGIN_UNIT_SCOPE');

      // The read refuses identically: a served-false body here would
      // present impossible unit state as a real degraded unit, and the
      // "enable it" lever the client offers from it would 422.
      const read = await readHouseholdFeatures(owner, household.id, plugin.slug).expect(422);
      expect(read.body.code).toBe('PLUGIN_UNIT_SCOPE');
    });

    /**
     * A unit enablement a re-scope to server left behind is dormant, and
     * #354's list puts it in front of the household admin, so the one lever
     * they could sensibly pull has to work, while the two writers that would
     * have to invent a surface keep refusing. The plugin's manifest is the
     * cause; nothing about dormancy is written to the unit enablement (#1151).
     */
    it('lets an admin switch off a unit on a re-scoped plugin, and nothing else (#1151)', async () => {
      const owner = await actors.user();
      const { household } = await actors.householdWithMembers({ owner });
      const plugin = await arrangePlugin({ scope: 'server', permissions: { checks: [MANAGE_DIGEST_CHECK] } });
      await db.client.householdPlugin.create({
        data: { householdId: household.id, pluginId: plugin.id, enabled: true },
      });

      const disabled = await disableHousehold(owner, household.id, plugin.slug).expect(200);
      expect(disabled.body.unit).toMatchObject({ enabled: false });
      expect(await unitRow(household.id, plugin.id)).toMatchObject({ enabled: false, config: {} });

      // The dormancy survives the switch: the two are independent, so the
      // list still says why switching on again would not help.
      const listed = await request(baseUrl)
        .get(`/api/households/${household.id}/plugins?limit=100`)
        .set(owner.headers)
        .expect(200);
      const entry = listed.body.plugins.find((candidate: { slug: string }) => candidate.slug === plugin.slug);
      expect(entry).toMatchObject({ unit: { anchored: true, enabled: false, state: 'off', dormancy: 'unavailable' } });

      const enabled = await enableHousehold(owner, household.id, plugin.slug).expect(422);
      expect(enabled.body.code).toBe('PLUGIN_UNIT_SCOPE');
      const patched = await patchHouseholdConfig(owner, household.id, plugin.slug, {
        webhookUrl: 'https://example.test/hook',
      }).expect(422);
      expect(patched.body.code).toBe('PLUGIN_UNIT_SCOPE');
    });

    it('410s a tombstone and 404s an unknown slug', async () => {
      const owner = await actors.user();
      const { household } = await actors.householdWithMembers({ owner });
      const plugin = await arrangePlugin();
      // Neither a tombstone nor an unknown slug has a consent surface to read
      // (#1150), so both bodies are built from the one the plugin showed
      // while it was installed.
      const surface = await readConsentSurface(baseUrl, owner, { householdId: household.id }, plugin.slug);
      const body = switchOnBody(surface, { [HOUSEHOLD_CHECK.slug]: PluginGrantStatus.Granted });

      await db.client.plugin.update({ where: { id: plugin.id }, data: { uninstalledAt: new Date(), enabled: false } });

      const gone = await sendSwitchOn(baseUrl, owner, { householdId: household.id }, plugin.slug, body).expect(410);
      expect(gone.body.code).toBe('PLUGIN_UNIT_PLUGIN_TOMBSTONED');

      const missing = await sendSwitchOn(baseUrl, owner, { householdId: household.id }, 'no-such-plugin', body).expect(
        404,
      );
      expect(missing.body.code).toBe('PLUGIN_UNIT_PLUGIN_NOT_FOUND');
    });
  });

  describe('the household config gate', () => {
    const requiringConfig = { config: { schema: CONFIG_SCHEMA, requiresHouseholdConfig: true } };

    it('enable without config 409s with empty issues when nothing is retained; inline config satisfies the gate', async () => {
      const owner = await actors.user();
      const { household } = await actors.householdWithMembers({ owner });
      const plugin = await arrangePlugin(requiringConfig);

      const refused = await enableHousehold(owner, household.id, plugin.slug).expect(409);
      expect(refused.body.code).toBe('PLUGIN_UNIT_CONFIG_REQUIRED');
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

      expect(response.body.code).toBe('PLUGIN_CONFIG_VALIDATION');
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
      expect(refused.body.code).toBe('PLUGIN_UNIT_CONFIG_REQUIRED');
      expect(refused.body.issues).toEqual([expect.objectContaining({ keyword: 'required' })]);
      expect((await unitRow(household.id, plugin.id))?.enabled).toBe(false);
    });

    it('a switch-on sent again for a unit already on whose retained document no longer conforms is refused with the violations, not answered as changing nothing (#1151)', async () => {
      const owner = await actors.user();
      const { household } = await actors.householdWithMembers({ owner });
      const plugin = await arrangePlugin(requiringConfig);
      // Switched on, its decision standing, holding a document that predates
      // the schema's requirement: the read reports it needs_configuration, so
      // a switch-on answering "nothing to change" would tell the admin the
      // unit runs when it does not (#1151).
      await arrangeHouseholdDecision(household.id, plugin.id, HOUSEHOLD_CHECK.slug, PluginGrantStatus.Granted);
      await db.client.householdPlugin.create({
        data: { householdId: household.id, pluginId: plugin.id, enabled: true, config: {} },
      });
      const before = await unitRow(household.id, plugin.id);

      const refused = await enableHousehold(owner, household.id, plugin.slug).expect(409);
      expect(refused.body.code).toBe('PLUGIN_UNIT_CONFIG_REQUIRED');
      expect(refused.body.issues).toEqual([expect.objectContaining({ keyword: 'required' })]);
      expect(await unitRow(household.id, plugin.id)).toEqual(before);
      expect(await db.client.pluginConsentAct.count({ where: { pluginId: plugin.id } })).toBe(0);

      // The control: once the household writes a conforming document, the
      // same switch-on is the one that changes nothing again.
      await patchHouseholdConfig(owner, household.id, plugin.slug, { webhookUrl: 'https://example.test/hook' }).expect(
        200,
      );
      const again = await enableHousehold(owner, household.id, plugin.slug).expect(200);
      expect(again.body).toMatchObject({ changed: false, unit: { enabled: true } });
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

  describe('user switch-on and disable (#1150: the switch-on is the creator)', () => {
    it('disable 404s with no unit enablement; the switch-on creates one, and the switch round-trips', async () => {
      const user = await actors.user();
      const plugin = await arrangePlugin();

      const missing = await disableUser(user, plugin.slug).expect(404);
      expect(missing.body.code).toBe('PLUGIN_UNIT_NOT_ENROLLED');
      expect(missing.body.scopeType).toBe('User');

      const created = await enableUser(user, plugin.slug, {
        'read:game_collection:public': PluginGrantStatus.Granted,
      }).expect(200);
      expect(created.body.unit).toMatchObject({ userId: user.user.id, enabled: true });

      const disabled = await disableUser(user, plugin.slug).expect(200);
      expect(disabled.body.unit).toMatchObject({ enabled: false });

      const enabled = await enableUser(user, plugin.slug).expect(200);
      expect(enabled.body.unit.enabled).toBe(true);
    });

    it('the user axis is a real surface on a SERVER-scope plugin — the switch and the read both work there', async () => {
      // The manifest gate refuses household consent on a server-scope
      // plugin but permits user consent at any scope (#225), and a user's
      // switch-on (#1150) creates a real unit enablement there. So the household 422 must not
      // generalize to this axis: the user would be toggling a unit whose
      // blocked features they could never read.
      const user = await actors.user();
      const plugin = await arrangePlugin({
        scope: 'server',
        permissions: { checks: [MANAGE_DIGEST_CHECK, { ...USER_CHECK, required: true, feature: 'weekly-digest' }] },
      });

      // Readable before any unit enablement exists: never-enabled, not impossible.
      const rowless = await readUserFeatures(user, plugin.slug).expect(200);
      expect(rowless.body.featureState).toMatchObject({
        served: false,
        unit: { scopeType: 'User', userId: user.user.id },
      });

      await enableUser(user, plugin.slug, { 'read:game_collection:public': PluginGrantStatus.Granted }).expect(200);

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
      // Switched on with the required household check unanswered, arranged on
      // the rows: no switch-on leaves it so (#1150), but an update that adds
      // the check does.
      await db.client.householdPlugin.create({
        data: { householdId: household.id, pluginId: plugin.id, enabled: true },
      });

      // Nothing granted yet: the bound required household check is pending.
      const pending = await readHouseholdFeatures(owner, household.id, plugin.slug).expect(200);
      expect(pending.body.featureState).toMatchObject({
        plugin: { slug: plugin.slug },
        unit: { scopeType: 'Household', householdId: household.id },
        served: true,
        state: 'review_pending',
      });
      const digest = pending.body.featureState.features.find(
        (feature: { name: string }) => feature.name === 'weekly-digest',
      );
      expect(digest).toMatchObject({
        state: 'disabled',
        reason: 'pending',
        blockingSlugs: ['read:game:public'],
      });

      // A durable denial upgrades the reason — same pairing, actionable why.
      // On the rows too: a review refusing it would switch the unit off (#1150).
      await arrangeHouseholdDecision(household.id, plugin.id, 'read:game:public', PluginGrantStatus.Denied);

      const denied = await readHouseholdFeatures(owner, household.id, plugin.slug).expect(200);
      const deniedDigest = denied.body.featureState.features.find(
        (feature: { name: string }) => feature.name === 'weekly-digest',
      );
      expect(deniedDigest).toMatchObject({ reason: 'denied', blockingSlugs: ['read:game:public'] });
      // The required denial leaves the unit served: the unit-level state
      // reports the review pending, while the per-feature slot keeps the
      // actionable reason (#1149).
      expect(denied.body.featureState).toMatchObject({ served: true, state: 'review_pending' });
    });

    it('a household-consented check is per-unit from the USER viewpoint, never a false green or a false block', async () => {
      const user = await actors.user();
      const plugin = await arrangePlugin();
      await enableUser(user, plugin.slug, { 'read:game_collection:public': PluginGrantStatus.Granted }).expect(200);

      const response = await readUserFeatures(user, plugin.slug).expect(200);
      const digest = response.body.featureState.features.find(
        (feature: { name: string }) => feature.name === 'weekly-digest',
      );

      expect(digest).toMatchObject({ state: 'active', blockingSlugs: [], perUnitSlugs: ['read:game:public'] });
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
      expect(gone.body.code).toBe('PLUGIN_FEATURE_STATE_TOMBSTONED');
    });
  });

  /**
   * A household unit's dormancy is worked out when read, from the active
   * manifest and the document its unit enablement holds (#1151). These read
   * it where a client does: the household inventory and feature state.
   */
  describe('dormancy on the wire (#1151)', () => {
    /** The manifest fields that carry the slug, for a second plugin beside the fixture's `demo-sink`. */
    const slugFields = (slug: string): Parameters<typeof buildPluginManifest>[0] => ({
      slug,
      events: { emits: [`plugin.${slug}.digest-sent`], subscribes: ['feedback.created'] },
      jobs: { queues: [`plugin.${slug}.digest`] },
      storage: { ownTables: [`plugin_${slug.replace(/-/g, '_')}_digests`] },
    });

    const readInventoryUnit = async (actor: SessionActor, householdId: string, slug: string) => {
      const listed = await request(baseUrl)
        .get(`/api/households/${householdId}/plugins?limit=100`)
        .set(actor.headers)
        .expect(200);

      return listed.body.plugins.find((entry: { slug: string }) => entry.slug === slug)?.unit;
    };

    it('a household unit under a config schema that cannot be used reads unavailable and gets no abilities, while the page and its other plugin are unaffected (#1151)', async () => {
      const owner = await actors.user();
      const { household } = await actors.householdWithMembers({ owner });
      // The same arrangement twice, differing only in the schema: switched on,
      // the required household decision Granted, holding `{}`.
      const broken = await arrangePlugin({
        ...slugFields('demo-sink-broken'),
        config: { schema: { type: 'no-such-type' }, requiresHouseholdConfig: false },
      });
      const usable = await arrangePlugin(slugFields('demo-sink-usable'));

      for (const plugin of [broken, usable]) {
        await arrangeHouseholdDecision(household.id, plugin.id, HOUSEHOLD_CHECK.slug, PluginGrantStatus.Granted);
        await db.client.householdPlugin.create({
          data: { householdId: household.id, pluginId: plugin.id, enabled: true, config: {} },
        });
      }

      expect(await readInventoryUnit(owner, household.id, broken.slug)).toMatchObject({
        anchored: true,
        enabled: true,
        state: 'unavailable',
        dormancy: 'unavailable',
      });
      expect(await pluginAbilitySlugsForHousehold(db.client, broken.id, household.id)).toEqual([]);

      // The control: the plugin whose schema can be used serves on the same
      // page, so the empty ability above is the schema's. Its state reports
      // consent standing (`review_pending` here), which is not dormancy.
      const usableUnit = await readInventoryUnit(owner, household.id, usable.slug);
      expect(usableUnit).toMatchObject({ enabled: true, dormancy: null });
      expect(usableUnit.state).not.toBe('unavailable');
      expect(await pluginAbilitySlugsForHousehold(db.client, usable.id, household.id)).toEqual([HOUSEHOLD_CHECK.slug]);
    });

    it('feature state carries the dormancy: needs_configuration while switched on, and still after a switch-off (#1151)', async () => {
      const owner = await actors.user();
      const { household } = await actors.householdWithMembers({ owner });
      const plugin = await arrangePlugin({ config: { schema: CONFIG_SCHEMA, requiresHouseholdConfig: false } });
      await arrangeHouseholdDecision(household.id, plugin.id, HOUSEHOLD_CHECK.slug, PluginGrantStatus.Granted);
      // A document the active schema rejects: `webhookUrl` must be a string.
      await db.client.householdPlugin.create({
        data: { householdId: household.id, pluginId: plugin.id, enabled: true, config: { webhookUrl: 42 } },
      });

      const on = await readHouseholdFeatures(owner, household.id, plugin.slug).expect(200);
      expect(on.body.featureState).toMatchObject({
        served: false,
        state: 'needs_configuration',
        dormancy: 'needs_configuration',
      });

      await disableHousehold(owner, household.id, plugin.slug).expect(200);

      const off = await readHouseholdFeatures(owner, household.id, plugin.slug).expect(200);
      expect(off.body.featureState).toMatchObject({
        served: false,
        state: 'off',
        dormancy: 'needs_configuration',
      });
    });
  });
});
