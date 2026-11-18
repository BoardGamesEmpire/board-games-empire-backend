import {
  PluginConsentActKind,
  PluginGrantScope,
  PluginGrantStatus,
  PluginScope,
  RiskLevel,
  type Plugin,
} from '@bge/database';
import { createActors, type Actors, type SessionActor } from '@bge/testing-e2e';
import { buildPluginManifest, type PluginManifest } from '@boardgamesempire/plugin-manifest';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import {
  readConsentSurface,
  readStagedShownRisks,
  reviewBody,
  sendReview,
  sendSwitchOn,
  sendToggle,
  switchOnBody,
  toggleBody,
  type ConsentAnswerStatus,
} from './consent-act-fixtures';
import { FIXTURE_ACT_ID, INVENTORY_STAGING_ID, pluginRowData, stagedUpdateColumns } from './plugin-row-fixtures';

/**
 * The wire half of #322: consent acts and the consent-presentation read over
 * real rows, on all three unit axes. Every consent decision here is written by
 * a consent act (#1150, #1336), or arranged on the rows. Pinned: a toggle
 * cannot refuse a required server-scope permission, and approving an update
 * grants a permission it requires that the Server unit had refused; the
 * authority matrix per scope including the household instance gate; the
 * user's unit enablement a switch-on creates (#1150); the household refusal
 * of condition-free core checks; the refusals every unit's acts share; the
 * consent standing the feature read derives from the consent decisions
 * without a unit-enablement write (#1149); and the presentation's decision
 * states (`per-unit`, `staleRisk`) from each viewpoint.
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
describe('plugin consent acts + consent surface (#322, #1150, #1336)', () => {
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

  /** The fixture's own declared permission — origin `plugin`, locked Low; it is grantable only with its catalog row. */
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
   * for the declared permission — without one, the consent surface shows it
   * as a permission that cannot be granted.
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

  /** A Server-unit toggle (#1336), its body built from the Server unit's consent surface, asserted to answer `expected`. */
  const toggleServer = async (
    actor: SessionActor,
    slug: string,
    permissionSlug: string,
    status: ConsentAnswerStatus,
    expected: number,
  ) => {
    const surface = await readConsentSurface(baseUrl, actor, 'server', slug);

    return sendToggle(baseUrl, actor, 'server', slug, toggleBody(surface, permissionSlug, status)).expect(expected);
  };

  /**
   * A Server-unit consent decision arranged on the rows, with the toggle act
   * that would have written it (#1336). The act row only needs to exist and
   * to name the plugin manifest: nothing here reads what it presented.
   */
  const seedServerDecision = async (
    plugin: Plugin,
    permissionSlug: string,
    decision: { readonly decidedAt: Date; readonly decidedRiskLevel: RiskLevel; readonly status: PluginGrantStatus },
  ) => {
    const act = await db.client.pluginConsentAct.create({
      data: {
        pluginId: plugin.id,
        pluginSlug: plugin.slug,
        scopeType: PluginGrantScope.Server,
        scopeId: '',
        kind: PluginConsentActKind.Toggle,
        manifestVersion: plugin.version,
        manifestSha256: plugin.installedSha256,
        presentation: { checks: [] },
        decidedAt: decision.decidedAt,
      },
    });

    return db.client.pluginGrant.create({
      data: {
        pluginId: plugin.id,
        scopeType: PluginGrantScope.Server,
        scopeId: '',
        permissionSlug,
        ...decision,
        actId: act.id,
      },
    });
  };

  const serverDecisionOf = (pluginId: string, permissionSlug: string) =>
    db.client.pluginGrant.findUniqueOrThrow({
      where: {
        pluginId_scopeType_scopeId_permissionSlug: {
          pluginId,
          scopeType: PluginGrantScope.Server,
          scopeId: '',
          permissionSlug,
        },
      },
    });

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

  describe('required server-scope permissions (#1336)', () => {
    it('a toggle naming a required server-scope permission is refused 422 with rule toggle-required (#1336)', async () => {
      const admin = await actors.admin();
      const plugin = await arrangePlugin();
      const required = `plugin|${plugin.slug}|manage:digest`;

      const response = await toggleServer(admin, plugin.slug, required, PluginGrantStatus.Denied, 422);

      // A server admin refuses a required permission by switching the plugin
      // off or uninstalling it; a toggle answers optional ones only.
      expect(response.body).toMatchObject({
        code: 'PLUGIN_CONSENT_ACT_ANSWER',
        slug: plugin.slug,
        rule: 'toggle-required',
        permissionSlugs: [required],
      });

      // Refused, not recorded: neither an act nor a consent decision.
      expect(await db.client.pluginConsentAct.count({ where: { pluginId: plugin.id } })).toBe(0);
      expect(await db.client.pluginGrant.count({ where: { pluginId: plugin.id } })).toBe(0);
    });

    it('approving an update that requires a denied permission grants it (#1336)', async () => {
      const admin = await actors.admin();
      // Active: policy read OPTIONAL, so a toggle can refuse it now. Pending:
      // the same requested permission made required.
      const pending = manifestWithChecks('1.3.0', [
        MANAGE_DIGEST_CHECK,
        { ...POLICY_READ_CHECK, required: true },
        HOUSEHOLD_CHECK,
        USER_CHECK,
      ]);
      const plugin = await arrangePlugin(DEFAULT_CHECKS, stagedUpdateColumns({ manifest: pending, since: STAGED_AT }));

      await toggleServer(admin, plugin.slug, 'read:safe_http_policy', PluginGrantStatus.Denied, 200);
      const denial = await serverDecisionOf(plugin.id, 'read:safe_http_policy');
      expect(denial.status).toBe(PluginGrantStatus.Denied);

      // The server admin who approves a version that requires the permission
      // consents to it: the approval grants it under its UpdateApprove act.
      const approval = await request(baseUrl)
        .post(`${PLUGINS_PATH}/${plugin.slug}/update/approve`)
        .set(admin.headers)
        .send({ stagingId: INVENTORY_STAGING_ID, shownRisks: await readStagedShownRisks(baseUrl, admin, plugin.slug) })
        .expect(200);

      expect(approval.body.comparison.deniedRequiredSlugs).toEqual(['read:safe_http_policy']);
      expect(approval.body.act.kind).toBe('UpdateApprove');

      const decision = await db.client.pluginGrant.findUniqueOrThrow({ where: { id: denial.id } });
      expect(decision).toMatchObject({ status: PluginGrantStatus.Granted, actId: approval.body.act.id });

      const row = await db.client.plugin.findUniqueOrThrow({ where: { id: plugin.id } });
      expect(row.version).toBe('1.3.0');
      expect(row.pendingVersion).toBeNull();
    });
  });

  describe('authority matrix', () => {
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

  describe("refusals every unit's consent acts share (#1150, #1336)", () => {
    it('refuses an uninstalled plugin with 410 at every scope', async () => {
      const admin = await actors.admin();
      const owner = await actors.user();
      const fixture = await actors.householdWithMembers({ owner });
      const plugin = await arrangePlugin();
      const unit = { householdId: fixture.household.id };
      // Read while the plugin is installed: a tombstone has no consent surface
      // to read, and the act names what the unit was shown before (#1150).
      const serverSurface = await readConsentSurface(baseUrl, admin, 'server', plugin.slug);
      const householdSurface = await readConsentSurface(baseUrl, owner, unit, plugin.slug);
      const userSurface = await readConsentSurface(baseUrl, owner, 'me', plugin.slug);

      await db.client.plugin.update({
        where: { id: plugin.id },
        data: { uninstalledAt: new Date('2026-08-10T00:00:00Z'), enabled: false },
      });

      const server = await sendToggle(
        baseUrl,
        admin,
        'server',
        plugin.slug,
        toggleBody(serverSurface, 'read:safe_http_policy', PluginGrantStatus.Granted),
      ).expect(410);
      expect(server.body.code).toBe('PLUGIN_UNIT_PLUGIN_TOMBSTONED');

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

    it('404s an unknown slug with the slug in the body; 422s an unrequested permission and one another unit decides (#1336)', async () => {
      const admin = await actors.admin();
      const plugin = await arrangePlugin();
      const surface = await readConsentSurface(baseUrl, admin, 'server', plugin.slug);
      const body = toggleBody(surface, 'read:safe_http_policy', PluginGrantStatus.Granted);
      const answering = (permissionSlug: string) => ({
        ...body,
        answer: { permissionSlug, status: PluginGrantStatus.Granted, riskLevel: RiskLevel.Low },
      });

      const missing = await sendToggle(baseUrl, admin, 'server', 'ghost-plugin', body).expect(404);
      expect(missing.body.code).toBe('PLUGIN_UNIT_PLUGIN_NOT_FOUND');
      expect(missing.body.slug).toBe('ghost-plugin');

      const unrequested = await sendToggle(baseUrl, admin, 'server', plugin.slug, answering('read:game')).expect(422);
      expect(unrequested.body).toMatchObject({ code: 'PLUGIN_CONSENT_ACT_ANSWER', rule: 'not-requested' });

      // A household-scope requested permission answered by the Server unit:
      // the manifest names the unit that decides it, and the Server unit
      // answers only what it requests at server scope.
      const otherUnit = await sendToggle(baseUrl, admin, 'server', plugin.slug, answering('read:game:public')).expect(
        422,
      );
      expect(otherUnit.body).toMatchObject({
        code: 'PLUGIN_CONSENT_ACT_ANSWER',
        rule: 'not-requested',
        permissionSlugs: ['read:game:public'],
      });

      expect(await db.client.pluginConsentAct.count({ where: { pluginId: plugin.id } })).toBe(0);
      expect(await db.client.pluginGrant.count({ where: { pluginId: plugin.id } })).toBe(0);
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
          actId: FIXTURE_ACT_ID,
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
      // The server-scope requirement is a server admin's to answer, with a
      // review act; with it granted, the household check is the only one
      // left outstanding.
      const serverSurface = await readConsentSurface(baseUrl, admin, 'server', plugin.slug);
      await sendReview(
        baseUrl,
        admin,
        'server',
        plugin.slug,
        reviewBody(serverSurface, { [`plugin|${plugin.slug}|manage:digest`]: PluginGrantStatus.Granted }),
      ).expect(200);
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
      await seedServerDecision(plugin, 'read:safe_http_policy', {
        status: PluginGrantStatus.Granted,
        decidedRiskLevel: RiskLevel.Low,
        decidedAt: new Date('2026-07-01T00:00:00Z'),
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
      const checks: { decidableByUnit: boolean; decision: string; slug: string }[] = response.body.presentation.checks;
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
      const checks: { decision: string; slug: string }[] = response.body.presentation.checks;
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
