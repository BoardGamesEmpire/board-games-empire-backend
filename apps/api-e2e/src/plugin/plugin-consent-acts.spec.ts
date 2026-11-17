import {
  PluginConsentActKind,
  PluginGrantScope,
  PluginGrantStatus,
  PluginLifecycleEventType,
  PluginScope,
  RiskLevel,
  SystemRole,
  type Plugin,
} from '@bge/database';
import { createActors, pollUntil, type Actors, type SessionActor } from '@bge/testing-e2e';
import { buildPluginManifest, type PluginManifest } from '@boardgamesempire/plugin-manifest';
import { inspect } from 'node:util';
import request from 'supertest';
import { createMemberClient } from '../household/household-request';
import { restoreShippedCatalog } from '../permission-catalog/shipped-catalog';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import {
  readConsentSurface,
  reviewBody,
  sendReview,
  sendSwitchOn,
  sendToggle,
  switchOnBody,
  toggleBody,
  unitPluginsPath,
  type ConsentActUnit,
  type ConsentSurface,
} from './consent-act-fixtures';
import { MANAGE_DIGEST_CHECK, type Check } from './manifest-checks';
import { pluginAbilitySlugsForHousehold } from './plugin-ability-fixtures';
import { FIXTURE_ACT_ID, INVENTORY_STAGING_ID, pluginRowData, stagedUpdateColumns } from './plugin-row-fixtures';

/**
 * Consent acts end to end (#1150): a household or a user switches a plugin on
 * by accepting its required set in one recorded consent act, changes an
 * optional permission with a toggle act, and answers what an update left
 * outstanding with a review act, pre-consent to a staged update included.
 *
 * Every act body is built from a consent surface the test read first, never
 * from constants, because the server refuses an act whose sha or risk moved
 * since its consent surface was read. Plugin state is arranged on the rows, as
 * the other plugin suites arrange it; consent goes only through the routes.
 */
describe('consent acts (#1150)', () => {
  const baseUrl = requireBaseUrl(process.env);
  const { changeRole, removeMember } = createMemberClient(baseUrl);
  const STAGED_SHA = 'b'.repeat(64);

  let db: TestDatabase;
  let actors: Actors;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  /** REQUIRED at household scope and bound to the fixture's feature. An allowlisted public read (#591). */
  const HOUSEHOLD_REQUIRED: Check = {
    slug: 'read:game:public',
    required: true,
    reason: { en: 'Lists the public games the household digest features.' },
    consentScope: 'household',
    feature: 'weekly-digest',
  };

  /** OPTIONAL at household scope. An allowlisted public read (#591). */
  const HOUSEHOLD_OPTIONAL: Check = {
    slug: 'read:media_object:public',
    required: false,
    reason: { en: 'Shows the cover images of the games the digest features.' },
    consentScope: 'household',
  };

  /** REQUIRED at user scope. An allowlisted public read (#591). */
  const USER_REQUIRED: Check = {
    slug: 'read:game_collection:public',
    required: true,
    reason: { en: 'Shows public collections in each member’s digest.' },
    consentScope: 'user',
  };

  /** A household-scope plugin manifest; `bgeCompat` widened to this workspace's build stamp. */
  const manifestWith = (version: string, checks: readonly Check[]): PluginManifest =>
    buildPluginManifest({
      version,
      scope: 'household',
      bgeCompat: '>=0.0.0',
      permissions: { checks: [...checks] },
    });

  /**
   * An installed, enabled household plugin whose active manifest requests
   * `checks`, with the row and the server decision its own declared
   * permission needs, so that only the unit's own consent decides whether its
   * state reads `on`.
   */
  const arrangePlugin = async (checks: readonly Check[], overrides: Record<string, unknown> = {}): Promise<Plugin> => {
    const active = manifestWith('1.2.0', checks);
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
    await db.client.pluginGrant.create({
      data: {
        pluginId: plugin.id,
        scopeType: PluginGrantScope.Server,
        scopeId: '',
        permissionSlug: ownSlug,
        status: PluginGrantStatus.Granted,
        actId: FIXTURE_ACT_ID,
        decidedAt: new Date(),
        decidedRiskLevel: RiskLevel.Low,
      },
    });

    return plugin;
  };

  /** A plugin with a staged update whose manifest requests `stagedChecks`. */
  const arrangeStagedPlugin = (activeChecks: readonly Check[], stagedChecks: readonly Check[]) =>
    arrangePlugin(
      activeChecks,
      stagedUpdateColumns({ manifest: manifestWith('1.3.0', stagedChecks), sha256: STAGED_SHA }),
    );

  const household = async () => {
    const owner = await actors.user();
    const { household: row } = await actors.householdWithMembers({ owner });

    return { owner, householdId: row.id, unit: { householdId: row.id } as ConsentActUnit };
  };

  const disable = (actor: SessionActor, unit: ConsentActUnit, slug: string) =>
    request(baseUrl)
      .post(`${unitPluginsPath(unit)}/${slug}/disable`)
      .set(actor.headers)
      .send({});

  const readFeatureState = async (actor: SessionActor, unit: ConsentActUnit, slug: string) =>
    (
      await request(baseUrl)
        .get(`${unitPluginsPath(unit)}/${slug}/features`)
        .set(actor.headers)
        .expect(200)
    ).body.featureState;

  const approve = (actor: SessionActor, slug: string) =>
    request(baseUrl)
      .post(`/api/plugins/${slug}/update/approve`)
      .set(actor.headers)
      .send({ stagingId: INVENTORY_STAGING_ID });

  const reject = (actor: SessionActor, slug: string) =>
    request(baseUrl)
      .post(`/api/plugins/${slug}/update/reject`)
      .set(actor.headers)
      .send({ stagingId: INVENTORY_STAGING_ID });

  const actsAt = (pluginId: string, scopeType: PluginGrantScope, scopeId: string) =>
    db.client.pluginConsentAct.findMany({ where: { pluginId, scopeType, scopeId }, orderBy: { createdAt: 'asc' } });

  const decisionsAt = (pluginId: string, scopeType: PluginGrantScope, scopeId: string) =>
    db.client.pluginGrant.findMany({
      where: { pluginId, scopeType, scopeId },
      orderBy: { permissionSlug: 'asc' },
    });

  const householdUnit = (householdId: string, pluginId: string) =>
    db.client.householdPlugin.findUnique({ where: { householdId_pluginId: { householdId, pluginId } } });

  /** Nothing an act writes exists for the household: no act, no consent decision, no unit enablement. */
  const expectNothingWritten = async (pluginId: string, householdId: string) => {
    expect(await actsAt(pluginId, PluginGrantScope.Household, householdId)).toEqual([]);
    expect(await decisionsAt(pluginId, PluginGrantScope.Household, householdId)).toEqual([]);
    expect(await householdUnit(householdId, pluginId)).toBeNull();
  };

  const checkOf = (surface: ConsentSurface, slug: string) => surface.checks.find((check) => check.slug === slug);

  describe('switch-on', () => {
    it('a household switch-on against the active sha grants the required set and the chosen optional ones, switches the plugin on, and records one act matching the consent surface (#1150)', async () => {
      const { owner, householdId, unit } = await household();
      const plugin = await arrangePlugin([MANAGE_DIGEST_CHECK, HOUSEHOLD_REQUIRED, HOUSEHOLD_OPTIONAL]);
      const surface = await readConsentSurface(baseUrl, owner, unit, plugin.slug);

      expect(surface.manifestSha256).toBe(plugin.installedSha256);
      expect(surface.stagedUpdate).toBeNull();

      const response = await sendSwitchOn(
        baseUrl,
        owner,
        unit,
        plugin.slug,
        switchOnBody(surface, {
          [HOUSEHOLD_REQUIRED.slug]: PluginGrantStatus.Granted,
          [HOUSEHOLD_OPTIONAL.slug]: PluginGrantStatus.Granted,
        }),
      ).expect(200);

      expect(response.body).toMatchObject({
        changed: true,
        switchedOff: false,
        act: { kind: PluginConsentActKind.SwitchOn },
        unit: { enabled: true },
      });

      const acts = await actsAt(plugin.id, PluginGrantScope.Household, householdId);

      expect(acts).toHaveLength(1);

      const [act] = acts;

      expect(act).toMatchObject({
        id: response.body.act.id,
        pluginSlug: plugin.slug,
        kind: PluginConsentActKind.SwitchOn,
        manifestVersion: plugin.version,
        manifestSha256: surface.manifestSha256,
        decidedById: owner.user.id,
      });

      // The act records what the consent surface showed this household: the
      // requested permissions it decides, with their copy and risk.
      const shown = surface.checks
        .filter((check) => check.decidableByUnit)
        .map((check) => ({
          slug: check.slug,
          required: check.required,
          feature: check.feature,
          riskLevel: check.riskLevel,
          reason: check.reason.value,
        }));
      const recorded = (
        act?.presentation as {
          checks: { slug: string; required: boolean; feature: string | null; riskLevel: string; reason: string }[];
        }
      ).checks.map(({ slug, required, feature, riskLevel, reason }) => ({
        slug,
        required,
        feature,
        riskLevel,
        reason,
      }));

      expect(shown).toHaveLength(2);
      expect(recorded).toEqual(shown);

      const decisions = await decisionsAt(plugin.id, PluginGrantScope.Household, householdId);

      expect(decisions).toHaveLength(2);
      expect(decisions.map((decision) => decision.actId)).toEqual([act?.id, act?.id]);
      expect(decisions).toEqual(
        expect.arrayContaining(
          [HOUSEHOLD_REQUIRED.slug, HOUSEHOLD_OPTIONAL.slug].map((slug) =>
            expect.objectContaining({
              permissionSlug: slug,
              status: PluginGrantStatus.Granted,
              decidedRiskLevel: checkOf(surface, slug)?.riskLevel,
            }),
          ),
        ),
      );
      expect(await householdUnit(householdId, plugin.id)).toMatchObject({ enabled: true });
      expect((await readFeatureState(owner, unit, plugin.slug)).state).toBe('on');
    });

    it('a switch-on naming a stale sha is refused with 409 and writes nothing (#1150)', async () => {
      const { owner, householdId, unit } = await household();
      const plugin = await arrangePlugin([MANAGE_DIGEST_CHECK, HOUSEHOLD_REQUIRED]);
      const surface = await readConsentSurface(baseUrl, owner, unit, plugin.slug);

      // The installed artifact changed after the consent surface was read.
      await db.client.plugin.update({ where: { id: plugin.id }, data: { installedSha256: 'c'.repeat(64) } });

      const response = await sendSwitchOn(
        baseUrl,
        owner,
        unit,
        plugin.slug,
        switchOnBody(surface, { [HOUSEHOLD_REQUIRED.slug]: PluginGrantStatus.Granted }),
      ).expect(409);

      expect(response.body).toMatchObject({ code: 'PLUGIN_CONSENT_ACT_STALE', slug: plugin.slug, kind: 'manifest' });
      await expectNothingWritten(plugin.id, householdId);
    });

    it('a switch-on granting less than the required set is refused with 422 and writes nothing (#1150)', async () => {
      const { owner, householdId, unit } = await household();
      const plugin = await arrangePlugin([MANAGE_DIGEST_CHECK, HOUSEHOLD_REQUIRED, HOUSEHOLD_OPTIONAL]);
      const surface = await readConsentSurface(baseUrl, owner, unit, plugin.slug);

      const missing = await sendSwitchOn(
        baseUrl,
        owner,
        unit,
        plugin.slug,
        switchOnBody(surface, { [HOUSEHOLD_OPTIONAL.slug]: PluginGrantStatus.Granted }),
      ).expect(422);

      expect(missing.body).toMatchObject({
        code: 'PLUGIN_CONSENT_ACT_REQUIRED_SET',
        missingSlugs: [HOUSEHOLD_REQUIRED.slug],
        refusedSlugs: [],
      });

      const refused = await sendSwitchOn(
        baseUrl,
        owner,
        unit,
        plugin.slug,
        switchOnBody(surface, { [HOUSEHOLD_REQUIRED.slug]: PluginGrantStatus.Denied }),
      ).expect(422);

      expect(refused.body).toMatchObject({
        code: 'PLUGIN_CONSENT_ACT_REQUIRED_SET',
        missingSlugs: [],
        refusedSlugs: [HOUSEHOLD_REQUIRED.slug],
      });
      await expectNothingWritten(plugin.id, householdId);
    });

    it('a switch-on is refused with 409 when a risk level rose after the consent surface was read (#1150)', async () => {
      const catalogOwner = await actors.owner();
      const { owner, householdId, unit } = await household();
      const plugin = await arrangePlugin([MANAGE_DIGEST_CHECK, HOUSEHOLD_REQUIRED]);
      const surface = await readConsentSurface(baseUrl, owner, unit, plugin.slug);

      expect(checkOf(surface, HOUSEHOLD_REQUIRED.slug)?.riskLevel).toBe(RiskLevel.Low);

      try {
        // Raised through the permission catalog route, as the Owner raises it (#772).
        await request(baseUrl)
          .patch(`/api/permission-catalog/permissions/${HOUSEHOLD_REQUIRED.slug}`)
          .set(catalogOwner.headers)
          .send({ riskLevel: RiskLevel.Medium })
          .expect(200);

        const refused = await sendSwitchOn(
          baseUrl,
          owner,
          unit,
          plugin.slug,
          switchOnBody(surface, { [HOUSEHOLD_REQUIRED.slug]: PluginGrantStatus.Granted }),
        ).expect(409);

        expect(refused.body).toMatchObject({
          code: 'PLUGIN_CONSENT_ACT_STALE',
          slug: plugin.slug,
          kind: 'risk',
          staleRisks: [
            {
              permissionSlug: HOUSEHOLD_REQUIRED.slug,
              shownRiskLevel: RiskLevel.Low,
              currentRiskLevel: RiskLevel.Medium,
            },
          ],
        });
        await expectNothingWritten(plugin.id, householdId);

        // Read again, the consent surface shows the new risk, and the act it
        // builds is stamped at it.
        const reread = await readConsentSurface(baseUrl, owner, unit, plugin.slug);

        expect(checkOf(reread, HOUSEHOLD_REQUIRED.slug)?.riskLevel).toBe(RiskLevel.Medium);

        await sendSwitchOn(
          baseUrl,
          owner,
          unit,
          plugin.slug,
          switchOnBody(reread, { [HOUSEHOLD_REQUIRED.slug]: PluginGrantStatus.Granted }),
        ).expect(200);

        expect(await decisionsAt(plugin.id, PluginGrantScope.Household, householdId)).toEqual([
          expect.objectContaining({
            permissionSlug: HOUSEHOLD_REQUIRED.slug,
            status: PluginGrantStatus.Granted,
            decidedRiskLevel: RiskLevel.Medium,
          }),
        ]);
      } finally {
        await restoreShippedCatalog(db.client);
      }
    });

    it('a switch-on whose required set holds a permission that cannot be granted is refused and names it (#1150)', async () => {
      const { owner, householdId, unit } = await household();
      const UNGRANTABLE: Check = {
        slug: 'read:platform_game',
        required: true,
        reason: { en: 'Lists the platforms each game runs on.' },
        consentScope: 'household',
      };
      const plugin = await arrangePlugin([MANAGE_DIGEST_CHECK, UNGRANTABLE]);
      const surface = await readConsentSurface(baseUrl, owner, unit, plugin.slug);

      expect(checkOf(surface, UNGRANTABLE.slug)).toMatchObject({ decidableByUnit: true, grantable: false });

      // The client does what the consent surface says and leaves out the
      // permission it marked not grantable. The refusal names it, rather than
      // asking for a required set the household cannot grant.
      const omitted = await sendSwitchOn(baseUrl, owner, unit, plugin.slug, switchOnBody(surface)).expect(409);
      // A client that names it anyway is refused the same way.
      const named = await sendSwitchOn(
        baseUrl,
        owner,
        unit,
        plugin.slug,
        switchOnBody(surface, { [UNGRANTABLE.slug]: PluginGrantStatus.Granted }),
      ).expect(409);

      for (const response of [omitted, named]) {
        expect(response.body).toMatchObject({
          code: 'PLUGIN_CONSENT_ACT_UNGRANTABLE',
          slug: plugin.slug,
          // Condition-free, so it does not bind the consenting household (#591).
          permissions: [{ permissionSlug: UNGRANTABLE.slug, cause: 'unbound_unit_scope' }],
        });
      }
      await expectNothingWritten(plugin.id, householdId);
    });

    it("a user's switch-on creates their unit enablement, and nobody else can do it for them (#1150)", async () => {
      // The user routes address only /users/me, so no request can name
      // another user: one user's switch-on is theirs alone.
      const [user, other] = await Promise.all([actors.user(), actors.user()]);
      const plugin = await arrangePlugin([MANAGE_DIGEST_CHECK, USER_REQUIRED]);
      const surface = await readConsentSurface(baseUrl, user, 'me', plugin.slug);

      const response = await sendSwitchOn(
        baseUrl,
        user,
        'me',
        plugin.slug,
        switchOnBody(surface, { [USER_REQUIRED.slug]: PluginGrantStatus.Granted }),
      ).expect(200);

      expect(response.body).toMatchObject({
        changed: true,
        act: { kind: PluginConsentActKind.SwitchOn },
        unit: { userId: user.user.id, enabled: true },
      });
      expect(
        await db.client.userPlugin.findUnique({
          where: { userId_pluginId: { userId: user.user.id, pluginId: plugin.id } },
        }),
      ).toMatchObject({ enabled: true });
      expect(await actsAt(plugin.id, PluginGrantScope.User, user.user.id)).toEqual([
        expect.objectContaining({ id: response.body.act.id, decidedById: user.user.id }),
      ]);
      expect(await decisionsAt(plugin.id, PluginGrantScope.User, user.user.id)).toEqual([
        expect.objectContaining({
          permissionSlug: USER_REQUIRED.slug,
          status: PluginGrantStatus.Granted,
          actId: response.body.act.id,
        }),
      ]);

      // The other user has no unit enablement, no act and no consent
      // decision, and their own consent surface and state still read off.
      expect(
        await db.client.userPlugin.findUnique({
          where: { userId_pluginId: { userId: other.user.id, pluginId: plugin.id } },
        }),
      ).toBeNull();
      expect(await actsAt(plugin.id, PluginGrantScope.User, other.user.id)).toEqual([]);
      expect(await decisionsAt(plugin.id, PluginGrantScope.User, other.user.id)).toEqual([]);
      expect(checkOf(await readConsentSurface(baseUrl, other, 'me', plugin.slug), USER_REQUIRED.slug)?.decision).toBe(
        'pending',
      );
      expect(await readFeatureState(other, 'me', plugin.slug)).toMatchObject({ served: false, state: 'off' });
    });

    it("a user's switch-on of a plugin that requests nothing at user scope is refused with 422 and writes nothing (#381, #1150)", async () => {
      // A user's switch-on accepts the plugin's user-scope requests. This
      // plugin makes none, so the switch-on would accept nothing and its unit
      // enablement would confer nothing.
      const user = await actors.user();
      const plugin = await arrangePlugin([MANAGE_DIGEST_CHECK, HOUSEHOLD_REQUIRED]);
      const surface = await readConsentSurface(baseUrl, user, 'me', plugin.slug);

      const refused = await sendSwitchOn(baseUrl, user, 'me', plugin.slug, switchOnBody(surface)).expect(422);

      expect(refused.body).toMatchObject({ code: 'PLUGIN_CONSENT_ACT_NO_USER_SCOPE', slug: plugin.slug });
      expect(
        await db.client.userPlugin.findUnique({
          where: { userId_pluginId: { userId: user.user.id, pluginId: plugin.id } },
        }),
      ).toBeNull();
      expect(await actsAt(plugin.id, PluginGrantScope.User, user.user.id)).toEqual([]);
    });

    it('switching a plugin on again over decisions that already stand records an act, and its lifecycle row names it (#1150)', async () => {
      // The decisions change nothing here, so no consent decision event
      // carries the act id. The unit's own switch event has to.
      const { owner, householdId, unit } = await household();
      const plugin = await arrangePlugin([MANAGE_DIGEST_CHECK, HOUSEHOLD_REQUIRED]);
      const surface = await readConsentSurface(baseUrl, owner, unit, plugin.slug);
      const body = switchOnBody(surface, { [HOUSEHOLD_REQUIRED.slug]: PluginGrantStatus.Granted });

      await sendSwitchOn(baseUrl, owner, unit, plugin.slug, body).expect(200);
      await disable(owner, unit, plugin.slug).expect(200);

      const again = await sendSwitchOn(baseUrl, owner, unit, plugin.slug, body).expect(200);

      expect(again.body).toMatchObject({ changed: true, unit: { enabled: true } });

      const actId = again.body.act.id as string;

      // The lifecycle listener writes after the response.
      const row = await pollUntil(
        async () =>
          (
            await db.client.pluginLifecycleEvent.findMany({
              where: { pluginId: plugin.id, event: PluginLifecycleEventType.Enabled, scopeId: householdId },
            })
          ).find((event) => (event.payload as { actId?: unknown } | null)?.actId === actId),
        { description: `the re-switch-on's enabled lifecycle row for '${plugin.slug}'`, timeoutMs: 5_000 },
      );

      expect(row).toMatchObject({ scopeType: PluginGrantScope.Household, manifestVersion: '1.2.0' });
    });

    it('a switch-on sent twice changes nothing the second time (#1150)', async () => {
      const { owner, householdId, unit } = await household();
      const plugin = await arrangePlugin([MANAGE_DIGEST_CHECK, HOUSEHOLD_REQUIRED]);
      const surface = await readConsentSurface(baseUrl, owner, unit, plugin.slug);
      const body = switchOnBody(surface, { [HOUSEHOLD_REQUIRED.slug]: PluginGrantStatus.Granted });

      await sendSwitchOn(baseUrl, owner, unit, plugin.slug, body).expect(200);

      const decisionsBefore = await decisionsAt(plugin.id, PluginGrantScope.Household, householdId);
      const unitBefore = await householdUnit(householdId, plugin.id);

      const again = await sendSwitchOn(baseUrl, owner, unit, plugin.slug, body).expect(200);

      expect(again.body).toMatchObject({ changed: false, switchedOff: false, act: null, unit: { enabled: true } });
      expect(await actsAt(plugin.id, PluginGrantScope.Household, householdId)).toHaveLength(1);
      expect(await decisionsAt(plugin.id, PluginGrantScope.Household, householdId)).toEqual(decisionsBefore);
      expect(await householdUnit(householdId, plugin.id)).toEqual(unitBefore);
    });

    it('a switch-on response carries no stored dormancy (#1151)', async () => {
      // A unit enablement holds the household's switch and its configuration
      // document only. Whether the unit can run is worked out when read, so
      // the unit a consent act answers with names no dormancy of its own.
      const { owner, unit } = await household();
      const plugin = await arrangePlugin([MANAGE_DIGEST_CHECK, HOUSEHOLD_REQUIRED]);
      const surface = await readConsentSurface(baseUrl, owner, unit, plugin.slug);

      const response = await sendSwitchOn(
        baseUrl,
        owner,
        unit,
        plugin.slug,
        switchOnBody(surface, { [HOUSEHOLD_REQUIRED.slug]: PluginGrantStatus.Granted }),
      ).expect(200);

      expect(response.body.unit).toMatchObject({ enabled: true });
      expect(response.body.unit).not.toHaveProperty('dormantReason');
      expect(response.body.unit).not.toHaveProperty('dormantAt');
    });

    it('refuses a switch-on with no configuration when {} fails the schema, though the manifest does not require configuration (#1151)', async () => {
      // A household with no unit enablement holds `{}`, and the read works out
      // its dormancy from that document. A switch-on that left the unit
      // switched on over a document the schema rejects would read
      // needs_configuration at once, so the gate judges the document whether
      // or not the manifest sets requiresHouseholdConfig.
      const { owner, householdId, unit } = await household();
      const checks = [MANAGE_DIGEST_CHECK, HOUSEHOLD_REQUIRED];
      const active = manifestWith('1.2.0', checks);
      const plugin = await arrangePlugin(checks, {
        manifestJson: {
          ...active,
          config: {
            schema: { type: 'object', properties: { webhookUrl: { type: 'string' } }, required: ['webhookUrl'] },
            requiresHouseholdConfig: false,
          },
        },
      });
      const surface = await readConsentSurface(baseUrl, owner, unit, plugin.slug);
      const body = switchOnBody(surface, { [HOUSEHOLD_REQUIRED.slug]: PluginGrantStatus.Granted });

      const refused = await sendSwitchOn(baseUrl, owner, unit, plugin.slug, body).expect(409);

      expect(refused.body).toMatchObject({
        code: 'PLUGIN_UNIT_CONFIG_REQUIRED',
        slug: plugin.slug,
        issues: [expect.objectContaining({ keyword: 'required' })],
      });
      expect(await db.client.pluginConsentAct.count({ where: { pluginId: plugin.id } })).toBe(0);
      await expectNothingWritten(plugin.id, householdId);

      // The control: the same switch-on supplying a conforming document is
      // accepted, so the refusal above is the configuration gate's.
      const config = { webhookUrl: 'https://example.test/hook' };

      await sendSwitchOn(baseUrl, owner, unit, plugin.slug, { ...body, config }).expect(200);
      expect(await householdUnit(householdId, plugin.id)).toMatchObject({ enabled: true, config });
    });
  });

  describe('toggle', () => {
    it('a toggle flips one optional permission and records an act; on a switched-off plugin it is refused (#1150)', async () => {
      const { owner, householdId, unit } = await household();
      const plugin = await arrangePlugin([MANAGE_DIGEST_CHECK, HOUSEHOLD_REQUIRED, HOUSEHOLD_OPTIONAL]);
      const surface = await readConsentSurface(baseUrl, owner, unit, plugin.slug);

      await sendSwitchOn(
        baseUrl,
        owner,
        unit,
        plugin.slug,
        switchOnBody(surface, { [HOUSEHOLD_REQUIRED.slug]: PluginGrantStatus.Granted }),
      ).expect(200);

      const toggled = await sendToggle(
        baseUrl,
        owner,
        unit,
        plugin.slug,
        toggleBody(surface, HOUSEHOLD_OPTIONAL.slug, PluginGrantStatus.Granted),
      ).expect(200);

      expect(toggled.body).toMatchObject({ changed: true, act: { kind: PluginConsentActKind.Toggle } });

      const optionalDecision = () =>
        db.client.pluginGrant.findFirst({
          where: { pluginId: plugin.id, scopeId: householdId, permissionSlug: HOUSEHOLD_OPTIONAL.slug },
        });

      expect(await optionalDecision()).toMatchObject({
        status: PluginGrantStatus.Granted,
        actId: toggled.body.act.id,
      });
      expect(await actsAt(plugin.id, PluginGrantScope.Household, householdId)).toHaveLength(2);

      await disable(owner, unit, plugin.slug).expect(200);

      const refused = await sendToggle(
        baseUrl,
        owner,
        unit,
        plugin.slug,
        toggleBody(surface, HOUSEHOLD_OPTIONAL.slug, PluginGrantStatus.Denied),
      ).expect(409);

      expect(refused.body).toMatchObject({ code: 'PLUGIN_CONSENT_ACT_UNIT_OFF', scopeType: 'Household' });

      // A review needs the unit switched on as well (#1150). It answers what
      // already stands, so no other rule could refuse it: only the unit being
      // off does.
      const reviewRefused = await sendReview(
        baseUrl,
        owner,
        unit,
        plugin.slug,
        reviewBody(surface, { [HOUSEHOLD_OPTIONAL.slug]: PluginGrantStatus.Granted }),
      ).expect(409);

      expect(reviewRefused.body).toMatchObject({ code: 'PLUGIN_CONSENT_ACT_UNIT_OFF', scopeType: 'Household' });
      expect(await optionalDecision()).toMatchObject({
        status: PluginGrantStatus.Granted,
        actId: toggled.body.act.id,
      });
      expect(await actsAt(plugin.id, PluginGrantScope.Household, householdId)).toHaveLength(2);
    });

    it('a toggle or a review on a household with no unit enablement is refused and writes nothing (#1150)', async () => {
      const { owner, householdId, unit } = await household();
      const plugin = await arrangePlugin([MANAGE_DIGEST_CHECK, HOUSEHOLD_OPTIONAL]);
      const surface = await readConsentSurface(baseUrl, owner, unit, plugin.slug);

      const toggled = await sendToggle(
        baseUrl,
        owner,
        unit,
        plugin.slug,
        toggleBody(surface, HOUSEHOLD_OPTIONAL.slug, PluginGrantStatus.Granted),
      ).expect(409);
      const reviewed = await sendReview(
        baseUrl,
        owner,
        unit,
        plugin.slug,
        reviewBody(surface, { [HOUSEHOLD_OPTIONAL.slug]: PluginGrantStatus.Granted }),
      ).expect(409);

      expect(toggled.body).toMatchObject({ code: 'PLUGIN_CONSENT_ACT_UNIT_OFF', scopeType: 'Household' });
      expect(reviewed.body).toMatchObject({ code: 'PLUGIN_CONSENT_ACT_UNIT_OFF', scopeType: 'Household' });
      await expectNothingWritten(plugin.id, householdId);
    });
  });

  describe('review', () => {
    it('a review that refuses a newly required permission writes the denial and switches the unit off in one act; switching on again grants it (#1150)', async () => {
      const { owner, householdId, unit } = await household();
      const plugin = await arrangePlugin([MANAGE_DIGEST_CHECK]);
      const before = await readConsentSurface(baseUrl, owner, unit, plugin.slug);

      await sendSwitchOn(baseUrl, owner, unit, plugin.slug, switchOnBody(before)).expect(200);

      // What an activation leaves behind, arranged on the row: a manifest
      // that requires a household permission nobody has answered yet.
      const next = manifestWith('1.3.0', [MANAGE_DIGEST_CHECK, HOUSEHOLD_REQUIRED]);
      await db.client.plugin.update({
        where: { id: plugin.id },
        data: { version: next.version, manifestJson: next as never, installedSha256: 'c'.repeat(64) },
      });

      const surface = await readConsentSurface(baseUrl, owner, unit, plugin.slug);

      expect(checkOf(surface, HOUSEHOLD_REQUIRED.slug)?.decision).toBe('pending');

      const reviewed = await sendReview(
        baseUrl,
        owner,
        unit,
        plugin.slug,
        reviewBody(surface, { [HOUSEHOLD_REQUIRED.slug]: PluginGrantStatus.Denied }),
      ).expect(200);

      expect(reviewed.body).toMatchObject({
        changed: true,
        switchedOff: true,
        act: { kind: PluginConsentActKind.Review },
        unit: { enabled: false },
      });
      expect(await decisionsAt(plugin.id, PluginGrantScope.Household, householdId)).toEqual([
        expect.objectContaining({
          permissionSlug: HOUSEHOLD_REQUIRED.slug,
          status: PluginGrantStatus.Denied,
          actId: reviewed.body.act.id,
        }),
      ]);
      expect(await householdUnit(householdId, plugin.id)).toMatchObject({ enabled: false });

      // The same review sent again, as a client that lost the response sends
      // it: nothing changes, and it answers as the first attempt did.
      const retried = await sendReview(
        baseUrl,
        owner,
        unit,
        plugin.slug,
        reviewBody(surface, { [HOUSEHOLD_REQUIRED.slug]: PluginGrantStatus.Denied }),
      ).expect(200);

      expect(retried.body).toMatchObject({ changed: false, switchedOff: true, act: null, unit: { enabled: false } });
      expect(retried.body.message).toBe(reviewed.body.message);
      expect(await actsAt(plugin.id, PluginGrantScope.Household, householdId)).toHaveLength(2);

      const again = await readConsentSurface(baseUrl, owner, unit, plugin.slug);
      const switchedOn = await sendSwitchOn(
        baseUrl,
        owner,
        unit,
        plugin.slug,
        switchOnBody(again, { [HOUSEHOLD_REQUIRED.slug]: PluginGrantStatus.Granted }),
      ).expect(200);

      expect(await decisionsAt(plugin.id, PluginGrantScope.Household, householdId)).toEqual([
        expect.objectContaining({
          permissionSlug: HOUSEHOLD_REQUIRED.slug,
          status: PluginGrantStatus.Granted,
          actId: switchedOn.body.act.id,
        }),
      ]);
      expect(await householdUnit(householdId, plugin.id)).toMatchObject({ enabled: true });
      expect(await actsAt(plugin.id, PluginGrantScope.Household, householdId)).toHaveLength(3);
    });

    it('a review that refuses a required permission whose denial already stands still switches the unit off and records the act (#1150)', async () => {
      const { owner, householdId, unit } = await household();
      const optional = { ...HOUSEHOLD_REQUIRED, required: false };
      const plugin = await arrangePlugin([MANAGE_DIGEST_CHECK, optional]);
      const before = await readConsentSurface(baseUrl, owner, unit, plugin.slug);

      // Switched on with the permission refused while it was optional.
      await sendSwitchOn(
        baseUrl,
        owner,
        unit,
        plugin.slug,
        switchOnBody(before, { [HOUSEHOLD_REQUIRED.slug]: PluginGrantStatus.Denied }),
      ).expect(200);

      // What an activation leaves behind, arranged on the row: the same
      // permission, now required, with its denial still standing on a unit
      // that is switched on.
      const next = manifestWith('1.3.0', [MANAGE_DIGEST_CHECK, HOUSEHOLD_REQUIRED]);
      await db.client.plugin.update({
        where: { id: plugin.id },
        data: { version: next.version, manifestJson: next as never, installedSha256: 'c'.repeat(64) },
      });
      const actsBefore = await actsAt(plugin.id, PluginGrantScope.Household, householdId);

      const surface = await readConsentSurface(baseUrl, owner, unit, plugin.slug);

      expect(checkOf(surface, HOUSEHOLD_REQUIRED.slug)).toMatchObject({ required: true, decision: 'denied' });

      const reviewed = await sendReview(
        baseUrl,
        owner,
        unit,
        plugin.slug,
        reviewBody(surface, { [HOUSEHOLD_REQUIRED.slug]: PluginGrantStatus.Denied }),
      ).expect(200);

      expect(reviewed.body).toMatchObject({
        message: `Plugin '${plugin.slug}' was switched off because a required permission was declined`,
        changed: true,
        switchedOff: true,
        act: { kind: PluginConsentActKind.Review },
        unit: { enabled: false },
      });

      const acts = await actsAt(plugin.id, PluginGrantScope.Household, householdId);
      expect(acts).toHaveLength(actsBefore.length + 1);
      expect(acts.at(-1)).toMatchObject({ id: reviewed.body.act.id, kind: PluginConsentActKind.Review });
      expect(await decisionsAt(plugin.id, PluginGrantScope.Household, householdId)).toEqual([
        expect.objectContaining({
          permissionSlug: HOUSEHOLD_REQUIRED.slug,
          status: PluginGrantStatus.Denied,
          actId: reviewed.body.act.id,
        }),
      ]);
      expect(await householdUnit(householdId, plugin.id)).toMatchObject({ enabled: false });
    });
  });

  describe('pre-consent to a staged update', () => {
    it('a review against the staged sha is accepted while the update is staged, confers nothing until activation, and leaves nothing to ask after it (#1150)', async () => {
      const admin = await actors.admin();
      const { owner, householdId, unit } = await household();
      const plugin = await arrangeStagedPlugin([MANAGE_DIGEST_CHECK], [MANAGE_DIGEST_CHECK, HOUSEHOLD_REQUIRED]);
      const active = await readConsentSurface(baseUrl, owner, unit, plugin.slug);

      // The consent surface names both shas: the active one, and the staged
      // update a household may pre-consent to.
      expect(active.manifestSha256).toBe(plugin.installedSha256);
      expect(active.stagedUpdate).toEqual({ manifestVersion: '1.3.0', manifestSha256: STAGED_SHA });

      await sendSwitchOn(baseUrl, owner, unit, plugin.slug, switchOnBody(active)).expect(200);

      const staged = await readConsentSurface(baseUrl, owner, unit, plugin.slug, { staged: true });

      expect(staged.manifestSha256).toBe(STAGED_SHA);
      expect(checkOf(staged, HOUSEHOLD_REQUIRED.slug)).toMatchObject({ decidableByUnit: true, stagedOnly: true });

      const reviewed = await sendReview(
        baseUrl,
        owner,
        unit,
        plugin.slug,
        reviewBody(staged, { [HOUSEHOLD_REQUIRED.slug]: PluginGrantStatus.Granted }),
      ).expect(200);

      expect(reviewed.body).toMatchObject({ changed: true, switchedOff: false, act: { kind: 'Review' } });
      expect(await actsAt(plugin.id, PluginGrantScope.Household, householdId)).toEqual([
        expect.anything(),
        expect.objectContaining({ id: reviewed.body.act.id, manifestSha256: STAGED_SHA, manifestVersion: '1.3.0' }),
      ]);

      // A pre-consent confers nothing while the active manifest does not
      // request the permission.
      expect(await pluginAbilitySlugsForHousehold(db.client, plugin.id, householdId)).not.toContain(
        HOUSEHOLD_REQUIRED.slug,
      );

      const approved = await approve(admin, plugin.slug).expect(200);

      expect(approved.body.reconsentHouseholdUnits).not.toContainEqual(expect.objectContaining({ householdId }));

      // The lifecycle listener writes after the response; the approval's own
      // row landing first is what makes the absence below meaningful.
      await pollUntil(
        async () =>
          (await db.client.pluginLifecycleEvent.count({
            where: { pluginId: plugin.id, event: PluginLifecycleEventType.UpdateApproved },
          })) > 0 || undefined,
        { description: `the update approval lifecycle row for '${plugin.slug}'`, timeoutMs: 5_000 },
      );
      expect(
        await db.client.pluginLifecycleEvent.count({
          where: { pluginId: plugin.id, event: PluginLifecycleEventType.ReconsentRequested, scopeId: householdId },
        }),
      ).toBe(0);

      // Activated, the pre-consent confers, and the household owes nothing.
      expect(await pluginAbilitySlugsForHousehold(db.client, plugin.id, householdId)).toContain(
        HOUSEHOLD_REQUIRED.slug,
      );
      expect((await readFeatureState(owner, unit, plugin.slug)).state).toBe('on');
    });

    it('a staged review cannot refuse, and cannot answer a permission the active manifest already requests (#1150)', async () => {
      const { owner, householdId, unit } = await household();
      const plugin = await arrangeStagedPlugin(
        [MANAGE_DIGEST_CHECK, HOUSEHOLD_OPTIONAL],
        [MANAGE_DIGEST_CHECK, HOUSEHOLD_OPTIONAL, HOUSEHOLD_REQUIRED],
      );

      await sendSwitchOn(
        baseUrl,
        owner,
        unit,
        plugin.slug,
        switchOnBody(await readConsentSurface(baseUrl, owner, unit, plugin.slug)),
      ).expect(200);

      const staged = await readConsentSurface(baseUrl, owner, unit, plugin.slug, { staged: true });

      const refusal = await sendReview(
        baseUrl,
        owner,
        unit,
        plugin.slug,
        reviewBody(staged, { [HOUSEHOLD_REQUIRED.slug]: PluginGrantStatus.Denied }),
      ).expect(422);

      expect(refusal.body).toMatchObject({
        code: 'PLUGIN_CONSENT_ACT_ANSWER',
        rule: 'staged-refusal',
        permissionSlugs: [HOUSEHOLD_REQUIRED.slug],
      });

      const notNew = await sendReview(
        baseUrl,
        owner,
        unit,
        plugin.slug,
        reviewBody(staged, { [HOUSEHOLD_OPTIONAL.slug]: PluginGrantStatus.Granted }),
      ).expect(422);

      expect(notNew.body).toMatchObject({
        code: 'PLUGIN_CONSENT_ACT_ANSWER',
        rule: 'staged-not-new',
        permissionSlugs: [HOUSEHOLD_OPTIONAL.slug],
      });

      // Only the switch-on was recorded.
      expect(await actsAt(plugin.id, PluginGrantScope.Household, householdId)).toEqual([
        expect.objectContaining({ kind: PluginConsentActKind.SwitchOn }),
      ]);
      expect(await decisionsAt(plugin.id, PluginGrantScope.Household, householdId)).toEqual([]);
    });

    it('a review naming a staged update that was rejected is refused as stale (#1150)', async () => {
      const admin = await actors.admin();
      const { owner, householdId, unit } = await household();
      const plugin = await arrangeStagedPlugin([MANAGE_DIGEST_CHECK], [MANAGE_DIGEST_CHECK, HOUSEHOLD_REQUIRED]);

      await sendSwitchOn(
        baseUrl,
        owner,
        unit,
        plugin.slug,
        switchOnBody(await readConsentSurface(baseUrl, owner, unit, plugin.slug)),
      ).expect(200);

      const staged = await readConsentSurface(baseUrl, owner, unit, plugin.slug, { staged: true });

      await reject(admin, plugin.slug).expect(200);

      const response = await sendReview(
        baseUrl,
        owner,
        unit,
        plugin.slug,
        reviewBody(staged, { [HOUSEHOLD_REQUIRED.slug]: PluginGrantStatus.Granted }),
      ).expect(409);

      expect(response.body).toMatchObject({ code: 'PLUGIN_CONSENT_ACT_STALE', slug: plugin.slug, kind: 'manifest' });
      expect(await actsAt(plugin.id, PluginGrantScope.Household, householdId)).toHaveLength(1);
      expect(await decisionsAt(plugin.id, PluginGrantScope.Household, householdId)).toEqual([]);
    });

    it('rejecting a staged update deletes the pre-consents given to it and keeps the consent decisions in force, so a later update asks again (#1150)', async () => {
      const admin = await actors.admin();
      const { owner, householdId, unit } = await household();
      const plugin = await arrangeStagedPlugin(
        [MANAGE_DIGEST_CHECK, HOUSEHOLD_OPTIONAL],
        [MANAGE_DIGEST_CHECK, HOUSEHOLD_OPTIONAL, HOUSEHOLD_REQUIRED],
      );

      await sendSwitchOn(
        baseUrl,
        owner,
        unit,
        plugin.slug,
        switchOnBody(await readConsentSurface(baseUrl, owner, unit, plugin.slug), {
          [HOUSEHOLD_OPTIONAL.slug]: PluginGrantStatus.Granted,
        }),
      ).expect(200);

      const staged = await readConsentSurface(baseUrl, owner, unit, plugin.slug, { staged: true });
      const reviewed = await sendReview(
        baseUrl,
        owner,
        unit,
        plugin.slug,
        reviewBody(staged, { [HOUSEHOLD_REQUIRED.slug]: PluginGrantStatus.Granted }),
      ).expect(200);

      expect(await decisionsAt(plugin.id, PluginGrantScope.Household, householdId)).toEqual([
        expect.objectContaining({ permissionSlug: HOUSEHOLD_REQUIRED.slug, actId: reviewed.body.act.id }),
        expect.objectContaining({ permissionSlug: HOUSEHOLD_OPTIONAL.slug }),
      ]);

      await reject(admin, plugin.slug).expect(200);

      // Only the pre-consent went. The decision on the permission the active
      // manifest requests is in force, and both acts stay: an act is the
      // record that the household agreed, whatever became of the update.
      expect(await decisionsAt(plugin.id, PluginGrantScope.Household, householdId)).toEqual([
        expect.objectContaining({ permissionSlug: HOUSEHOLD_OPTIONAL.slug, status: PluginGrantStatus.Granted }),
      ]);
      expect(await actsAt(plugin.id, PluginGrantScope.Household, householdId)).toHaveLength(2);

      // The lifecycle listener writes after the response.
      const revoked = await pollUntil(
        async () =>
          (await db.client.pluginLifecycleEvent.findFirst({
            where: { pluginId: plugin.id, event: PluginLifecycleEventType.GrantRevoked, scopeId: householdId },
          })) ?? undefined,
        { description: `the pre-consent's revocation lifecycle row for '${plugin.slug}'`, timeoutMs: 5_000 },
      );

      expect(revoked).toMatchObject({
        manifestVersion: '1.3.0',
        payload: expect.objectContaining({
          permissionSlug: HOUSEHOLD_REQUIRED.slug,
          reason: 'staged-update-rejected',
          // The deleted row named the review that pre-consented; the
          // lifecycle row is the only place that link survives.
          actId: reviewed.body.act.id,
        }),
      });

      // A later update that requests the permission again, arranged on the
      // row: the household is asked, with nothing left over to inherit.
      await db.client.plugin.update({
        where: { id: plugin.id },
        data: stagedUpdateColumns({
          manifest: manifestWith('1.4.0', [MANAGE_DIGEST_CHECK, HOUSEHOLD_OPTIONAL, HOUSEHOLD_REQUIRED]),
          sha256: 'd'.repeat(64),
        }),
      });

      const restaged = await readConsentSurface(baseUrl, owner, unit, plugin.slug, { staged: true });

      expect(checkOf(restaged, HOUSEHOLD_REQUIRED.slug)).toMatchObject({ decision: 'pending', stagedOnly: true });
      expect(await pluginAbilitySlugsForHousehold(db.client, plugin.id, householdId)).not.toContain(
        HOUSEHOLD_REQUIRED.slug,
      );
    });

    it('a permission pre-consented at the consent scope the staged manifest moves it to survives activation and confers after (#1150)', async () => {
      const admin = await actors.admin();
      const { owner, householdId, unit } = await household();
      const SERVER_SCOPED: Check = { ...HOUSEHOLD_REQUIRED, required: false, consentScope: 'server' };
      const plugin = await arrangeStagedPlugin(
        [MANAGE_DIGEST_CHECK, SERVER_SCOPED],
        [MANAGE_DIGEST_CHECK, HOUSEHOLD_REQUIRED],
      );

      await sendSwitchOn(
        baseUrl,
        owner,
        unit,
        plugin.slug,
        switchOnBody(await readConsentSurface(baseUrl, owner, unit, plugin.slug)),
      ).expect(200);

      const staged = await readConsentSurface(baseUrl, owner, unit, plugin.slug, { staged: true });

      expect(checkOf(staged, HOUSEHOLD_REQUIRED.slug)).toMatchObject({ decidableByUnit: true, stagedOnly: true });

      await sendReview(
        baseUrl,
        owner,
        unit,
        plugin.slug,
        reviewBody(staged, { [HOUSEHOLD_REQUIRED.slug]: PluginGrantStatus.Granted }),
      ).expect(200);

      const approved = await approve(admin, plugin.slug).expect(200);

      expect(approved.body.reconsentHouseholdUnits).not.toContainEqual(expect.objectContaining({ householdId }));

      // Activation's scope move deletes the decisions at the scope the
      // permission left, never the pre-consent at the scope it moved to.
      expect(await decisionsAt(plugin.id, PluginGrantScope.Household, householdId)).toEqual([
        expect.objectContaining({ permissionSlug: HOUSEHOLD_REQUIRED.slug, status: PluginGrantStatus.Granted }),
      ]);
      expect(await pluginAbilitySlugsForHousehold(db.client, plugin.id, householdId)).toContain(
        HOUSEHOLD_REQUIRED.slug,
      );
      expect((await readFeatureState(owner, unit, plugin.slug)).state).toBe('on');
    });
  });

  describe('what does not change consent', () => {
    it('a member leaving or being demoted changes no consent decision and no act (#1150)', async () => {
      const owner = await actors.user();
      const admin = await actors.user();
      const fixture = await actors.householdWithMembers({
        owner,
        members: [{ actor: admin, role: SystemRole.HouseholdAdmin }],
      });
      const householdId = fixture.household.id;
      const adminMemberId = fixture.members[0]?.member.id ?? '';
      const unit: ConsentActUnit = { householdId };
      const plugin = await arrangePlugin([MANAGE_DIGEST_CHECK, HOUSEHOLD_REQUIRED, HOUSEHOLD_OPTIONAL]);
      const surface = await readConsentSurface(baseUrl, admin, unit, plugin.slug);

      await sendSwitchOn(
        baseUrl,
        admin,
        unit,
        plugin.slug,
        switchOnBody(surface, {
          [HOUSEHOLD_REQUIRED.slug]: PluginGrantStatus.Granted,
          [HOUSEHOLD_OPTIONAL.slug]: PluginGrantStatus.Granted,
        }),
      ).expect(200);

      const actsBefore = await actsAt(plugin.id, PluginGrantScope.Household, householdId);
      const decisionsBefore = await decisionsAt(plugin.id, PluginGrantScope.Household, householdId);

      expect(decisionsBefore.map((decision) => decision.decidedById)).toEqual([admin.user.id, admin.user.id]);

      await changeRole(owner, householdId, adminMemberId, SystemRole.HouseholdMember).expect(200);

      expect(await actsAt(plugin.id, PluginGrantScope.Household, householdId)).toEqual(actsBefore);
      expect(await decisionsAt(plugin.id, PluginGrantScope.Household, householdId)).toEqual(decisionsBefore);

      await removeMember(owner, householdId, adminMemberId).expect(200);

      expect(await actsAt(plugin.id, PluginGrantScope.Household, householdId)).toEqual(actsBefore);
      expect(await decisionsAt(plugin.id, PluginGrantScope.Household, householdId)).toEqual(decisionsBefore);

      // The household's remaining admin can still change what was agreed.
      const toggled = await sendToggle(
        baseUrl,
        owner,
        unit,
        plugin.slug,
        toggleBody(surface, HOUSEHOLD_OPTIONAL.slug, PluginGrantStatus.Denied),
      ).expect(200);

      expect(toggled.body).toMatchObject({ changed: true, act: { kind: PluginConsentActKind.Toggle } });
      expect(await actsAt(plugin.id, PluginGrantScope.Household, householdId)).toHaveLength(actsBefore.length + 1);
      expect(
        await db.client.pluginGrant.findFirst({
          where: { pluginId: plugin.id, scopeId: householdId, permissionSlug: HOUSEHOLD_OPTIONAL.slug },
        }),
      ).toMatchObject({ status: PluginGrantStatus.Denied, actId: toggled.body.act.id, decidedById: owner.user.id });
    });

    it('switching off keeps every consent decision (#1150)', async () => {
      const { owner, householdId, unit } = await household();
      const plugin = await arrangePlugin([MANAGE_DIGEST_CHECK, HOUSEHOLD_REQUIRED, HOUSEHOLD_OPTIONAL]);
      const surface = await readConsentSurface(baseUrl, owner, unit, plugin.slug);

      await sendSwitchOn(
        baseUrl,
        owner,
        unit,
        plugin.slug,
        switchOnBody(surface, {
          [HOUSEHOLD_REQUIRED.slug]: PluginGrantStatus.Granted,
          [HOUSEHOLD_OPTIONAL.slug]: PluginGrantStatus.Denied,
        }),
      ).expect(200);

      const decisionsBefore = await decisionsAt(plugin.id, PluginGrantScope.Household, householdId);

      expect(decisionsBefore).toHaveLength(2);

      await disable(owner, unit, plugin.slug).expect(200);

      expect(await householdUnit(householdId, plugin.id)).toMatchObject({ enabled: false });
      expect(await decisionsAt(plugin.id, PluginGrantScope.Household, householdId)).toEqual(decisionsBefore);
      expect(await actsAt(plugin.id, PluginGrantScope.Household, householdId)).toHaveLength(1);
    });
  });

  describe('the act table', () => {
    // The rule lives in a hand-written migration, which Prisma cannot model,
    // so only a real database can show it is there. Rows are written
    // directly: the constraint has to hold whatever path inserts.
    it('refuses a household or user act that names no unit, and takes a server act that names none (#1150)', async () => {
      const plugin = await arrangePlugin([MANAGE_DIGEST_CHECK]);
      const actData = (scopeType: PluginGrantScope, scopeId: string) => ({
        data: {
          pluginId: plugin.id,
          pluginSlug: plugin.slug,
          scopeType,
          scopeId,
          kind: PluginConsentActKind.SwitchOn,
          manifestVersion: plugin.version,
          manifestSha256: plugin.installedSha256,
          presentation: {},
          decidedAt: new Date(),
        },
      });

      for (const scopeType of [PluginGrantScope.Household, PluginGrantScope.User]) {
        const refusal = await db.client.pluginConsentAct.create(actData(scopeType, '')).then(
          () => 'nothing threw: the constraint is missing from the schema',
          (error: unknown) => inspect(error, { depth: null, showHidden: true, getters: true }),
        );

        expect(refusal).toContain('plugin_consent_acts_non_server_scope_id_not_empty');
      }

      // The empty scope id is the Server sentinel, as on a consent decision.
      await expect(db.client.pluginConsentAct.create(actData(PluginGrantScope.Server, ''))).resolves.toMatchObject({
        scopeId: '',
      });
    });
  });
});
