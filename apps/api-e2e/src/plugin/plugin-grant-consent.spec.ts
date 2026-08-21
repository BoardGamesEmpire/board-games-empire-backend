import {
  PluginCategory,
  PluginGrantScope,
  PluginGrantStatus,
  PluginScope,
  RiskLevel,
  type Plugin,
} from '@bge/database';
import { createActors, type Actors, type SessionActor } from '@bge/testing-e2e';
import { buildPluginManifest, type PluginManifest } from '@boardgamesempire/plugin-manifest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

/**
 * The wire half of #322: grant decisions and the consent-presentation read
 * over real rows, on all three unit axes. The D-AV required-denial rule is
 * pinned as its 409 (and its pending-manifest exception as the C4.3
 * integration: the denial lands, and it is APPROVE that refuses), the
 * authority matrix per scope including the household instance gate, the
 * #225 enablement anchor, D60-7's exclusion, the D-AR late-acceptance
 * re-enable and its D-BQ suspension mirror as observable unit-row flips,
 * and the presentation's decision states (`per-unit`, `staleRisk`) from
 * each viewpoint.
 *
 * Plugin state is arranged directly on the rows (the install ingress is
 * #84's; no endpoint exists), including the `PluginPermission` catalog rows
 * the install pipeline would have created for declared permissions. Core
 * checks reference SEEDED permissions only: `read:safe_http_policy`
 * (Medium, condition-free) at server scope, `read:household_member` (Low,
 * household-conditioned), `update:user:profile:own` (Low, user-conditioned),
 * and `read:game` (Low, condition-free) as the D60-7 trap.
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

  const HOUSEHOLD_CHECK: Check = {
    slug: 'read:household_member',
    required: true,
    reason: { en: 'Addresses the digest to the household roster.' },
    consentScope: 'household',
  };

  const USER_CHECK: Check = {
    slug: 'update:user:profile:own',
    required: false,
    reason: { en: 'Records each member’s digest delivery preference on their profile.' },
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
      data: {
        slug: active.slug,
        version: active.version,
        category: PluginCategory.FeedbackSink,
        scope: PluginScope.Household,
        manifestJson: active as never,
        enabled: true,
        bundled: false,
        installedSha256: randomUUID(),
        ...overrides,
      },
    });
    await db.client.pluginPermission.create({
      data: { pluginId: plugin.id, slug: `plugin|${plugin.slug}|manage:digest`, riskLevel: RiskLevel.Low },
    });

    return plugin;
  };

  const decideServer = (actor: SessionActor, slug: string, body: Record<string, unknown>) =>
    request(baseUrl).post(`${PLUGINS_PATH}/${slug}/grants`).set(actor.headers).send(body);

  const decideHousehold = (actor: SessionActor, householdId: string, slug: string, body: Record<string, unknown>) =>
    request(baseUrl).post(`/api/households/${householdId}/plugins/${slug}/grants`).set(actor.headers).send(body);

  const decideUser = (actor: SessionActor, slug: string, body: Record<string, unknown>) =>
    request(baseUrl).post(`/api/users/me/plugins/${slug}/grants`).set(actor.headers).send(body);

  const readServerConsent = (actor: SessionActor, slug: string) =>
    request(baseUrl).get(`${PLUGINS_PATH}/${slug}/consent`).set(actor.headers);

  const readHouseholdConsent = (actor: SessionActor, householdId: string, slug: string) =>
    request(baseUrl).get(`/api/households/${householdId}/plugins/${slug}/consent`).set(actor.headers);

  const readUserConsent = (actor: SessionActor, slug: string) =>
    request(baseUrl).get(`/api/users/me/plugins/${slug}/consent`).set(actor.headers);

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
      expect(response.body.code).toBe('PluginGrantRequiredDenialError');
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

    it('a denial against a check only the PENDING manifest requires lands — and APPROVE is what refuses (D-AB)', async () => {
      const admin = await actors.admin();
      // Active: policy read OPTIONAL. Pending: the same check promoted to
      // required — the D-AV fixture correction locked 2026-08-21: a slug the
      // pending manifest introduces FRESH would be undecidable (422), not
      // legal-then-blocked.
      const pending = manifestWithChecks('1.3.0', [
        MANAGE_DIGEST_CHECK,
        { ...POLICY_READ_CHECK, required: true },
        HOUSEHOLD_CHECK,
        USER_CHECK,
      ]);
      const plugin = await arrangePlugin(DEFAULT_CHECKS, {
        pendingVersion: pending.version,
        pendingManifestJson: pending as never,
        pendingSha256: 'e2e-new-sha',
        pendingSince: STAGED_AT,
      });

      await decideServer(admin, plugin.slug, denied('read:safe_http_policy')).expect(200);

      const refusal = await request(baseUrl)
        .post(`${PLUGINS_PATH}/${plugin.slug}/update/approve`)
        .set(admin.headers)
        .send({})
        .expect(409);

      expect(refusal.body.code).toBe('PluginUpdateBlockedByDenialError');
      expect(refusal.body.deniedRequiredSlugs).toEqual(['read:safe_http_policy']);

      // The installed version keeps serving under its approved state — the
      // upgrade coerced nothing.
      const row = await db.client.plugin.findUniqueOrThrow({ where: { id: plugin.id } });
      expect(row.version).toBe('1.2.0');
      expect(row.pendingVersion).toBe('1.3.0');
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

    it('household decide: owner passes; a plain member and an admin of ANOTHER household are both refused', async () => {
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

      const ok = await decideHousehold(
        ownerA,
        fixtureA.household.id,
        plugin.slug,
        granted('read:household_member'),
      ).expect(200);
      expect(ok.body.grant).toMatchObject({
        scopeType: PluginGrantScope.Household,
        scopeId: fixtureA.household.id,
        status: PluginGrantStatus.Granted,
      });

      // A plain member holds no manage:plugin:household rule — the coarse
      // gate refuses before anything else runs.
      await decideHousehold(memberA, fixtureA.household.id, plugin.slug, granted('read:household_member')).expect(403);

      // Owner of B addressing A: the type-level gate passes (they hold the
      // permission SOMEWHERE), so this pins the per-household instance gate.
      await decideHousehold(ownerB, fixtureA.household.id, plugin.slug, granted('read:household_member')).expect(403);
    });

    it('user decide: any authenticated user, for their own unit only — Granted creates the #225 anchor, Denied creates nothing', async () => {
      const user = await actors.user();
      const plugin = await arrangePlugin();

      await decideUser(user, plugin.slug, denied('update:user:profile:own')).expect(200);
      expect(await db.client.userPlugin.count({ where: { pluginId: plugin.id } })).toBe(0);

      await decideUser(user, plugin.slug, granted('update:user:profile:own')).expect(200);
      const units = await db.client.userPlugin.findMany({ where: { pluginId: plugin.id } });
      expect(units).toHaveLength(1);
      expect(units[0].suspendedForConsent).toBe(false);
    });

    it('D60-7: a household decision on a condition-free core check is the typed 403 exclusion', async () => {
      const owner = await actors.user();
      const fixture = await actors.householdWithMembers({ owner });
      const plugin = await arrangePlugin([
        MANAGE_DIGEST_CHECK,
        {
          slug: 'read:game',
          required: false,
          reason: { en: 'Lists games inside the digest.' },
          consentScope: 'household',
        },
      ]);

      const response = await decideHousehold(owner, fixture.household.id, plugin.slug, granted('read:game')).expect(
        403,
      );

      expect(response.body.code).toBe('PluginGrantExclusionError');
      expect(response.body.permissionSlug).toBe('read:game');
    });
  });

  describe('decide — shared semantics the endpoints inherit', () => {
    it('refuses a tombstoned plugin with 410 at every scope', async () => {
      const admin = await actors.admin();
      const owner = await actors.user();
      const fixture = await actors.householdWithMembers({ owner });
      const plugin = await arrangePlugin(DEFAULT_CHECKS, { uninstalledAt: new Date('2026-08-10T00:00:00Z') });

      const server = await decideServer(admin, plugin.slug, granted('read:safe_http_policy')).expect(410);
      expect(server.body.code).toBe('PluginGrantPluginTombstonedError');
      await decideHousehold(owner, fixture.household.id, plugin.slug, granted('read:household_member')).expect(410);
      await decideUser(owner, plugin.slug, granted('update:user:profile:own')).expect(410);
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
      expect(missing.body.code).toBe('PluginGrantPluginNotFoundError');
      expect(missing.body.slug).toBe('ghost-plugin');

      const unrequested = await decideServer(admin, plugin.slug, granted('read:game')).expect(422);
      expect(unrequested.body.code).toBe('PluginGrantUnknownPermissionError');

      // A household-consented check decided at server scope: the manifest
      // owns the scope, and the decision must address it there.
      const mismatched = await decideServer(admin, plugin.slug, granted('read:household_member')).expect(422);
      expect(mismatched.body.code).toBe('PluginGrantConsentScopeMismatchError');
    });
  });

  describe('unit suspension transitions (D-AR / D-BQ)', () => {
    it('late acceptance re-enables: the Granted decision that clears the last requirement lifts suspendedForConsent', async () => {
      const owner = await actors.user();
      const fixture = await actors.householdWithMembers({ owner });
      const plugin = await arrangePlugin();
      await db.client.householdPlugin.create({
        data: {
          householdId: fixture.household.id,
          pluginId: plugin.id,
          enabled: true,
          suspendedForConsent: true,
          suspendedAt: new Date('2026-08-15T00:00:00Z'),
        },
      });

      await decideHousehold(owner, fixture.household.id, plugin.slug, granted('read:household_member')).expect(200);

      // The re-enable pass is awaited inside decide(), so the flip is
      // visible as soon as the response is — no polling needed.
      const unit = await db.client.householdPlugin.findFirstOrThrow({ where: { pluginId: plugin.id } });
      expect(unit.suspendedForConsent).toBe(false);
      expect(unit.suspendedAt).toBeNull();
      expect(unit.enabled).toBe(true);
    });

    it('the D-BQ mirror: a denial that leaves a REQUIRED household check unsatisfied suspends the unit', async () => {
      const owner = await actors.user();
      const fixture = await actors.householdWithMembers({ owner });
      const plugin = await arrangePlugin();
      await db.client.householdPlugin.create({
        data: { householdId: fixture.household.id, pluginId: plugin.id, enabled: true },
      });

      await decideHousehold(owner, fixture.household.id, plugin.slug, denied('read:household_member')).expect(200);

      const unit = await db.client.householdPlugin.findFirstOrThrow({ where: { pluginId: plugin.id } });
      expect(unit.suspendedForConsent).toBe(true);
      expect(unit.suspendedAt).not.toBeNull();
      // Suspension, not an enabled flip: the admin's prior intent survives
      // for late acceptance to restore exactly.
      expect(unit.enabled).toBe(true);
    });

    it('an anchor created after a required denial is born suspended — decision order cannot put the unit in service (#359)', async () => {
      // Two required user checks, both against seeded user-conditioned
      // permissions, so the deny-then-grant order is exercisable.
      const RSVP_CHECK = {
        slug: 'update:event_attendee:status:self',
        required: true,
        reason: { en: 'Marks digest attendance suggestions on each member’s RSVP.' },
        consentScope: 'user',
      } as const;
      const user = await actors.user();
      const plugin = await arrangePlugin([MANAGE_DIGEST_CHECK, { ...USER_CHECK, required: true }, RSVP_CHECK]);

      // Deny required P first: no row exists yet, so there is nothing to
      // suspend — the absence of the row is what keeps the unit unserved.
      await decideUser(user, plugin.slug, denied(USER_CHECK.slug)).expect(200);
      expect(await db.client.userPlugin.count({ where: { pluginId: plugin.id } })).toBe(0);

      // Granting required Q creates the anchor (#225) — born suspended,
      // because P's refusal stands. Unsuspended, this unit would serve the
      // moment the row appeared, without the denial ever being consulted.
      await decideUser(user, plugin.slug, granted(RSVP_CHECK.slug)).expect(200);
      const unit = await db.client.userPlugin.findFirstOrThrow({ where: { pluginId: plugin.id } });
      expect(unit.suspendedForConsent).toBe(true);
      expect(unit.suspendedAt).not.toBeNull();
      expect(unit.enabled).toBe(true);

      // Late acceptance heals the birth state like any other suspension.
      await decideUser(user, plugin.slug, granted(USER_CHECK.slug)).expect(200);
      const healed = await db.client.userPlugin.findFirstOrThrow({ where: { pluginId: plugin.id } });
      expect(healed.suspendedForConsent).toBe(false);
      expect(healed.suspendedAt).toBeNull();
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
          manifestVersion: plugin.version,
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
      expect(bySlug.get('read:household_member')).toMatchObject({ decision: 'per-unit', decidableByUnit: false });
      expect(bySlug.get('update:user:profile:own')).toMatchObject({ decision: 'per-unit', decidableByUnit: false });
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

      await decideHousehold(ownerA, fixtureA.household.id, plugin.slug, denied('read:household_member')).expect(200);

      const response = await readHouseholdConsent(ownerA, fixtureA.household.id, plugin.slug).expect(200);
      const checks: { slug: string; decision: string; decidableByUnit: boolean }[] = response.body.presentation.checks;
      const household = checks.find((check) => check.slug === 'read:household_member');
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
      expect(checks.find((check) => check.slug === 'update:user:profile:own')).toMatchObject({
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

      await decideUser(user, plugin.slug, granted('update:user:profile:own')).expect(200);

      const response = await readUserConsent(user, plugin.slug).expect(200);
      const checks: { slug: string; decision: string }[] = response.body.presentation.checks;
      expect(checks.find((check) => check.slug === 'update:user:profile:own')).toMatchObject({
        decision: 'granted',
        decidableByUnit: true,
      });

      const missing = await readUserConsent(user, 'ghost-plugin').expect(404);
      expect(missing.body.code).toBe('PluginConsentPresentationNotFoundError');
      expect(missing.body.slug).toBe('ghost-plugin');

      const tombstoned = await arrangePlugin(DEFAULT_CHECKS, {
        slug: 'tombstoned-sink',
        uninstalledAt: new Date('2026-08-10T00:00:00Z'),
      });
      const gone = await readUserConsent(user, tombstoned.slug).expect(410);
      expect(gone.body.code).toBe('PluginConsentPresentationTombstonedError');
    });
  });
});
