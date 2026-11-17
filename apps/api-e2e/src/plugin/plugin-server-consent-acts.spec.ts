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
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import {
  readConsentSurface,
  reviewBody,
  sendReview,
  sendToggle,
  toggleBody,
  type ConsentSurface,
} from './consent-act-fixtures';
import { MANAGE_DIGEST_CHECK, type Check } from './manifest-checks';
import { FIXTURE_ACT_ID, pluginRowData } from './plugin-row-fixtures';

/**
 * The Server unit's consent acts end to end (#1336): a server admin grants or
 * refuses one optional server-scope requested permission with a toggle act,
 * and accepts a server-scope permission whose risk rose with a review act.
 * Each act names the sha and the risk the Server unit's consent surface
 * (`GET /api/plugins/:slug/consent`) showed, and writes the consent decisions
 * it carries.
 *
 * Every act body is built from that consent surface, read first. Plugin state
 * is arranged on the rows, as the other plugin suites arrange it; consent goes
 * only through the act routes. A risk rise is arranged on the consent
 * decision, by recording it at a risk below the catalog's current one: the
 * catalog of core permissions outlives each test, so it is never changed here.
 *
 * `read:safe_http_policy` is a seeded core permission, Medium and
 * condition-free, that a plugin may request at server scope.
 */
describe('server consent acts (#1336)', () => {
  const baseUrl = requireBaseUrl(process.env);
  const OTHER_SHA = 'c'.repeat(64);

  let db: TestDatabase;
  let actors: Actors;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  /** OPTIONAL at server scope: what a toggle act answers. */
  const POLICY_OPTIONAL: Check = {
    slug: 'read:safe_http_policy',
    required: false,
    reason: { en: 'Inspects the outbound policy before scheduling digest delivery.' },
    consentScope: 'server',
  };

  /** The same permission, REQUIRED at server scope: what holds the Server unit in review once its risk rose. */
  const POLICY_REQUIRED: Check = { ...POLICY_OPTIONAL, required: true };

  /**
   * A household-scope plugin manifest whose checks include server-scope ones,
   * under a fresh slug so one test can arrange several plugins; `bgeCompat`
   * widened to this workspace's build stamp.
   */
  const manifestWith = (checks: readonly Check[]): PluginManifest => {
    const slug = `srv-${randomUUID().slice(0, 8)}`;

    return buildPluginManifest({
      slug,
      version: '1.2.0',
      scope: 'household',
      bgeCompat: '>=0.0.0',
      events: { emits: [`plugin.${slug}.digest-sent`] },
      jobs: { queues: [`plugin.${slug}.digest`] },
      storage: { ownTables: [`plugin_${slug.replace(/-/g, '_')}_digests`] },
      permissions: { checks: [...checks] },
    });
  };

  /** A Server-unit consent decision, arranged on the row. */
  const seedServerDecision = (
    pluginId: string,
    permissionSlug: string,
    decidedRiskLevel: RiskLevel,
    status: PluginGrantStatus = PluginGrantStatus.Granted,
  ) =>
    db.client.pluginGrant.create({
      data: {
        pluginId,
        scopeType: PluginGrantScope.Server,
        scopeId: '',
        permissionSlug,
        status,
        actId: FIXTURE_ACT_ID,
        decidedAt: new Date(),
        decidedRiskLevel,
      },
    });

  /**
   * An installed plugin whose active manifest requests `checks`, with the
   * catalog row and the granted server decision its own declared permission
   * needs, so only the decisions a test arranges or acts on change the Server
   * unit's state.
   */
  const arrangePlugin = async (checks: readonly Check[], overrides: Record<string, unknown> = {}): Promise<Plugin> => {
    const active = manifestWith([MANAGE_DIGEST_CHECK, ...checks]);
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
    const ownSlug = `plugin|${plugin.slug}|manage:digest`;

    await db.client.pluginPermission.create({ data: { pluginId: plugin.id, slug: ownSlug, riskLevel: RiskLevel.Low } });
    await seedServerDecision(plugin.id, ownSlug, RiskLevel.Low);

    return plugin;
  };

  /**
   * A plugin whose required server-scope `read:safe_http_policy` was granted
   * at a risk below today's, so the Server unit owes a review of it.
   */
  const arrangeRiskRaised = async (overrides: Record<string, unknown> = {}): Promise<Plugin> => {
    const plugin = await arrangePlugin([POLICY_REQUIRED], overrides);

    await seedServerDecision(plugin.id, POLICY_REQUIRED.slug, RiskLevel.Low);

    return plugin;
  };

  const actsOf = (pluginId: string) =>
    db.client.pluginConsentAct.findMany({ where: { pluginId }, orderBy: { createdAt: 'asc' } });

  const decisionOf = (pluginId: string, permissionSlug: string) =>
    db.client.pluginGrant.findUnique({
      where: {
        pluginId_scopeType_scopeId_permissionSlug: {
          pluginId,
          scopeType: PluginGrantScope.Server,
          scopeId: '',
          permissionSlug,
        },
      },
    });

  /** The Server unit's state code, from `GET /api/plugins/:slug/features`. */
  const readServerState = async (actor: SessionActor, slug: string): Promise<string> => {
    const response = await request(baseUrl).get(`/api/plugins/${slug}/features`).set(actor.headers).expect(200);

    return response.body.featureState.state;
  };

  const riskShown = (surface: ConsentSurface, slug: string) =>
    surface.checks.find((check) => check.slug === slug)?.riskLevel;

  const presentedRisk = (presentation: unknown, slug: string) =>
    (presentation as { checks: { slug: string; riskLevel: string | null }[] }).checks.find(
      (check) => check.slug === slug,
    )?.riskLevel;

  // The e2e server supports `en` alone, so the toggle names `en` against an
  // `Accept-Language` the server cannot serve; the controller spec proves a
  // named locale beats the request's own (#1301).
  it("a server toggle stores its presentation in the locale it names, and refuses one the server doesn't support (#1301)", async () => {
    const admin = await actors.admin();
    const plugin = await arrangePlugin([POLICY_OPTIONAL]);
    const surface = await readConsentSurface(baseUrl, admin, 'server', plugin.slug);
    const toggleNaming = (locale: string) =>
      sendToggle(baseUrl, admin, 'server', plugin.slug, {
        ...toggleBody(surface, POLICY_OPTIONAL.slug, PluginGrantStatus.Granted),
        locale,
      }).set('Accept-Language', 'de');

    const refused = await toggleNaming('xx').expect(422);

    expect(refused.body).toMatchObject({ code: 'PLUGIN_CONSENT_ACT_LOCALE', locale: 'xx' });
    expect(await actsOf(plugin.id)).toEqual([]);
    expect(await decisionOf(plugin.id, POLICY_OPTIONAL.slug)).toBeNull();

    const toggled = await toggleNaming('en').expect(200);
    const [act] = await actsOf(plugin.id);

    expect(act).toMatchObject({ id: toggled.body.act.id, kind: PluginConsentActKind.Toggle });
    expect((act?.presentation as { locale?: string }).locale).toBe('en');
  });

  it('a server admin refuses, then grants, an optional server-scope permission: two acts, each naming the sha and the risk shown (#1336)', async () => {
    const admin = await actors.admin();
    const plugin = await arrangePlugin([POLICY_OPTIONAL]);
    const surface = await readConsentSurface(baseUrl, admin, 'server', plugin.slug);

    expect(surface.manifestSha256).toBe(plugin.installedSha256);
    expect(riskShown(surface, POLICY_OPTIONAL.slug)).toBe(RiskLevel.Medium);

    const refused = await sendToggle(
      baseUrl,
      admin,
      'server',
      plugin.slug,
      toggleBody(surface, POLICY_OPTIONAL.slug, PluginGrantStatus.Denied),
    ).expect(200);

    expect(refused.body).toMatchObject({ changed: true, act: { kind: PluginConsentActKind.Toggle } });

    const granted = await sendToggle(
      baseUrl,
      admin,
      'server',
      plugin.slug,
      toggleBody(surface, POLICY_OPTIONAL.slug, PluginGrantStatus.Granted),
    ).expect(200);

    expect(granted.body).toMatchObject({ changed: true, act: { kind: PluginConsentActKind.Toggle } });

    const acts = await actsOf(plugin.id);

    expect(acts.map((act) => act.id)).toEqual([refused.body.act.id, granted.body.act.id]);

    for (const act of acts) {
      expect(act).toMatchObject({
        scopeType: PluginGrantScope.Server,
        scopeId: '',
        kind: PluginConsentActKind.Toggle,
        manifestSha256: surface.manifestSha256,
        decidedById: admin.user.id,
      });
      expect(presentedRisk(act.presentation, POLICY_OPTIONAL.slug)).toBe(RiskLevel.Medium);
    }

    expect(await decisionOf(plugin.id, POLICY_OPTIONAL.slug)).toMatchObject({
      status: PluginGrantStatus.Granted,
      decidedRiskLevel: RiskLevel.Medium,
      decidedById: admin.user.id,
      actId: granted.body.act.id,
    });
  });

  it('a review clears a risk-raised server-scope permission: the Server unit reads review_pending before and on after (#1336)', async () => {
    const admin = await actors.admin();
    const plugin = await arrangeRiskRaised();

    expect(await readServerState(admin, plugin.slug)).toBe('review_pending');

    const surface = await readConsentSurface(baseUrl, admin, 'server', plugin.slug);

    expect(riskShown(surface, POLICY_REQUIRED.slug)).toBe(RiskLevel.Medium);

    const reviewed = await sendReview(
      baseUrl,
      admin,
      'server',
      plugin.slug,
      reviewBody(surface, { [POLICY_REQUIRED.slug]: PluginGrantStatus.Granted }),
    ).expect(200);

    expect(reviewed.body).toMatchObject({ changed: true, act: { kind: PluginConsentActKind.Review } });
    expect(await decisionOf(plugin.id, POLICY_REQUIRED.slug)).toMatchObject({
      status: PluginGrantStatus.Granted,
      decidedRiskLevel: RiskLevel.Medium,
      actId: reviewed.body.act.id,
    });
    expect(await readServerState(admin, plugin.slug)).toBe('on');
  });

  it('a server review that denies is refused 422 PLUGIN_CONSENT_ACT_ANSWER with rule server-refusal, and writes nothing (#1336)', async () => {
    const admin = await actors.admin();
    const plugin = await arrangePlugin([POLICY_OPTIONAL]);
    const surface = await readConsentSurface(baseUrl, admin, 'server', plugin.slug);

    const response = await sendReview(
      baseUrl,
      admin,
      'server',
      plugin.slug,
      reviewBody(surface, { [POLICY_OPTIONAL.slug]: PluginGrantStatus.Denied }),
    ).expect(422);

    expect(response.body).toMatchObject({
      code: 'PLUGIN_CONSENT_ACT_ANSWER',
      rule: 'server-refusal',
      permissionSlugs: [POLICY_OPTIONAL.slug],
    });
    expect(await actsOf(plugin.id)).toEqual([]);
    expect(await decisionOf(plugin.id, POLICY_OPTIONAL.slug)).toBeNull();
  });

  it('a server act naming another sha, or a risk that is not the current one, answers 409 PLUGIN_CONSENT_ACT_STALE and writes nothing (#1336)', async () => {
    const admin = await actors.admin();
    const plugin = await arrangePlugin([POLICY_OPTIONAL]);
    const surface = await readConsentSurface(baseUrl, admin, 'server', plugin.slug);
    const body = toggleBody(surface, POLICY_OPTIONAL.slug, PluginGrantStatus.Granted);

    const otherSha = await sendToggle(baseUrl, admin, 'server', plugin.slug, {
      ...body,
      manifestSha256: OTHER_SHA,
    }).expect(409);

    expect(otherSha.body).toMatchObject({ code: 'PLUGIN_CONSENT_ACT_STALE', slug: plugin.slug, kind: 'manifest' });

    // The catalog says Medium; the request says it was shown Low.
    const staleRisk = await sendToggle(baseUrl, admin, 'server', plugin.slug, {
      ...body,
      answer: { permissionSlug: POLICY_OPTIONAL.slug, status: PluginGrantStatus.Granted, riskLevel: RiskLevel.Low },
    }).expect(409);

    expect(staleRisk.body).toMatchObject({
      code: 'PLUGIN_CONSENT_ACT_STALE',
      kind: 'risk',
      staleRisks: [
        {
          permissionSlug: POLICY_OPTIONAL.slug,
          shownRiskLevel: RiskLevel.Low,
          currentRiskLevel: RiskLevel.Medium,
        },
      ],
    });
    expect(await actsOf(plugin.id)).toEqual([]);
    expect(await decisionOf(plugin.id, POLICY_OPTIONAL.slug)).toBeNull();
  });

  it('toggle and review work while the Server switch is off, and answer 410 for an uninstalled plugin (#1336)', async () => {
    const admin = await actors.admin();
    const plugin = await arrangeRiskRaised({ enabled: false });
    const toggled = await arrangePlugin([POLICY_OPTIONAL], { enabled: false });

    // Consenting before the plugin is switched on is a legitimate order.
    const reviewSurface = await readConsentSurface(baseUrl, admin, 'server', plugin.slug);
    const reviewed = await sendReview(
      baseUrl,
      admin,
      'server',
      plugin.slug,
      reviewBody(reviewSurface, { [POLICY_REQUIRED.slug]: PluginGrantStatus.Granted }),
    ).expect(200);

    expect(reviewed.body).toMatchObject({ changed: true, act: { kind: PluginConsentActKind.Review } });
    expect(await decisionOf(plugin.id, POLICY_REQUIRED.slug)).toMatchObject({
      decidedRiskLevel: RiskLevel.Medium,
      actId: reviewed.body.act.id,
    });

    const toggleSurface = await readConsentSurface(baseUrl, admin, 'server', toggled.slug);
    const toggledResponse = await sendToggle(
      baseUrl,
      admin,
      'server',
      toggled.slug,
      toggleBody(toggleSurface, POLICY_OPTIONAL.slug, PluginGrantStatus.Granted),
    ).expect(200);

    expect(toggledResponse.body).toMatchObject({ changed: true, act: { kind: PluginConsentActKind.Toggle } });
    expect(await decisionOf(toggled.id, POLICY_OPTIONAL.slug)).toMatchObject({
      status: PluginGrantStatus.Granted,
      actId: toggledResponse.body.act.id,
    });

    // Uninstalled after its consent surface was read.
    const uninstalled = await arrangePlugin([POLICY_OPTIONAL]);
    const uninstalledSurface = await readConsentSurface(baseUrl, admin, 'server', uninstalled.slug);

    await db.client.plugin.update({ where: { id: uninstalled.id }, data: { uninstalledAt: new Date() } });

    const goneToggle = await sendToggle(
      baseUrl,
      admin,
      'server',
      uninstalled.slug,
      toggleBody(uninstalledSurface, POLICY_OPTIONAL.slug, PluginGrantStatus.Granted),
    ).expect(410);
    const goneReview = await sendReview(
      baseUrl,
      admin,
      'server',
      uninstalled.slug,
      reviewBody(uninstalledSurface, { [POLICY_OPTIONAL.slug]: PluginGrantStatus.Granted }),
    ).expect(410);

    expect(goneToggle.body).toMatchObject({ slug: uninstalled.slug });
    expect(goneReview.body).toMatchObject({ slug: uninstalled.slug });
    expect(await actsOf(uninstalled.id)).toEqual([]);
    expect(await decisionOf(uninstalled.id, POLICY_OPTIONAL.slug)).toBeNull();
  });

  it('a plain user is refused 403 at the manage gate; an unauthenticated caller 401 (#1336)', async () => {
    const admin = await actors.admin();
    const user = await actors.user();
    const plugin = await arrangePlugin([POLICY_OPTIONAL]);
    const surface = await readConsentSurface(baseUrl, admin, 'server', plugin.slug);
    const toggle = toggleBody(surface, POLICY_OPTIONAL.slug, PluginGrantStatus.Granted);
    const review = reviewBody(surface, { [POLICY_OPTIONAL.slug]: PluginGrantStatus.Granted });

    await sendToggle(baseUrl, user, 'server', plugin.slug, toggle).expect(403);
    await sendReview(baseUrl, user, 'server', plugin.slug, review).expect(403);
    await request(baseUrl).post(`/api/plugins/${plugin.slug}/consent/toggle`).send(toggle).expect(401);
    await request(baseUrl).post(`/api/plugins/${plugin.slug}/consent/review`).send(review).expect(401);

    expect(await actsOf(plugin.id)).toEqual([]);
    expect(await decisionOf(plugin.id, POLICY_OPTIONAL.slug)).toBeNull();
  });

  it('a toggle sent twice answers 200 changed: false the second time, with one act (#1336)', async () => {
    const admin = await actors.admin();
    const plugin = await arrangePlugin([POLICY_OPTIONAL]);
    const surface = await readConsentSurface(baseUrl, admin, 'server', plugin.slug);
    const body = toggleBody(surface, POLICY_OPTIONAL.slug, PluginGrantStatus.Granted);

    const first = await sendToggle(baseUrl, admin, 'server', plugin.slug, body).expect(200);
    const decisionAfterFirst = await decisionOf(plugin.id, POLICY_OPTIONAL.slug);

    const second = await sendToggle(baseUrl, admin, 'server', plugin.slug, body).expect(200);

    expect(first.body).toMatchObject({ changed: true });
    expect(second.body).toMatchObject({ changed: false, act: null });
    expect(await actsOf(plugin.id)).toHaveLength(1);
    expect(await decisionOf(plugin.id, POLICY_OPTIONAL.slug)).toEqual(decisionAfterFirst);
  });

  // Every consent decision is written by a consent act, the Server unit's
  // included, so the database refuses a row that names none (#1336). Raw SQL,
  // because the generated client's types already refuse to build one.
  it('refuses a consent decision with no act at the database (#1336)', async () => {
    const plugin = await arrangePlugin([POLICY_OPTIONAL]);

    await expect(
      db.client.$executeRaw`INSERT INTO plugin_grants
          (id, plugin_id, scope_type, scope_id, permission_slug, status, decided_risk_level, decided_at, updated_at)
        VALUES (${randomUUID()}, ${plugin.id}, 'Server', '', ${POLICY_OPTIONAL.slug}, 'Granted', 'Medium', now(), now())`,
    ).rejects.toThrow(/act_id/);
  });
});
