import { PluginGrantScope, PluginGrantStatus, PluginScope, RiskLevel, type Plugin } from '@bge/database';
import { createActors, type Actors, type SessionActor } from '@bge/testing-e2e';
import { buildPluginManifest, type PluginManifest } from '@boardgamesempire/plugin-manifest';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import {
  readConsentSurface,
  reviewBody,
  sendReview,
  sendSwitchOn,
  switchOnBody,
  type ConsentAnswerStatus,
} from './consent-act-fixtures';
import { INVENTORY_STAGING_ID, pluginRowData, stagedUpdateColumns } from './plugin-row-fixtures';

/**
 * The wire half of #322: grant decisions and the consent-presentation read
 * over real rows, on all three unit axes. The D-AV required-denial rule is
 * pinned as its 409 (and its pending-manifest exception as the C4.3
 * integration: the denial lands, and it is APPROVE that refuses), the
 * authority matrix per scope including the household instance gate, the
 * user's unit enablement a switch-on creates (#1150), the household refusal
 * of condition-free core checks, the consent standing the feature read
 * derives from the grants without a unit-enablement write (#1149), and the
 * presentation's decision states (`per-unit`, `staleRisk`) from each
 * viewpoint. Household and user decisions are consent acts (#1150); the
 * server's stay on the operator's grants route.
 *
 * Plugin state is arranged directly on the rows (the install ingress is
 * #84's; no endpoint exists), including the `PluginPermission` catalog rows
 * the install pipeline would have created for declared permissions. Core
 * checks reference SEEDED permissions only: `read:safe_http_policy`
 * (Medium, condition-free) at server scope, `read:game:public` and
 * `read:game_collection:public` (both Low, allowlisted public reads a
 * household and a user may consent to, #591), and `read:platform_game`
 * (Low, condition-free) as the trap a household decision must refuse.
 */
describe('plugin grant decisions + consent presentation (#322)', () => {
  const baseUrl = requireBaseUrl(process.env);
  const PLUGINS_PATH = '/api/plugins';
  const STAGED_AT = new Date('2026-08-01T12:00:00Z');

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

  /** The fixture's own declared permission — origin `plugin`, locked Low; decide() needs its catalog row. */
  const MANAGE_DIGEST_CHECK: Check = {
    slug: 'manage:digest',
    required: true,
    reason: { en: 'Stores and manages the digest configuration it owns.' },
    consentScope: 'server',
  };

  const POLICY_READ_CHECK: Check = {
    slug: 'read:safe_http_policy',
    required: false,
    reason: { en: 'Inspects the outbound policy before scheduling digest delivery.' },
    consentScope: 'server',
  };

  /** An allowlisted public read, which a household-scope consent may hold (#591). */
  const HOUSEHOLD_CHECK: Check = {
    slug: 'read:game:public',
    required: true,
    reason: { en: 'Lists the public games the household digest features.' },
    consentScope: 'household',
  };

  /** An allowlisted public read, which a user-scope consent may hold (#591). */
  const USER_CHECK: Check = {
    slug: 'read:game_collection:public',
    required: false,
    reason: { en: 'Shows public collections in each member’s digest.' },
    consentScope: 'user',
  };

  const DEFAULT_CHECKS: readonly Check[] = [MANAGE_DIGEST_CHECK, POLICY_READ_CHECK, HOUSEHOLD_CHECK, USER_CHECK];

  const manifestWithChecks = (version: string, checks: readonly Check[]): PluginManifest =>
    buildPluginManifest({
      version,
      scope: 'household',
      bgeCompat: '>=0.0.0',
      permissions: { checks: [...checks] },
    });

  /**
   * An installed plugin with the given active checks, plus the
   * `PluginPermission` catalog row the install pipeline (#59 C2) creates
   * for the declared permission — decide() refuses declared slugs without
   * one, fail-loud.
   */
  const arrangePlugin = async (
    checks: readonly Check[] = DEFAULT_CHECKS,
    overrides: Record<string, unknown> = {},
  ): Promise<Plugin> => {
    const active = manifestWithChecks('1.2.0', checks);

    const plugin = await db.client.plugin.create({
      data: pluginRowData({
        slug: active.slug,
        version: active.version,
        scope: PluginScope.Household,
        manifestJson: active as never,
        enabled: true,
        ...overrides,
      }),
    });
    await db.client.pluginPermission.create({
      data: { pluginId: plugin.id, slug: `plugin|${plugin.slug}|manage:digest`, riskLevel: RiskLevel.Low },
    });

    return plugin;
  };

  const decideServer = (actor: SessionActor, slug: string, body: Record<string, unknown>) =>
    request(baseUrl).post(`${PLUGINS_PATH}/${slug}/grants`).set(actor.headers).send(body);

  /**
   * A household switch-on (#1150), its body built from the household's
   * consent surface, asserted to answer `status`. The consent surface is read
   * by `reader`, so an actor refused the act can still be shown it.
   */
  const switchOnHousehold = async (
    actor: SessionActor,
    householdId: string,
    slug: string,
    answers: Readonly<Record<string, ConsentAnswerStatus>>,
    status: number,
    reader: SessionActor = actor,
  ) => {
    const unit = { householdId };
    const surface = await readConsentSurface(baseUrl, reader, unit, slug);

    return sendSwitchOn(baseUrl, actor, unit, slug, switchOnBody(surface, answers)).expect(status);
  };

  /** A user switch-on (#1150), its body built from the user's own consent surface, asserted to answer `status`. */
  const switchOnUser = async (
    actor: SessionActor,
    slug: string,
    answers: Readonly<Record<string, ConsentAnswerStatus>>,
    status: number,
  ) => {
    const surface = await readConsentSurface(baseUrl, actor, 'me', slug);

    return sendSwitchOn(baseUrl, actor, 'me', slug, switchOnBody(surface, answers)).expect(status);
  };

  /** A household review (#1150) of the active manifest, built from the household's consent surface, asserted to answer `status`. */
  const reviewHousehold = async (
    actor: SessionActor,
    householdId: string,
    slug: string,
    answers: Readonly<Record<string, ConsentAnswerStatus>>,
    status: number,
  ) => {
    const unit = { householdId };
    const surface = await readConsentSurface(baseUrl, actor, unit, slug);

    return sendReview(baseUrl, actor, unit, slug, reviewBody(surface, answers)).expect(status);
  };

  const readServerConsent = (actor: SessionActor, slug: string) =>
    request(baseUrl).get(`${PLUGINS_PATH}/${slug}/consent`).set(actor.headers);

  const readHouseholdConsent = (actor: SessionActor, householdId: string, slug: string) =>
    request(baseUrl).get(`/api/households/${householdId}/plugins/${slug}/consent`).set(actor.headers);

  const readUserConsent = (actor: SessionActor, slug: string) =>
    request(baseUrl).get(`/api/users/me/plugins/${slug}/consent`).set(actor.headers);

  const readHouseholdFeatures = (actor: SessionActor, householdId: string, slug: string) =>
    request(baseUrl).get(`/api/households/${householdId}/plugins/${slug}/features`).set(actor.headers);

  const granted = (permissionSlug: string) => ({ permissionSlug, status: PluginGrantStatus.Granted });
  const denied = (permissionSlug: string) => ({ permissionSlug, status: PluginGrantStatus.Denied });

  describe('D-AV — the required-denial rule', () => {
    it('refuses a Denied decision on an active-manifest required server check with the typed 409 naming the levers', async () => {
      const admin = await actors.admin();
      const plugin = await arrangePlugin();

      const response = await decideServer(admin, plugin.slug, denied(`plugin|${plugin.slug}|manage:digest`)).expect(
        409,
      );

      // The client renders the disable/uninstall levers FROM this body
      // (client repo #237) — code and fields are contract, not decoration.
      expect(response.body.code).toBe('PLUGIN_GRANT_REQUIRED_DENIAL');
      expect(response.body.slug).toBe(plugin.slug);
      expect(response.body.permissionSlug).toBe(`plugin|${plugin.slug}|manage:digest`);
      expect(response.body.message).toMatch(/disable or uninstall/i);

      // Refused, not recorded: the grant table never sees the contradiction.
      expect(await db.client.pluginGrant.count({ where: { pluginId: plugin.id } })).toBe(0);
    });

    it('keeps an OPTIONAL server check durably deniable, idempotent on re-statement, and re-decidable', async () => {
      const admin = await actors.admin();
      const plugin = await arrangePlugin();

      const first = await decideServer(admin, plugin.slug, denied('read:safe_http_policy')).expect(200);
      expect(first.body.changed).toBe(true);
      expect(first.body.grant).toMatchObject({
        permissionSlug: 'read:safe_http_policy',
        scopeType: PluginGrantScope.Server,
        status: PluginGrantStatus.Denied,
        decidedRiskLevel: RiskLevel.Medium,
      });

      const restatement = await decideServer(admin, plugin.slug, denied('read:safe_http_policy')).expect(200);
      expect(restatement.body.changed).toBe(false);

      // The durable denial is a decision, not a dead end: a later Granted
      // flips the SAME row in place.
      const flip = await decideServer(admin, plugin.slug, granted('read:safe_http_policy')).expect(200);
      expect(flip.body.changed).toBe(true);
      expect(flip.body.grant.id).toBe(first.body.grant.id);

      expect(await db.client.pluginGrant.count({ where: { pluginId: plugin.id } })).toBe(1);
    });

    it('a denial against a check only the PENDING manifest requires lands, and approving the update grants it (#1336)', async () => {
      const admin = await actors.admin();
      // Active: policy read OPTIONAL, so the denial is legal now. Pending: the
      // same check promoted to required. A slug the pending manifest
      // introduces fresh would be undecidable (422) against the active one.
      const pending = manifestWithChecks('1.3.0', [
        MANAGE_DIGEST_CHECK,
        { ...POLICY_READ_CHECK, required: true },
        HOUSEHOLD_CHECK,
        USER_CHECK,
      ]);
      const plugin = await arrangePlugin(DEFAULT_CHECKS, stagedUpdateColumns({ manifest: pending, since: STAGED_AT }));

      const denial = await decideServer(admin, plugin.slug, denied('read:safe_http_policy')).expect(200);

      // The server admin who approves a version that requires the permission
      // consents to it: the approval grants it under its UpdateApprove act.
      const approval = await request(baseUrl)
        .post(`${PLUGINS_PATH}/${plugin.slug}/update/approve`)
        .set(admin.headers)
        .send({ stagingId: INVENTORY_STAGING_ID })
        .expect(200);

      expect(approval.body.comparison.deniedRequiredSlugs).toEqual(['read:safe_http_policy']);
      expect(approval.body.act.kind).toBe('UpdateApprove');

      const decision = await db.client.pluginGrant.findUniqueOrThrow({ where: { id: denial.body.grant.id } });
      expect(decision).toMatchObject({ status: PluginGrantStatus.Granted, actId: approval.body.act.id });

      const row = await db.client.plugin.findUniqueOrThrow({ where: { id: plugin.id } });
      expect(row.version).toBe('1.3.0');
      expect(row.pendingVersion).toBeNull();
    });
  });

  describe('authority matrix', () => {
    it('server decide: 403 for a plain user at the manage:plugin gate, 401 unauthenticated', async () => {
      const user = await actors.user();
      const plugin = await arrangePlugin();

      await decideServer(user, plugin.slug, granted('read:safe_http_policy')).expect(403);
      await request(baseUrl)
        .post(`${PLUGINS_PATH}/${plugin.slug}/grants`)
        .send(granted('read:safe_http_policy'))
        .expect(401);
    });

    it('household switch-on: owner passes; a plain member and an admin of ANOTHER household are both refused (#1150)', async () => {
      const ownerA = await actors.user();
      const memberA = await actors.user();
      const ownerB = await actors.user();
      const fixtureA = await actors.householdWithMembers({
        owner: ownerA,
        members: [{ actor: memberA, role: 'HouseholdMember' }],
      });
      // ownerB needs a household of their OWN so the type-level gate passes
      // — that is what makes the cross-household 403 pin the instance gate.
      await actors.householdWithMembers({ owner: ownerB });
      const plugin = await arrangePlugin();
      const answers = { 'read:game:public': PluginGrantStatus.Granted } as const;

      // A plain member holds no manage:plugin:household rule — the coarse
      // gate refuses before anything else runs.
      await switchOnHousehold(memberA, fixtureA.household.id, plugin.slug, answers, 403, ownerA);

      // Owner of B addressing A: the type-level gate passes (they hold the
      // permission SOMEWHERE), so this pins the per-household instance gate.
      await switchOnHousehold(ownerB, fixtureA.household.id, plugin.slug, answers, 403, ownerA);
      expect(await db.client.pluginGrant.count({ where: { pluginId: plugin.id } })).toBe(0);

      await switchOnHousehold(ownerA, fixtureA.household.id, plugin.slug, answers, 200);
      expect(await db.client.pluginGrant.findMany({ where: { pluginId: plugin.id } })).toEqual([
        expect.objectContaining({
          scopeType: PluginGrantScope.Household,
          scopeId: fixtureA.household.id,
          permissionSlug: 'read:game:public',
          status: PluginGrantStatus.Granted,
        }),
      ]);
    });

    it('user switch-on: any authenticated user, for their own unit only — it creates their unit enablement, switched on, whatever the optional answers (#1150)', async () => {
      const user = await actors.user();
      const plugin = await arrangePlugin();

      await switchOnUser(user, plugin.slug, { 'read:game_collection:public': PluginGrantStatus.Denied }, 200);

      const units = await db.client.userPlugin.findMany({ where: { pluginId: plugin.id } });
      expect(units).toEqual([expect.objectContaining({ userId: user.user.id, enabled: true })]);
      expect(await db.client.pluginGrant.findMany({ where: { pluginId: plugin.id } })).toEqual([
        expect.objectContaining({
          scopeType: PluginGrantScope.User,
          scopeId: user.user.id,
          status: PluginGrantStatus.Denied,
        }),
      ]);
    });

    it('a household grant of a condition-free core permission is refused as one that cannot be granted (#1150)', async () => {
      const owner = await actors.user();
      const fixture = await actors.householdWithMembers({ owner });
      const plugin = await arrangePlugin([
        MANAGE_DIGEST_CHECK,
        {
          // A check with no conditions at all, which `read:game` no longer is (#472).
          slug: 'read:platform_game',
          required: false,
          reason: { en: 'Lists platform editions inside the digest.' },
          consentScope: 'household',
        },
      ]);

      const response = await switchOnHousehold(
        owner,
        fixture.household.id,
        plugin.slug,
        { 'read:platform_game': PluginGrantStatus.Granted },
        409,
      );

      expect(response.body.code).toBe('PLUGIN_CONSENT_ACT_UNGRANTABLE');
      expect(response.body.permissions).toEqual([
        { permissionSlug: 'read:platform_game', cause: 'unbound_unit_scope' },
      ]);
      expect(await db.client.pluginGrant.count({ where: { pluginId: plugin.id } })).toBe(0);
    });
  });

  describe('decide — shared semantics the endpoints inherit', () => {
    it('refuses a tombstoned plugin with 410 at every scope', async () => {
      const admin = await actors.admin();
      const owner = await actors.user();
      const fixture = await actors.householdWithMembers({ owner });
      const plugin = await arrangePlugin();
      const unit = { householdId: fixture.household.id };
      // Read while the plugin is installed: a tombstone has no consent surface
      // to read, and the act names what the unit was shown before (#1150).
      const householdSurface = await readConsentSurface(baseUrl, owner, unit, plugin.slug);
      const userSurface = await readConsentSurface(baseUrl, owner, 'me', plugin.slug);

      await db.client.plugin.update({
        where: { id: plugin.id },
        data: { uninstalledAt: new Date('2026-08-10T00:00:00Z'), enabled: false },
      });

      const server = await decideServer(admin, plugin.slug, granted('read:safe_http_policy')).expect(410);
      expect(server.body.code).toBe('PLUGIN_GRANT_PLUGIN_TOMBSTONED');

      const household = await sendSwitchOn(
        baseUrl,
        owner,
        unit,
        plugin.slug,
        switchOnBody(householdSurface, { 'read:game:public': PluginGrantStatus.Granted }),
      ).expect(410);
      expect(household.body.code).toBe('PLUGIN_UNIT_PLUGIN_TOMBSTONED');

      const user = await sendSwitchOn(
        baseUrl,
        owner,
        'me',
        plugin.slug,
        switchOnBody(userSurface, { 'read:game_collection:public': PluginGrantStatus.Granted }),
      ).expect(410);
      expect(user.body.code).toBe('PLUGIN_UNIT_PLUGIN_TOMBSTONED');
    });

    it('does NOT gate on Plugin.enabled — consent-before-enable is a legitimate ordering', async () => {
      const admin = await actors.admin();
      const plugin = await arrangePlugin(DEFAULT_CHECKS, { enabled: false });

      await decideServer(admin, plugin.slug, granted('read:safe_http_policy')).expect(200);
    });

    it('404s an unknown slug with the slug in the body; 422s an unrequested permission and a scope mismatch', async () => {
      const admin = await actors.admin();
      const plugin = await arrangePlugin();

      const missing = await decideServer(admin, 'ghost-plugin', granted('read:safe_http_policy')).expect(404);
      expect(missing.body.code).toBe('PLUGIN_GRANT_PLUGIN_NOT_FOUND');
      expect(missing.body.slug).toBe('ghost-plugin');

      const unrequested = await decideServer(admin, plugin.slug, granted('read:game')).expect(422);
      expect(unrequested.body.code).toBe('PLUGIN_GRANT_UNKNOWN_PERMISSION');

      // A household-consented check decided at server scope: the manifest
      // owns the scope, and the decision must address it there.
      const mismatched = await decideServer(admin, plugin.slug, granted('read:game:public')).expect(422);
      expect(mismatched.body.code).toBe('PLUGIN_GRANT_CONSENT_SCOPE_MISMATCH');
    });
  });

  describe('consent standing is derived (#1061, #1063, #1147)', () => {
    /** A household unit whose unit enablement is switched on, as a household admin's enable leaves it. */
    const arrangeEnabledHouseholdUnit = (householdId: string, pluginId: string) =>
      db.client.householdPlugin.create({ data: { householdId, pluginId, enabled: true } });

    const unitRow = (id: string) => db.client.householdPlugin.findUniqueOrThrow({ where: { id } });

    it('a unit still owing a required household check is served: GET features reports state review_pending with the slug as never_asked', async () => {
      const owner = await actors.user();
      const fixture = await actors.householdWithMembers({ owner });
      const plugin = await arrangePlugin();
      await arrangeEnabledHouseholdUnit(fixture.household.id, plugin.id);

      const response = await readHouseholdFeatures(owner, fixture.household.id, plugin.slug).expect(200);
      const featureState = response.body.featureState;

      // Consent never decides whether the unit runs: it keeps running on the
      // grants it holds, and the state code says a review is pending.
      expect(featureState.served).toBe(true);
      expect(featureState.state).toBe('review_pending');
      expect(featureState.consent.outstanding).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            slug: 'read:game:public',
            kind: 'never_asked',
            required: true,
            riskLevel: RiskLevel.Low,
          }),
        ]),
      );
    });

    it('a Denied on a required household check leaves the unit served and reports the slug as refused', async () => {
      const owner = await actors.user();
      const fixture = await actors.householdWithMembers({ owner });
      const plugin = await arrangePlugin();
      await arrangeEnabledHouseholdUnit(fixture.household.id, plugin.id);
      // Arranged on the rows (#1150): no consent act leaves a switched-on unit
      // refusing a required permission, since a review refusing one switches
      // the unit off. An update can still leave this state, when a
      // permission the household had refused becomes required.
      await db.client.pluginGrant.create({
        data: {
          pluginId: plugin.id,
          scopeType: PluginGrantScope.Household,
          scopeId: fixture.household.id,
          permissionSlug: 'read:game:public',
          status: PluginGrantStatus.Denied,
          decidedAt: new Date(),
          decidedRiskLevel: RiskLevel.Low,
        },
      });

      const response = await readHouseholdFeatures(owner, fixture.household.id, plugin.slug).expect(200);
      const featureState = response.body.featureState;
      expect(featureState.served).toBe(true);
      expect(featureState.state).toBe('review_pending');
      expect(featureState.consent.outstanding).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ slug: 'read:game:public', kind: 'refused', required: true }),
        ]),
      );
    });

    it('the review that grants the last outstanding check flips state to on with no unit-enablement write (#1150)', async () => {
      const admin = await actors.admin();
      const owner = await actors.user();
      const fixture = await actors.householdWithMembers({ owner });
      const plugin = await arrangePlugin();
      // The server-consented requirement is a server admin's to answer; with
      // it granted, the household check is the only one left outstanding.
      await decideServer(admin, plugin.slug, granted(`plugin|${plugin.slug}|manage:digest`)).expect(200);
      const unit = await arrangeEnabledHouseholdUnit(fixture.household.id, plugin.id);

      const before = await readHouseholdFeatures(owner, fixture.household.id, plugin.slug).expect(200);
      expect(before.body.featureState.state).toBe('review_pending');
      expect(before.body.featureState.consent.outstanding).toEqual([
        expect.objectContaining({ slug: 'read:game:public', kind: 'never_asked' }),
      ]);

      await reviewHousehold(
        owner,
        fixture.household.id,
        plugin.slug,
        { 'read:game:public': PluginGrantStatus.Granted },
        200,
      );

      const after = await readHouseholdFeatures(owner, fixture.household.id, plugin.slug).expect(200);
      expect(after.body.featureState).toMatchObject({ served: true, state: 'on' });
      expect(after.body.featureState.consent.outstanding).toEqual([]);

      // Nothing was re-enabled because nothing was ever switched off: the
      // state is worked out when read, so the decision left the row alone.
      const row = await unitRow(unit.id);
      expect(row.enabled).toBe(true);
      expect(row.updatedAt).toEqual(unit.updatedAt);
    });
  });

  describe('consent-presentation read', () => {
    it('server viewpoint: every check with decision state, per-unit for unit scopes, staleRisk on an outgrown grant', async () => {
      const admin = await actors.admin();
      const plugin = await arrangePlugin();
      // Granted when the catalog said Low; the catalog says Medium today —
      // consent on record was given for a different classification.
      await db.client.pluginGrant.create({
        data: {
          pluginId: plugin.id,
          scopeType: PluginGrantScope.Server,
          scopeId: '',
          permissionSlug: 'read:safe_http_policy',
          status: PluginGrantStatus.Granted,
          decidedAt: new Date('2026-07-01T00:00:00Z'),
          decidedRiskLevel: RiskLevel.Low,
        },
      });

      const response = await readServerConsent(admin, plugin.slug).expect(200);
      const presentation = response.body.presentation;

      expect(presentation.plugin).toMatchObject({ id: plugin.id, slug: plugin.slug, enabled: true });
      expect(presentation.source).toBe('active');
      expect(presentation.unit).toEqual({ scopeType: 'Server' });
      expect(presentation.features).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'weekly-digest' })]),
      );

      const bySlug = new Map<string, Record<string, unknown>>(
        presentation.checks.map((check: { slug: string }) => [check.slug, check]),
      );
      expect(bySlug.get(`plugin|${plugin.slug}|manage:digest`)).toMatchObject({
        decision: 'pending',
        decidableByUnit: true,
        required: true,
        riskLevel: RiskLevel.Low,
      });
      expect(bySlug.get('read:safe_http_policy')).toMatchObject({
        decision: 'pending',
        staleRisk: true,
        riskLevel: RiskLevel.Medium,
        decidedRiskLevel: RiskLevel.Low,
      });
      // Unit-scope checks from the Server viewpoint: each unit decides for
      // itself, so no single state exists here.
      expect(bySlug.get('read:game:public')).toMatchObject({ decision: 'per-unit', decidableByUnit: false });
      expect(bySlug.get('read:game_collection:public')).toMatchObject({ decision: 'per-unit', decidableByUnit: false });
      // Localized values resolve with provenance the renderer can trust.
      const reason = (bySlug.get('read:safe_http_policy') as { reason: { value: string } }).reason;
      expect(reason.value).toContain('outbound policy');

      // read:plugin is Owner/Admin-only in the seeds.
      const user = await actors.user();
      await readServerConsent(user, plugin.slug).expect(403);
    });

    it('household viewpoint: own decision state concrete, cross-household read refused by the instance gate', async () => {
      const ownerA = await actors.user();
      const ownerB = await actors.user();
      const fixtureA = await actors.householdWithMembers({ owner: ownerA });
      await actors.householdWithMembers({ owner: ownerB });
      const plugin = await arrangePlugin();

      // A review refusing the required check: the consent act that records a
      // household's denial of one (#1150). It switches the unit off, which the
      // consent surface does not depend on.
      await db.client.householdPlugin.create({
        data: { householdId: fixtureA.household.id, pluginId: plugin.id, enabled: true },
      });
      await reviewHousehold(
        ownerA,
        fixtureA.household.id,
        plugin.slug,
        { 'read:game:public': PluginGrantStatus.Denied },
        200,
      );

      const response = await readHouseholdConsent(ownerA, fixtureA.household.id, plugin.slug).expect(200);
      const checks: { slug: string; decision: string; decidableByUnit: boolean }[] = response.body.presentation.checks;
      const household = checks.find((check) => check.slug === 'read:game:public');
      expect(household).toMatchObject({ decision: 'denied', decidableByUnit: true });
      // A SERVER check from the household viewpoint is not per-unit: the
      // Server sentinel row is one addressable decider, so its concrete
      // state renders (undecided here) — only the multi-unit axes collapse.
      expect(checks.find((check) => check.slug === `plugin|${plugin.slug}|manage:digest`)).toMatchObject({
        decision: 'pending',
        decidableByUnit: false,
      });
      // The USER axis from the household viewpoint IS per-unit: every user
      // decides for themself, so no single state exists from here.
      expect(checks.find((check) => check.slug === 'read:game_collection:public')).toMatchObject({
        decision: 'per-unit',
        decidableByUnit: false,
      });

      // Owner of B holds read:plugin:household — for household B. The
      // instance gate binds the read to the route's household.
      await readHouseholdConsent(ownerB, fixtureA.household.id, plugin.slug).expect(403);
    });

    it('user viewpoint: own decision concrete after deciding; 404/410 draw the typed distinctions', async () => {
      const user = await actors.user();
      const plugin = await arrangePlugin();

      await switchOnUser(user, plugin.slug, { 'read:game_collection:public': PluginGrantStatus.Granted }, 200);

      const response = await readUserConsent(user, plugin.slug).expect(200);
      const checks: { slug: string; decision: string }[] = response.body.presentation.checks;
      expect(checks.find((check) => check.slug === 'read:game_collection:public')).toMatchObject({
        decision: 'granted',
        decidableByUnit: true,
      });

      const missing = await readUserConsent(user, 'ghost-plugin').expect(404);
      expect(missing.body.code).toBe('PLUGIN_CONSENT_PRESENTATION_NOT_FOUND');
      expect(missing.body.slug).toBe('ghost-plugin');

      const tombstoned = await arrangePlugin(DEFAULT_CHECKS, {
        slug: 'tombstoned-sink',
        uninstalledAt: new Date('2026-08-10T00:00:00Z'),
      });
      const gone = await readUserConsent(user, tombstoned.slug).expect(410);
      expect(gone.body.code).toBe('PLUGIN_CONSENT_PRESENTATION_TOMBSTONED');
    });
  });
});
