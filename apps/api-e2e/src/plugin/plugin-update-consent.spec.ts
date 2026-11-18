import {
  PluginConsentActKind,
  PluginGrantScope,
  PluginGrantStatus,
  PluginLifecycleEventType,
  PluginScope,
  RiskLevel,
  type Plugin,
} from '@bge/database';
import { createActors, pollUntil, type Actors, type SessionActor } from '@bge/testing-e2e';
import { buildPluginManifest, type PluginManifest } from '@boardgamesempire/plugin-manifest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { restoreShippedCatalog } from '../permission-catalog/shipped-catalog';
import { deferredRequest } from '../support/deferred-request';
import { requireBaseUrl } from '../support/e2e-env';
import { errorText } from '../support/error-text';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import {
  readConsentSurface,
  readStagedShownRisks,
  reviewBody,
  sendReview,
  sendSwitchOn,
  shownServerRisks,
  switchOnBody,
} from './consent-act-fixtures';
import { pluginAbilitySlugsForHousehold, pluginOwnAbilitySlugsForHousehold } from './plugin-ability-fixtures';
import {
  FIXTURE_ACT_ID,
  INSTALLED_SHA256,
  INVENTORY_STAGING_ID,
  pluginRowData,
  stagedUpdateColumns,
} from './plugin-row-fixtures';

/**
 * The wire half of #321: approve/reject/pending over a REAL staged row —
 * the approval's consent act and the consent decisions it writes as
 * persisted rows (#1336), the 409 challenge
 * round-trip driven from the error body, the units owing re-consent reported
 * on the response and announced without a write to their rows (#1149), and
 * the 404/410/409 distinctions the pending read draws.
 *
 * Staged state is arranged directly on the row so each case fixes its
 * manifests exactly; staging through the real route is covered by
 * `plugin-update-staging.spec.ts` (#1096).
 * Core checks reference SEEDED permissions only (`permissions` is a
 * preserved table the between-test sweep never truncates, so tests must not
 * write to it): `read:safe_http_policy` (Medium) as the plain new check and
 * `manage:safe_http_policy` (Critical) as the second-factor trigger.
 */
describe('plugin update consent (approve/reject/pending)', () => {
  const baseUrl = requireBaseUrl(process.env);
  const PLUGINS_PATH = '/api/plugins';
  const STAGED_AT = new Date('2026-08-01T12:00:00Z');
  /** The staged plugin artifact's checksum, and the staging's id (#357), on every row this spec stages. */
  const STAGED_SHA = 'b'.repeat(64);
  const STAGING_ID = INVENTORY_STAGING_ID;

  let db: TestDatabase;
  let actors: Actors;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  /** The fixture's own declared permission — origin `plugin`, locked Low, needs no `Permission` row. */
  const MANAGE_DIGEST_CHECK = {
    slug: 'manage:digest',
    required: true,
    reason: { en: 'Stores and manages the digest configuration it owns.' },
    consentScope: 'server' as const,
  };

  const NEW_SERVER_CHECK = {
    slug: 'read:safe_http_policy',
    required: false,
    reason: { en: 'Inspects the outbound policy before scheduling digest delivery.' },
    consentScope: 'server' as const,
  };

  const CRITICAL_SERVER_CHECK = {
    slug: 'manage:safe_http_policy',
    required: true,
    reason: { en: 'Maintains the allowlist entries its outbound webhooks require.' },
    consentScope: 'server' as const,
  };

  /** An allowlisted public read, which a user-scope consent may hold (#591). */
  const USER_SCOPE_CHECK = {
    slug: 'read:game_collection:public',
    required: true,
    reason: { en: 'Shows public collections in each member’s digest.' },
    consentScope: 'user' as const,
  };

  /** REQUIRED at household scope. An allowlisted public read, which a household-scope consent may hold (#591). */
  const HOUSEHOLD_CHECK = {
    slug: 'read:game:public',
    required: true,
    reason: { en: 'Lists the public games the household digest features.' },
    consentScope: 'household' as const,
  };

  /** A config schema the default `{}` fails: it requires `webhookUrl`. */
  const REQUIRING_SCHEMA = {
    type: 'object',
    properties: { webhookUrl: { type: 'string' } },
    required: ['webhookUrl'],
  };

  type Check = PluginManifest['permissions']['checks'][number];

  /**
   * Both manifests drop the fixture's `feedback:read` — it has no seeded
   * `Permission` row. `bgeCompat` widens to cover the server's build-time
   * stamp (`0.0.0` in this workspace): approve and the pending read
   * re-validate the STORED pending manifest with `bgeCompat` enforced, and a
   * staged row `stage()` would have accepted must satisfy it.
   */
  const manifestWithChecks = (
    version: string,
    checks: readonly Check[],
    /** Omitted keeps the builder's default declares, so both manifests declare the same catalog. */
    declares?: readonly string[],
  ): PluginManifest =>
    buildPluginManifest({
      version,
      bgeCompat: '>=0.0.0',
      permissions: { checks: [...checks], ...(declares === undefined ? {} : { declares: [...declares] }) },
    });

  const activeManifest = (checks: readonly Check[] = [MANAGE_DIGEST_CHECK]): PluginManifest =>
    manifestWithChecks('1.2.0', checks);

  const arrangeStagedPlugin = async (
    pendingChecks: readonly Check[],
    pendingDeclares?: readonly string[],
    overrides: {
      /** The ACTIVE manifest's requested permissions. Defaults to `[MANAGE_DIGEST_CHECK]`. */
      readonly activeChecks?: readonly Check[];
      /** The ACTIVE row's retained config, pre-activation. Defaults to `{}`. */
      readonly activeConfig?: Record<string, unknown>;
      /** Merged onto the pending manifest's `config` section (D-CN, #370). */
      readonly pendingConfig?: Partial<PluginManifest['config']>;
      /** The PENDING manifest's scope, for a re-scope (#1151). Defaults to `scope`. */
      readonly pendingScope?: PluginManifest['scope'];
      /** Defaults to 'server' — every existing caller's plugin. */
      readonly scope?: PluginManifest['scope'];
    } = {},
  ): Promise<{ pending: PluginManifest; plugin: Plugin }> => {
    const scope = overrides.scope ?? 'server';
    const active: PluginManifest = { ...activeManifest(overrides.activeChecks), scope };
    const pendingBase = manifestWithChecks('1.3.0', pendingChecks, pendingDeclares);
    const pending: PluginManifest = {
      ...pendingBase,
      scope: overrides.pendingScope ?? scope,
      ...(overrides.pendingConfig === undefined
        ? {}
        : { config: { ...pendingBase.config, ...overrides.pendingConfig } }),
    };

    const plugin = await db.client.plugin.create({
      data: pluginRowData({
        slug: active.slug,
        version: active.version,
        scope: scope === 'server' ? PluginScope.Server : PluginScope.Household,
        manifestJson: active as never,
        enabled: true,
        config: (overrides.activeConfig ?? {}) as never,
        ...stagedUpdateColumns({
          manifest: pending,
          sha256: STAGED_SHA,
          since: STAGED_AT,
          stagingId: STAGING_ID,
        }),
      }),
    });

    return { plugin, pending };
  };

  /**
   * Approve and reject answer one staging, named the way the staged-update
   * read reports it (#357). An approval also sends the risks that read shows,
   * as a client would; a spec's body overrides them (#1336).
   */
  const approve = (actor: SessionActor, slug: string, body: Record<string, unknown> = {}) =>
    deferredRequest(
      () => readStagedShownRisks(baseUrl, actor, slug),
      (shownRisks) =>
        request(baseUrl)
          .post(`${PLUGINS_PATH}/${slug}/update/approve`)
          .set(actor.headers)
          .send({ stagingId: STAGING_ID, shownRisks, ...body }),
    );

  const reject = (actor: SessionActor, slug: string, stagingId: string = STAGING_ID) =>
    request(baseUrl).post(`${PLUGINS_PATH}/${slug}/update/reject`).set(actor.headers).send({ stagingId });

  const readPending = (actor: SessionActor, slug: string) =>
    request(baseUrl).get(`${PLUGINS_PATH}/${slug}/update/pending`).set(actor.headers);

  /** A server-scope decision on the policy-read permission — the grant coordinates live in ONE place. */
  const seedPolicyGrant = (plugin: Plugin, overrides: { status: PluginGrantStatus } & Record<string, unknown>) =>
    db.client.pluginGrant.create({
      data: {
        pluginId: plugin.id,
        scopeType: PluginGrantScope.Server,
        scopeId: '',
        permissionSlug: 'read:safe_http_policy',
        actId: FIXTURE_ACT_ID,
        decidedAt: new Date(),
        decidedRiskLevel: RiskLevel.Medium,
        ...overrides,
      },
    });

  /** The lifecycle listener persists post-commit and out-of-band, so the row lands after the response. */
  const awaitLifecycleRow = (plugin: Plugin, event: PluginLifecycleEventType) =>
    pollUntil(
      async () => {
        const found = await db.client.pluginLifecycleEvent.findMany({ where: { pluginId: plugin.id, event } });

        return found.length > 0 ? found : undefined;
      },
      { description: `the ${event} lifecycle row for '${plugin.slug}'`, timeoutMs: 5_000 },
    );

  /**
   * The server consent decisions an earlier approval would have left, both
   * Granted: the plugin's own declared permission, so a household owes
   * nothing at server scope and can read `on`, and the policy read, a core
   * permission that confers in every household's ability while the household
   * is served (#1151).
   */
  const arrangeServerDecisions = async (plugin: Plugin) => {
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
    await seedPolicyGrant(plugin, { status: PluginGrantStatus.Granted });
  };

  /** A household's Granted consent decision on `HOUSEHOLD_CHECK`, as its switch-on would have recorded it. */
  const arrangeHouseholdGrant = (plugin: Plugin, householdId: string) =>
    db.client.pluginGrant.create({
      data: {
        pluginId: plugin.id,
        scopeType: PluginGrantScope.Household,
        scopeId: householdId,
        permissionSlug: HOUSEHOLD_CHECK.slug,
        status: PluginGrantStatus.Granted,
        actId: FIXTURE_ACT_ID,
        decidedAt: new Date(),
        decidedRiskLevel: RiskLevel.Low,
      },
    });

  /** The household's unit enablement for the plugin, every column, read straight from the database. */
  const householdUnitEnablement = (householdId: string, pluginId: string) =>
    db.client.householdPlugin.findUniqueOrThrow({ where: { householdId_pluginId: { householdId, pluginId } } });

  /** The unit state the household inventory reports for the plugin, as its admin reads it. */
  const householdUnitState = async (actor: SessionActor, householdId: string, slug: string) => {
    const response = await request(baseUrl)
      .get(`/api/households/${householdId}/plugins?limit=100`)
      .set(actor.headers)
      .expect(200);

    return response.body.plugins.find((entry: { slug: string }) => entry.slug === slug)?.unit;
  };

  const patchHouseholdConfig = (actor: SessionActor, householdId: string, slug: string, config: unknown) =>
    request(baseUrl).patch(`/api/households/${householdId}/plugins/${slug}/config`).set(actor.headers).send({ config });

  /** Stages a further update on a plugin an earlier approval already updated: a new version, checksum and staging id. */
  const stageAnotherUpdate = (plugin: Plugin, manifest: PluginManifest, stagingId: string) =>
    db.client.plugin.update({
      where: { id: plugin.id },
      data: stagedUpdateColumns({ manifest, sha256: 'c'.repeat(64), since: STAGED_AT, stagingId }),
    });

  /** The link and registry a first install recorded, and those of the staged plugin artifact (#1096). */
  const FIRST_INSTALL_PROVENANCE = {
    installedFromUrl: 'https://plugins.example.test/demo-sink-1.2.0.tgz',
    registrySlug: 'first-registry',
  };

  const STAGED_PROVENANCE = { url: 'https://mirror.example.test/demo-sink-1.3.0.tgz', registrySlug: 'second-registry' };

  /**
   * A staged plugin whose first install came from a link and a registry, and
   * whose staged update came from others (#1096). Every artifact the staging
   * route sees is an upload, so this is where provenance other than null
   * meets Postgres.
   */
  const arrangeStagedPluginWithProvenance = async () => {
    const { plugin } = await arrangeStagedPlugin([MANAGE_DIGEST_CHECK]);
    const { pendingFromUrl, pendingRegistrySlug } = stagedUpdateColumns(STAGED_PROVENANCE);

    return db.client.plugin.update({
      where: { id: plugin.id },
      data: { ...FIRST_INSTALL_PROVENANCE, pendingFromUrl, pendingRegistrySlug },
    });
  };

  /** All seven staged columns empty: the five the CHECK holds together, and the link and registry (#1096). */
  const NO_STAGED_UPDATE = {
    pendingVersion: null,
    pendingManifestJson: null,
    pendingSha256: null,
    pendingSince: null,
    pendingStagingId: null,
    pendingFromUrl: null,
    pendingRegistrySlug: null,
  };

  describe('authorization', () => {
    it('refuses a non-admin at the policy gate on all three routes', async () => {
      const user = await actors.user();
      const { plugin } = await arrangeStagedPlugin([MANAGE_DIGEST_CHECK, NEW_SERVER_CHECK]);

      await approve(user, plugin.slug).expect(403);
      await reject(user, plugin.slug).expect(403);
      // read:plugin is Owner/Admin-only in the seeds — the pending surface
      // describes escalations, not something every member may browse.
      await readPending(user, plugin.slug).expect(403);
    });

    it('refuses an unauthenticated caller', async () => {
      const { plugin } = await arrangeStagedPlugin([MANAGE_DIGEST_CHECK]);

      await request(baseUrl).post(`${PLUGINS_PATH}/${plugin.slug}/update/approve`).send({}).expect(401);
      await request(baseUrl).get(`${PLUGINS_PATH}/${plugin.slug}/update/pending`).expect(401);
    });
  });

  describe('approve', () => {
    it('activates the pending version: grants seeded, row promoted, restartRequired surfaced, lifecycle row written', async () => {
      const admin = await actors.admin();
      const { plugin } = await arrangeStagedPlugin([MANAGE_DIGEST_CHECK, NEW_SERVER_CHECK]);

      const response = await approve(admin, plugin.slug).expect(200);

      expect(response.body.message).toContain(plugin.slug);
      expect(response.body.restartRequired).toBe(true);
      expect(response.body.plugin.version).toBe('1.3.0');
      expect(response.body.plugin.pendingVersion).toBeNull();
      expect(response.body.reconsentHouseholdUnits).toEqual([]);
      expect(response.body.reconsentUserUnits).toEqual([]);
      // Both undecided server checks seeded Granted — the plugin-declared
      // one at its locked Low, the core one at today's catalog risk.
      expect(response.body.seededGrants).toHaveLength(2);

      const row = await db.client.plugin.findUniqueOrThrow({ where: { id: plugin.id } });
      expect(row.version).toBe('1.3.0');
      expect(row.restartRequired).toBe(true);
      expect(row.pendingVersion).toBeNull();
      expect(row.pendingManifestJson).toBeNull();
      expect(row.pendingSha256).toBeNull();
      expect(row.pendingSince).toBeNull();
      expect(row.pendingStagingId).toBeNull();
      expect(row.installedSha256).toBe(STAGED_SHA);

      const grants = await db.client.pluginGrant.findMany({ where: { pluginId: plugin.id } });
      expect(grants).toHaveLength(2);
      expect(grants).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            permissionSlug: `plugin|${plugin.slug}|manage:digest`,
            scopeType: PluginGrantScope.Server,
            status: PluginGrantStatus.Granted,
            decidedRiskLevel: RiskLevel.Low,
          }),
          expect.objectContaining({
            permissionSlug: 'read:safe_http_policy',
            scopeType: PluginGrantScope.Server,
            status: PluginGrantStatus.Granted,
            decidedRiskLevel: RiskLevel.Medium,
          }),
        ]),
      );

      const rows = await awaitLifecycleRow(plugin, PluginLifecycleEventType.UpdateApproved);
      expect(rows).toHaveLength(1);
    });

    it("approval makes the staged link and registry the plugin's own (#1096)", async () => {
      const admin = await actors.admin();
      const plugin = await arrangeStagedPluginWithProvenance();

      await approve(admin, plugin.slug).expect(200);

      const row = await db.client.plugin.findUniqueOrThrow({ where: { id: plugin.id } });
      expect(row).toMatchObject({
        installedFromUrl: STAGED_PROVENANCE.url,
        registrySlug: STAGED_PROVENANCE.registrySlug,
        installedSha256: STAGED_SHA,
        ...NO_STAGED_UPDATE,
      });
    });

    /**
     * D-CN on #59/#370: activation rides the same retained-config rule a
     * reinstall-over-tombstone applies — the reinstall half has no HTTP
     * ingress to drive over the wire (#84's), but approve() does, so this is
     * where the rule gets a real-Postgres round-trip.
     */
    it('resets retained server config to {} when the pending manifest schema no longer admits it (D-CN)', async () => {
      const admin = await actors.admin();
      const { plugin } = await arrangeStagedPlugin([MANAGE_DIGEST_CHECK], undefined, {
        activeConfig: { webhookUrl: 42 },
        pendingConfig: {
          schema: { type: 'object', properties: { webhookUrl: { type: 'string' } }, required: ['webhookUrl'] },
        },
      });

      const response = await approve(admin, plugin.slug).expect(200);

      expect(response.body.plugin.config).toEqual({});

      const row = await db.client.plugin.findUniqueOrThrow({ where: { id: plugin.id } });
      expect(row.config).toEqual({});

      const rows = await awaitLifecycleRow(plugin, PluginLifecycleEventType.UpdateApproved);
      expect(rows[0]?.payload).toEqual(expect.objectContaining({ retainedConfigReset: true }));
    });

    it('carries retained server config forward when it still satisfies the new schema', async () => {
      const admin = await actors.admin();
      const { plugin } = await arrangeStagedPlugin([MANAGE_DIGEST_CHECK], undefined, {
        activeConfig: { webhookUrl: 'https://retained.example.test' },
        pendingConfig: {
          schema: { type: 'object', properties: { webhookUrl: { type: 'string' } }, required: ['webhookUrl'] },
        },
      });

      const response = await approve(admin, plugin.slug).expect(200);

      expect(response.body.plugin.config).toEqual({ webhookUrl: 'https://retained.example.test' });

      const rows = await awaitLifecycleRow(plugin, PluginLifecycleEventType.UpdateApproved);
      expect(rows[0]?.payload).toEqual(expect.objectContaining({ retainedConfigReset: false }));
    });

    /**
     * A household's dormancy is worked out when read, from the active manifest
     * and the document its unit enablement holds (#1151). So an activation
     * that tightens the schema writes nothing to the household: the read sees
     * the new schema, the ability confers nothing, and the household's own
     * conforming configuration write is the whole cure.
     */
    it('a household whose configuration a new version rejects reads needs_configuration, gets no abilities, and reads on again after a conforming configuration write (#1151)', async () => {
      const admin = await actors.admin();
      const owner = await actors.user();
      const { household } = await actors.householdWithMembers({ owner });
      const checks = [MANAGE_DIGEST_CHECK, NEW_SERVER_CHECK, HOUSEHOLD_CHECK];
      const { plugin } = await arrangeStagedPlugin(checks, undefined, {
        scope: 'household',
        activeChecks: checks,
        pendingConfig: { schema: REQUIRING_SCHEMA },
      });
      await arrangeServerDecisions(plugin);
      await arrangeHouseholdGrant(plugin, household.id);
      // `{}` satisfies the active schema and fails the staged one.
      await db.client.householdPlugin.create({
        data: { householdId: household.id, pluginId: plugin.id, enabled: true, config: {} },
      });
      const servedSlugs = [HOUSEHOLD_CHECK.slug, 'read:safe_http_policy'].sort();

      // The control: before the update the household is served and its
      // ability holds both decisions, so the empty ability below is dormancy's.
      expect(await householdUnitState(owner, household.id, plugin.slug)).toMatchObject({ state: 'on', dormancy: null });
      expect(await pluginAbilitySlugsForHousehold(db.client, plugin.id, household.id)).toEqual(servedSlugs);
      const captured = await householdUnitEnablement(household.id, plugin.id);

      await approve(admin, plugin.slug).expect(200);

      // Activation wrote nothing to the household's unit enablement.
      expect(await householdUnitEnablement(household.id, plugin.id)).toEqual(captured);
      expect(await householdUnitState(owner, household.id, plugin.slug)).toMatchObject({
        enabled: true,
        state: 'needs_configuration',
        dormancy: 'needs_configuration',
      });
      expect(await pluginAbilitySlugsForHousehold(db.client, plugin.id, household.id)).toEqual([]);

      await patchHouseholdConfig(owner, household.id, plugin.slug, { webhookUrl: 'https://example.test/hook' }).expect(
        200,
      );

      expect(await householdUnitState(owner, household.id, plugin.slug)).toMatchObject({ state: 'on', dormancy: null });
      expect(await pluginAbilitySlugsForHousehold(db.client, plugin.id, household.id)).toEqual(servedSlugs);
    });

    it('a household unit enablement on a plugin re-scoped to server reads unavailable and reads on again after a re-scope back, with no write in between (#1151)', async () => {
      // A server-scope manifest may not request a permission at household
      // scope, so the household's ability is the server decision on the
      // policy read alone, which stands through both activations.
      const admin = await actors.admin();
      const owner = await actors.user();
      const { household } = await actors.householdWithMembers({ owner });
      const checks = [MANAGE_DIGEST_CHECK, NEW_SERVER_CHECK];
      const { plugin } = await arrangeStagedPlugin(checks, undefined, {
        scope: 'household',
        pendingScope: 'server',
        activeChecks: checks,
      });
      await arrangeServerDecisions(plugin);
      await db.client.householdPlugin.create({
        data: { householdId: household.id, pluginId: plugin.id, enabled: true, config: {} },
      });

      // The control: served before the re-scope, so the empty ability below is dormancy's.
      expect(await householdUnitState(owner, household.id, plugin.slug)).toMatchObject({ state: 'on', dormancy: null });
      expect(await pluginAbilitySlugsForHousehold(db.client, plugin.id, household.id)).toEqual([
        'read:safe_http_policy',
      ]);
      const captured = await householdUnitEnablement(household.id, plugin.id);

      await approve(admin, plugin.slug).expect(200);

      // The re-scope wrote nothing to the household's unit enablement.
      expect(await householdUnitEnablement(household.id, plugin.id)).toEqual(captured);
      expect(await householdUnitState(owner, household.id, plugin.slug)).toMatchObject({
        anchored: true,
        enabled: true,
        state: 'unavailable',
        dormancy: 'unavailable',
      });
      expect(await pluginAbilitySlugsForHousehold(db.client, plugin.id, household.id)).toEqual([]);

      const stagingId = 'e2e-staging-2';
      await stageAnotherUpdate(plugin, { ...manifestWithChecks('1.4.0', checks), scope: 'household' }, stagingId);
      await approve(admin, plugin.slug, { stagingId }).expect(200);

      expect(await householdUnitState(owner, household.id, plugin.slug)).toMatchObject({ state: 'on', dormancy: null });
      expect(await pluginAbilitySlugsForHousehold(db.client, plugin.id, household.id)).toEqual([
        'read:safe_http_policy',
      ]);
      // Neither activation wrote to the household's unit enablement.
      expect(await householdUnitEnablement(household.id, plugin.id)).toEqual(captured);
    });

    it('an activation that leaves a household needing configuration records only the approval and the re-consent it asks for (#1151)', async () => {
      // Two switched-on households: one whose document the staged schema
      // accepts, one whose `{}` it rejects. Both owe the new household-scope
      // permission. Dormancy is worked out when read (#1151), so the
      // activation announces none.
      const admin = await actors.admin();
      const [ownerA, ownerB] = await Promise.all([actors.user(), actors.user()]);
      const [{ household: conforming }, { household: rejected }] = await Promise.all([
        actors.householdWithMembers({ owner: ownerA }),
        actors.householdWithMembers({ owner: ownerB }),
      ]);
      const { plugin } = await arrangeStagedPlugin(
        [MANAGE_DIGEST_CHECK, NEW_SERVER_CHECK, HOUSEHOLD_CHECK],
        undefined,
        {
          scope: 'household',
          activeChecks: [MANAGE_DIGEST_CHECK, NEW_SERVER_CHECK],
          pendingConfig: { schema: REQUIRING_SCHEMA },
        },
      );
      await db.client.householdPlugin.create({
        data: {
          householdId: conforming.id,
          pluginId: plugin.id,
          enabled: true,
          config: { webhookUrl: 'https://example.test/hook' },
        },
      });
      await db.client.householdPlugin.create({
        data: { householdId: rejected.id, pluginId: plugin.id, enabled: true, config: {} },
      });

      const response = await approve(admin, plugin.slug).expect(200);

      expect(response.body.reconsentHouseholdUnits).toHaveLength(2);
      // The case is one where a household cannot run: the read says so.
      expect(await householdUnitState(ownerB, rejected.id, plugin.slug)).toMatchObject({
        dormancy: 'needs_configuration',
      });

      // The listener writes after the response: wait for every row the
      // approval is known to write, then read all of the plugin's rows.
      await awaitLifecycleRow(plugin, PluginLifecycleEventType.UpdateApproved);
      await pollUntil(
        async () => {
          const found = await db.client.pluginLifecycleEvent.count({
            where: { pluginId: plugin.id, event: PluginLifecycleEventType.ReconsentRequested },
          });

          return found >= 2 ? found : undefined;
        },
        { description: `both re-consent lifecycle rows for '${plugin.slug}'`, timeoutMs: 5_000 },
      );

      const kinds = (await db.client.pluginLifecycleEvent.findMany({ where: { pluginId: plugin.id } }))
        .map((row) => row.event)
        .sort();
      expect(kinds).toEqual(
        [
          PluginLifecycleEventType.ReconsentRequested,
          PluginLifecycleEventType.ReconsentRequested,
          PluginLifecycleEventType.UpdateApproved,
        ].sort(),
      );
    });

    it('re-writes a risk-escalated required server decision at today’s risk, under the approval’s act (#1336)', async () => {
      const admin = await actors.admin();
      const { plugin } = await arrangeStagedPlugin(
        [MANAGE_DIGEST_CHECK, { ...NEW_SERVER_CHECK, required: true }],
        undefined,
        {
          activeChecks: [MANAGE_DIGEST_CHECK, { ...NEW_SERVER_CHECK, required: true }],
        },
      );
      // Decided when the catalog said Low; the catalog says Medium today.
      const stale = await seedPolicyGrant(plugin, {
        status: PluginGrantStatus.Granted,
        decidedAt: new Date('2026-07-01T00:00:00Z'),
        decidedRiskLevel: RiskLevel.Low,
      });

      const response = await approve(admin, plugin.slug).expect(200);

      expect(response.body.comparison.escalations).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: 'risk-escalated', slug: 'read:safe_http_policy' })]),
      );

      const reStamped = await db.client.pluginGrant.findUniqueOrThrow({ where: { id: stale.id } });
      expect(reStamped.decidedRiskLevel).toBe(RiskLevel.Medium);
      expect(reStamped.decidedById).toBe(admin.user.id);
      expect(reStamped.actId).toBe(response.body.act.id);
    });

    it('leaves an optional server decision granted at a risk that has since risen as it stands (#1336)', async () => {
      // Approving confers nothing through an optional decision that exists:
      // it stays outstanding for a review act.
      const admin = await actors.admin();
      const { plugin } = await arrangeStagedPlugin([MANAGE_DIGEST_CHECK, NEW_SERVER_CHECK], undefined, {
        activeChecks: [MANAGE_DIGEST_CHECK, NEW_SERVER_CHECK],
      });
      const stale = await seedPolicyGrant(plugin, {
        status: PluginGrantStatus.Granted,
        decidedAt: new Date('2026-07-01T00:00:00Z'),
        decidedRiskLevel: RiskLevel.Low,
      });

      await approve(admin, plugin.slug).expect(200);

      const untouched = await db.client.pluginGrant.findUniqueOrThrow({ where: { id: stale.id } });
      expect(untouched).toEqual(stale);
    });

    /**
     * Activation deletes no consent decision (#1152). A decision the active
     * manifest does not request at its scope is kept and confers nothing, by
     * the bound applied when the ability is read, and it counts again, with
     * no act, when a later manifest requests the permission at that scope.
     * Each case approves twice, so it gives the second staging its own id.
     */
    describe('a consent decision outside the active manifest (#1152)', () => {
      /** P: OPTIONAL at household scope, so no update asks the household for it again. */
      const HOUSEHOLD_OPTIONAL_CHECK: Check = { ...HOUSEHOLD_CHECK, required: false };
      const SECOND_STAGING_ID = 'e2e-staging-second';

      /** A household with the plugin switched on, granting `slug` in its one switch-on act. */
      const switchOnGranting = async (plugin: Plugin, slug: string) => {
        const owner = await actors.user();
        const { household } = await actors.householdWithMembers({ owner });
        const unit = { householdId: household.id };
        const surface = await readConsentSurface(baseUrl, owner, unit, plugin.slug);

        await sendSwitchOn(
          baseUrl,
          owner,
          unit,
          plugin.slug,
          switchOnBody(surface, { [slug]: PluginGrantStatus.Granted }),
        ).expect(200);

        const decision = await db.client.pluginGrant.findUniqueOrThrow({
          where: {
            pluginId_scopeType_scopeId_permissionSlug: {
              pluginId: plugin.id,
              scopeType: PluginGrantScope.Household,
              scopeId: household.id,
              permissionSlug: slug,
            },
          },
        });

        return { householdId: household.id, decision };
      };

      const householdActCount = (plugin: Plugin, householdId: string) =>
        db.client.pluginConsentAct.count({
          where: { pluginId: plugin.id, scopeType: PluginGrantScope.Household, scopeId: householdId },
        });

      /**
       * The plugin's revocation lifecycle rows, read once both approvals' own
       * rows have landed. The listener writes each event on its own, so the
       * approval rows do not order a revocation row the second approval
       * might have caused: an empty answer shows no revocation landed by
       * then, not that none was announced. The row-equality assertions are
       * what guard the decisions.
       */
      const revocationsAfterTwoApprovals = async (plugin: Plugin) => {
        await pollUntil(
          async () =>
            (await db.client.pluginLifecycleEvent.count({
              where: { pluginId: plugin.id, event: PluginLifecycleEventType.UpdateApproved },
            })) >= 2 || undefined,
          { description: `both update approval lifecycle rows for '${plugin.slug}'`, timeoutMs: 5_000 },
        );

        return db.client.pluginLifecycleEvent.findMany({
          where: { pluginId: plugin.id, event: PluginLifecycleEventType.GrantRevoked },
        });
      };

      it('a consent decision on a permission the update stops requesting survives activation, confers nothing, and confers again when a later update requests it, with no act (#1152)', async () => {
        const admin = await actors.admin();
        const activeChecks = [MANAGE_DIGEST_CHECK, HOUSEHOLD_OPTIONAL_CHECK];
        // A requests P; B stops requesting it.
        const { plugin } = await arrangeStagedPlugin([MANAGE_DIGEST_CHECK], undefined, {
          scope: 'household',
          activeChecks,
        });
        const { householdId, decision } = await switchOnGranting(plugin, HOUSEHOLD_OPTIONAL_CHECK.slug);
        const actsBefore = await householdActCount(plugin, householdId);

        // The control: under A the decision confers, so its absence below is the bound's.
        expect(await pluginAbilitySlugsForHousehold(db.client, plugin.id, householdId)).toContain(
          HOUSEHOLD_OPTIONAL_CHECK.slug,
        );

        await approve(admin, plugin.slug).expect(200);

        expect(await db.client.pluginGrant.findUniqueOrThrow({ where: { id: decision.id } })).toEqual(decision);
        expect(await pluginAbilitySlugsForHousehold(db.client, plugin.id, householdId)).not.toContain(
          HOUSEHOLD_OPTIONAL_CHECK.slug,
        );

        // A again, staged on the row under a staging of its own.
        await stageAnotherUpdate(
          plugin,
          { ...manifestWithChecks('1.2.0', activeChecks), scope: 'household' },
          SECOND_STAGING_ID,
        );
        await approve(admin, plugin.slug, { stagingId: SECOND_STAGING_ID }).expect(200);

        expect(await db.client.pluginGrant.findUniqueOrThrow({ where: { id: decision.id } })).toEqual(decision);
        expect(await pluginAbilitySlugsForHousehold(db.client, plugin.id, householdId)).toContain(
          HOUSEHOLD_OPTIONAL_CHECK.slug,
        );
        expect(await householdActCount(plugin, householdId)).toBe(actsBefore);
        expect(await revocationsAfterTwoApprovals(plugin)).toEqual([]);
      });

      it('a household decision on a permission whose consent scope moves to user survives, confers nothing, and confers again after the move back (#1152)', async () => {
        const admin = await actors.admin();
        const atHousehold = [MANAGE_DIGEST_CHECK, HOUSEHOLD_OPTIONAL_CHECK];
        const atUser = [MANAGE_DIGEST_CHECK, { ...HOUSEHOLD_OPTIONAL_CHECK, consentScope: 'user' as const }];
        const { plugin } = await arrangeStagedPlugin(atUser, undefined, {
          scope: 'household',
          activeChecks: atHousehold,
        });
        const { householdId, decision } = await switchOnGranting(plugin, HOUSEHOLD_OPTIONAL_CHECK.slug);
        const actsBefore = await householdActCount(plugin, householdId);

        expect(await pluginAbilitySlugsForHousehold(db.client, plugin.id, householdId)).toContain(
          HOUSEHOLD_OPTIONAL_CHECK.slug,
        );

        await approve(admin, plugin.slug).expect(200);

        expect(await db.client.pluginGrant.findUniqueOrThrow({ where: { id: decision.id } })).toEqual(decision);
        expect(await pluginAbilitySlugsForHousehold(db.client, plugin.id, householdId)).not.toContain(
          HOUSEHOLD_OPTIONAL_CHECK.slug,
        );

        await stageAnotherUpdate(
          plugin,
          { ...manifestWithChecks('1.4.0', atHousehold), scope: 'household' },
          SECOND_STAGING_ID,
        );
        await approve(admin, plugin.slug, { stagingId: SECOND_STAGING_ID }).expect(200);

        expect(await db.client.pluginGrant.findUniqueOrThrow({ where: { id: decision.id } })).toEqual(decision);
        expect(await pluginAbilitySlugsForHousehold(db.client, plugin.id, householdId)).toContain(
          HOUSEHOLD_OPTIONAL_CHECK.slug,
        );
        expect(await householdActCount(plugin, householdId)).toBe(actsBefore);
        expect(await revocationsAfterTwoApprovals(plugin)).toEqual([]);
      });

      it('a decision on a permission the plugin stops declaring survives, confers nothing while undeclared, and confers again when a later update declares it, with no act (#1152)', async () => {
        const admin = await actors.admin();
        // The plugin's own permission, declared and requested at household scope.
        const OWN_HOUSEHOLD_CHECK: Check = {
          slug: 'manage:household_digest',
          required: false,
          reason: { en: 'Keeps the household digest settings it owns.' },
          consentScope: 'household',
        };
        const declaring = ['manage:digest', OWN_HOUSEHOLD_CHECK.slug];
        const activeChecks = [MANAGE_DIGEST_CHECK, OWN_HOUSEHOLD_CHECK];
        const { plugin } = await arrangeStagedPlugin([MANAGE_DIGEST_CHECK], ['manage:digest'], {
          scope: 'household',
          activeChecks,
        });
        const ownSlug = `plugin|${plugin.slug}|${OWN_HOUSEHOLD_CHECK.slug}`;
        const catalogRow = () =>
          db.client.pluginPermission.findUnique({ where: { slug: ownSlug }, select: { riskLevel: true } });

        // The active manifest declares it, so install recorded its catalog row
        // (and the one the builder declares by default); arranged here as it would.
        await db.client.pluginPermission.create({
          data: { pluginId: plugin.id, slug: ownSlug, riskLevel: RiskLevel.Low },
        });
        await db.client.pluginPermission.create({
          data: { pluginId: plugin.id, slug: `plugin|${plugin.slug}|manage:digest`, riskLevel: RiskLevel.Low },
        });
        // The active row's manifest is rewritten to declare it too: the
        // fixture's active manifest takes the builder's declares.
        await db.client.plugin.update({
          where: { id: plugin.id },
          data: {
            manifestJson: { ...manifestWithChecks('1.2.0', activeChecks, declaring), scope: 'household' } as never,
          },
        });

        const { householdId, decision } = await switchOnGranting(plugin, ownSlug);
        const actsBefore = await householdActCount(plugin, householdId);

        expect(await pluginOwnAbilitySlugsForHousehold(db.client, plugin.id, householdId)).toContain(ownSlug);

        await approve(admin, plugin.slug).expect(200);

        expect(await db.client.pluginGrant.findUniqueOrThrow({ where: { id: decision.id } })).toEqual(decision);
        expect(await catalogRow()).toBeNull();
        expect(await pluginOwnAbilitySlugsForHousehold(db.client, plugin.id, householdId)).not.toContain(ownSlug);

        await stageAnotherUpdate(
          plugin,
          { ...manifestWithChecks('1.4.0', activeChecks, declaring), scope: 'household' },
          SECOND_STAGING_ID,
        );
        await approve(admin, plugin.slug, { stagingId: SECOND_STAGING_ID }).expect(200);

        expect(await db.client.pluginGrant.findUniqueOrThrow({ where: { id: decision.id } })).toEqual(decision);
        expect(await catalogRow()).toEqual({ riskLevel: RiskLevel.Low });
        expect(await pluginOwnAbilitySlugsForHousehold(db.client, plugin.id, householdId)).toContain(ownSlug);
        expect(await householdActCount(plugin, householdId)).toBe(actsBefore);
        expect(await revocationsAfterTwoApprovals(plugin)).toEqual([]);
      });
    });

    it('round-trips the Critical challenge from the 409 body — the client re-submits, never recomputes', async () => {
      const admin = await actors.admin();
      const { plugin } = await arrangeStagedPlugin([MANAGE_DIGEST_CHECK, CRITICAL_SERVER_CHECK]);

      const challenge = await approve(admin, plugin.slug).expect(409);

      expect(challenge.body.code).toBe('PLUGIN_UPDATE_CRITICAL_CONFIRMATION');
      expect(challenge.body.slug).toBe(plugin.slug);
      expect(challenge.body.expectedSlugs).toEqual(['manage:safe_http_policy']);
      expect(challenge.body.receivedSlugs).toEqual([]);

      // Nothing activated on the refused attempt.
      const before = await db.client.plugin.findUniqueOrThrow({ where: { id: plugin.id } });
      expect(before.version).toBe('1.2.0');
      expect(before.pendingVersion).toBe('1.3.0');

      await approve(admin, plugin.slug, { confirmCriticalSlugs: challenge.body.expectedSlugs }).expect(200);

      const grants = await db.client.pluginGrant.findMany({
        where: { pluginId: plugin.id, permissionSlug: 'manage:safe_http_policy' },
      });
      expect(grants).toEqual([
        expect.objectContaining({ status: PluginGrantStatus.Granted, decidedRiskLevel: RiskLevel.Critical }),
      ]);
    });

    it('refuses with 409 an approval whose read showed a risk the Owner has since changed, and activates nothing (#1336)', async () => {
      // Approving stamps today's risk on what it grants, and records it as
      // shown; a risk that changed after the read must not ride along.
      const admin = await actors.admin();
      const catalogOwner = await actors.owner();
      const { plugin } = await arrangeStagedPlugin([MANAGE_DIGEST_CHECK, NEW_SERVER_CHECK]);

      const pending = await readPending(admin, plugin.slug).expect(200);
      // The one locale the read was rendered in, which the approval may send back (#1301).
      expect(pending.body.presentation.locale).toBe('en');
      const shownRisks = shownServerRisks(pending.body.presentation.checks);
      const shown = shownRisks.find((risk) => risk.permissionSlug === NEW_SERVER_CHECK.slug);
      const changed = shown?.riskLevel === RiskLevel.Critical ? RiskLevel.High : RiskLevel.Critical;

      try {
        await request(baseUrl)
          .patch(`/api/permission-catalog/permissions/${NEW_SERVER_CHECK.slug}`)
          .set(catalogOwner.headers)
          .send({ riskLevel: changed })
          .expect(200);

        const refused = await approve(admin, plugin.slug, { shownRisks }).expect(409);

        expect(refused.body).toMatchObject({
          code: 'PLUGIN_CONSENT_ACT_STALE',
          slug: plugin.slug,
          kind: 'risk',
          staleRisks: [
            { permissionSlug: NEW_SERVER_CHECK.slug, shownRiskLevel: shown?.riskLevel, currentRiskLevel: changed },
          ],
        });
        const row = await db.client.plugin.findUniqueOrThrow({ where: { id: plugin.id } });
        expect(row.version).toBe('1.2.0');
        expect(row.pendingVersion).toBe('1.3.0');
        await expect(
          db.client.pluginConsentAct.count({
            where: { pluginId: plugin.id, kind: PluginConsentActKind.UpdateApprove },
          }),
        ).resolves.toBe(0);
      } finally {
        await restoreShippedCatalog(db.client);
      }
    });

    it('grants a denied permission the update marks required, under the UpdateApprove act (#1336)', async () => {
      // Approving a version that requires a permission consents to it, so the
      // server admin's earlier refusal does not stand in its way.
      const admin = await actors.admin();
      const { plugin } = await arrangeStagedPlugin([MANAGE_DIGEST_CHECK, { ...NEW_SERVER_CHECK, required: true }]);
      const denied = await seedPolicyGrant(plugin, { status: PluginGrantStatus.Denied });

      const response = await approve(admin, plugin.slug).expect(200);

      expect(response.body.comparison.deniedRequiredSlugs).toEqual(['read:safe_http_policy']);
      expect(response.body.act).toEqual({
        id: expect.any(String),
        kind: 'UpdateApprove',
        decidedAt: expect.any(String),
      });

      const decision = await db.client.pluginGrant.findUniqueOrThrow({ where: { id: denied.id } });
      expect(decision).toMatchObject({
        status: PluginGrantStatus.Granted,
        decidedRiskLevel: RiskLevel.Medium,
        decidedById: admin.user.id,
        actId: response.body.act.id,
      });

      const row = await db.client.plugin.findUniqueOrThrow({ where: { id: plugin.id } });
      expect(row.version).toBe('1.3.0');
      expect(row.pendingVersion).toBeNull();
    });

    it('approval records one UpdateApprove act holding the staged sha (#1336)', async () => {
      const admin = await actors.admin();
      const { plugin } = await arrangeStagedPlugin([MANAGE_DIGEST_CHECK, NEW_SERVER_CHECK]);

      const response = await approve(admin, plugin.slug).set('Accept-Language', 'en').expect(200);

      const acts = await db.client.pluginConsentAct.findMany({ where: { pluginId: plugin.id } });
      expect(acts).toEqual([
        expect.objectContaining({
          id: response.body.act.id,
          kind: 'UpdateApprove',
          scopeType: PluginGrantScope.Server,
          scopeId: '',
          pluginSlug: plugin.slug,
          manifestVersion: '1.3.0',
          manifestSha256: STAGED_SHA,
          decidedById: admin.user.id,
        }),
      ]);
      // What the server admin was shown: every server-scope requested
      // permission of the staged manifest, in the locale it was read in.
      expect(acts[0].presentation).toEqual(
        expect.objectContaining({
          locale: 'en',
          source: 'staged',
          checks: [
            expect.objectContaining({ slug: `plugin|${plugin.slug}|manage:digest`, outcome: 'granted' }),
            expect.objectContaining({ slug: 'read:safe_http_policy', outcome: 'granted' }),
          ],
        }),
      );
      // Every decision the approval wrote names it.
      const decisions = await db.client.pluginGrant.findMany({ where: { pluginId: plugin.id } });
      expect(decisions.map((decision) => decision.actId)).toEqual([acts[0].id, acts[0].id]);
    });

    it('reports user units owing the new decision on the response, announces them, and writes nothing to their rows', async () => {
      const admin = await actors.admin();
      const { plugin } = await arrangeStagedPlugin([MANAGE_DIGEST_CHECK, USER_SCOPE_CHECK]);
      const unit = await db.client.userPlugin.create({
        data: { userId: admin.user.id, pluginId: plugin.id, enabled: true },
      });

      const response = await approve(admin, plugin.slug).expect(200);

      expect(response.body.reconsentUserUnits).toEqual([
        { userId: admin.user.id, outstanding: ['read:game_collection:public'] },
      ]);
      expect(response.body.reconsentHouseholdUnits).toEqual([]);

      // The announcement is the durable record that the member has a review
      // pending (#1149): one lifecycle row per unit, carrying what it owes.
      const events = await awaitLifecycleRow(plugin, PluginLifecycleEventType.ReconsentRequested);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        event: PluginLifecycleEventType.ReconsentRequested,
        scopeType: PluginGrantScope.User,
        scopeId: admin.user.id,
        manifestVersion: '1.3.0',
        payload: { outstandingPermissionSlugs: ['read:game_collection:public'] },
      });

      // Consent standing is worked out when read, so the unit enablement is never
      // written: the member's unit enablement stays on and the row's
      // timestamp proves nothing touched it (#1149).
      const row = await db.client.userPlugin.findUniqueOrThrow({ where: { id: unit.id } });
      expect(row.enabled).toBe(true);
      expect(row.updatedAt).toEqual(unit.updatedAt);
    });

    it('answers 410 when the plugin tombstoned while the update sat pending — uninstalled mid-decision, not a 404', async () => {
      const admin = await actors.admin();
      const { plugin } = await arrangeStagedPlugin([MANAGE_DIGEST_CHECK]);

      await request(baseUrl).post(`${PLUGINS_PATH}/${plugin.slug}/uninstall`).set(admin.headers).send({}).expect(200);

      const response = await approve(admin, plugin.slug).expect(410);
      expect(response.body.code).toBe('PLUGIN_UPDATE_TOMBSTONED');
      expect(response.body.slug).toBe(plugin.slug);
    });

    it('answers 409 when nothing is pending', async () => {
      const admin = await actors.admin();
      const { plugin } = await arrangeStagedPlugin([MANAGE_DIGEST_CHECK]);
      await reject(admin, plugin.slug).expect(200);

      const response = await approve(admin, plugin.slug).expect(409);
      expect(response.body.code).toBe('PLUGIN_UPDATE_NO_PENDING');
    });

    it('answers a malformed staged checksum with its own code and copy, and activates nothing (#1094)', async () => {
      // Only a hand edit writes such a checksum: stage() writes one the
      // directory resolver confirmed, and the database refuses any other form
      // (#1117). The check is lifted for this one write and restored as it
      // was, so approval's backstop refusal is pinned over the wire.
      const admin = await actors.admin();
      const { plugin } = await arrangeStagedPlugin([MANAGE_DIGEST_CHECK]);
      const [check] = await db.client.$queryRaw<{ definition: string }[]>`
        SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conname = 'plugins_pending_sha256_format'`;
      expect(check?.definition).toEqual(expect.any(String));

      await db.client.$executeRawUnsafe('ALTER TABLE "plugins" DROP CONSTRAINT "plugins_pending_sha256_format"');

      try {
        await db.client.plugin.update({ where: { id: plugin.id }, data: { pendingSha256: 'B'.repeat(64) } });

        const response = await approve(admin, plugin.slug).expect(500);

        expect(response.body.code).toBe('PLUGIN_DIRECTORY_LAYOUT');
        expect(response.body.slug).toBe(plugin.slug);
        expect(response.body.message).toContain(`The files of plugin '${plugin.slug}' on the server`);
        // The reason goes to the operator's log, never into the body.
        expect(JSON.stringify(response.body)).not.toContain('lowercase hex');

        const row = await db.client.plugin.findUniqueOrThrow({ where: { id: plugin.id } });
        expect(row.version).toBe('1.2.0');
        expect(row.pendingStagingId).toBe(STAGING_ID);
      } finally {
        await db.client.plugin.updateMany({ where: { id: plugin.id }, data: { pendingSha256: STAGED_SHA } });
        await db.client.$executeRawUnsafe(
          `ALTER TABLE "plugins" ADD CONSTRAINT "plugins_pending_sha256_format" ${check?.definition}`,
        );
      }
    });
  });

  describe('reject', () => {
    it('clears the staged columns, leaves the active version serving, and writes the lifecycle row', async () => {
      const admin = await actors.admin();
      const { plugin } = await arrangeStagedPlugin([MANAGE_DIGEST_CHECK, NEW_SERVER_CHECK]);

      const response = await reject(admin, plugin.slug).expect(200);
      expect(response.body.message).toContain(plugin.slug);

      const row = await db.client.plugin.findUniqueOrThrow({ where: { id: plugin.id } });
      expect(row.version).toBe('1.2.0');
      expect(row.pendingVersion).toBeNull();
      expect(row.pendingManifestJson).toBeNull();
      expect(row.pendingSha256).toBeNull();
      expect(row.pendingSince).toBeNull();
      expect(row.pendingStagingId).toBeNull();
      // Rejection is not an activation: nothing to reload, nothing seeded.
      expect(row.restartRequired).toBe(false);
      await expect(db.client.pluginGrant.count({ where: { pluginId: plugin.id } })).resolves.toBe(0);

      const rows = await awaitLifecycleRow(plugin, PluginLifecycleEventType.UpdateRejected);
      expect(rows).toHaveLength(1);
    });

    it("rejecting a staged update clears its link and registry, and leaves the plugin's own (#1096)", async () => {
      const admin = await actors.admin();
      const plugin = await arrangeStagedPluginWithProvenance();

      await reject(admin, plugin.slug).expect(200);

      const row = await db.client.plugin.findUniqueOrThrow({ where: { id: plugin.id } });
      expect(row).toMatchObject({
        ...FIRST_INSTALL_PROVENANCE,
        installedSha256: INSTALLED_SHA256,
        ...NO_STAGED_UPDATE,
      });
    });
  });

  describe('naming the staging (#357)', () => {
    it('approving with the id of a staging that was rejected and re-staged from the same artifact answers 409 and activates nothing (#357)', async () => {
      // The admin reviewed staging 1 and rejected it; the same artifact was
      // then staged again — same version, same checksum, even the same
      // staging timestamp. An approval still naming staging 1 must not
      // activate staging 2, which nobody has reviewed.
      const admin = await actors.admin();
      const { plugin, pending } = await arrangeStagedPlugin([MANAGE_DIGEST_CHECK, NEW_SERVER_CHECK]);

      await reject(admin, plugin.slug).expect(200);
      await db.client.plugin.update({
        where: { id: plugin.id },
        data: {
          pendingVersion: pending.version,
          pendingManifestJson: pending as never,
          pendingSha256: STAGED_SHA,
          pendingSince: STAGED_AT,
          pendingStagingId: 'e2e-staging-2',
        },
      });

      const response = await approve(admin, plugin.slug, { stagingId: STAGING_ID }).expect(409);

      expect(response.body.code).toBe('PLUGIN_UPDATE_STAGING_REPLACED');
      expect(response.body.slug).toBe(plugin.slug);
      const row = await db.client.plugin.findUniqueOrThrow({ where: { id: plugin.id } });
      expect(row.version).toBe('1.2.0');
      expect(row.pendingVersion).toBe('1.3.0');
      expect(row.pendingStagingId).toBe('e2e-staging-2');
      await expect(db.client.pluginGrant.count({ where: { pluginId: plugin.id } })).resolves.toBe(0);
    });

    it('rejecting with the id of a replaced staging answers 409 and clears nothing (#357)', async () => {
      const admin = await actors.admin();
      const { plugin } = await arrangeStagedPlugin([MANAGE_DIGEST_CHECK, NEW_SERVER_CHECK]);

      const response = await reject(admin, plugin.slug, 'e2e-staging-0').expect(409);

      expect(response.body.code).toBe('PLUGIN_UPDATE_STAGING_REPLACED');
      const row = await db.client.plugin.findUniqueOrThrow({ where: { id: plugin.id } });
      expect(row.pendingStagingId).toBe(STAGING_ID);
    });

    it('a staging whose manifest no longer validates can still be rejected, with the id the plugin read reports (#357)', async () => {
      // A BGE upgrade can leave a staged version outside its bgeCompat range.
      // The staged-update read then refuses to present it, so the id reject
      // needs comes from the plugin read, which never parses the staged
      // manifest.
      const admin = await actors.admin();
      const { plugin, pending } = await arrangeStagedPlugin([MANAGE_DIGEST_CHECK, NEW_SERVER_CHECK]);
      await db.client.plugin.update({
        where: { id: plugin.id },
        data: { pendingManifestJson: { ...pending, bgeCompat: '>=99.0.0' } as never },
      });

      await readPending(admin, plugin.slug).expect(422);
      const detail = await request(baseUrl).get(`${PLUGINS_PATH}/${plugin.slug}`).set(admin.headers).expect(200);
      expect(detail.body.plugin.pendingUpdate.stagingId).toBe(STAGING_ID);

      await reject(admin, plugin.slug, detail.body.plugin.pendingUpdate.stagingId).expect(200);

      const row = await db.client.plugin.findUniqueOrThrow({ where: { id: plugin.id } });
      expect(row.pendingVersion).toBeNull();
      expect(row.pendingStagingId).toBeNull();
    });

    it('the staged-update read reports the staging id (#357)', async () => {
      const admin = await actors.admin();
      const { plugin } = await arrangeStagedPlugin([MANAGE_DIGEST_CHECK, NEW_SERVER_CHECK]);

      const response = await readPending(admin, plugin.slug).expect(200);

      expect(response.body.stagingId).toBe(STAGING_ID);
    });

    it('answers 400 when approve or reject names no staging (#357)', async () => {
      const admin = await actors.admin();
      const { plugin } = await arrangeStagedPlugin([MANAGE_DIGEST_CHECK, NEW_SERVER_CHECK]);

      await request(baseUrl)
        .post(`${PLUGINS_PATH}/${plugin.slug}/update/approve`)
        .set(admin.headers)
        .send({})
        .expect(400);
      await request(baseUrl)
        .post(`${PLUGINS_PATH}/${plugin.slug}/update/reject`)
        .set(admin.headers)
        .send({})
        .expect(400);

      const row = await db.client.plugin.findUniqueOrThrow({ where: { id: plugin.id } });
      expect(row.pendingStagingId).toBe(STAGING_ID);
    });
  });

  describe('the staged-update columns (#357)', () => {
    it('the database refuses a half-staged plugin row (#357)', async () => {
      // Both guarded writes key on the staging id. A row with some staged
      // columns set and others null would let their predicates match the
      // wrong staging, or a degenerate one, so Postgres refuses the shape.
      const active = activeManifest();
      const plugin = await db.client.plugin.create({
        data: pluginRowData({
          slug: active.slug,
          version: active.version,
          scope: PluginScope.Server,
          manifestJson: active as never,
          enabled: true,
        }),
      });

      const failure = await db.client.plugin
        .update({ where: { id: plugin.id }, data: { pendingVersion: '9.9.9' } })
        .catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(Error);
      expect(errorText(failure)).toContain('plugins_staged_update_all_or_nothing');
      const row = await db.client.plugin.findUniqueOrThrow({ where: { id: plugin.id } });
      expect(row.pendingVersion).toBeNull();
    });

    it('the database refuses clearing only part of a staged update (#357)', async () => {
      const { plugin } = await arrangeStagedPlugin([MANAGE_DIGEST_CHECK, NEW_SERVER_CHECK]);

      const failure = await db.client.plugin
        .update({ where: { id: plugin.id }, data: { pendingStagingId: null } })
        .catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(Error);
      expect(errorText(failure)).toContain('plugins_staged_update_all_or_nothing');
      const row = await db.client.plugin.findUniqueOrThrow({ where: { id: plugin.id } });
      expect(row.pendingStagingId).toBe(STAGING_ID);
    });

    it('the database refuses a staged checksum in any other form (#1117)', async () => {
      // Approval makes the staged checksum the installed one, which the
      // database holds to 64 lowercase hex characters, so it holds the staged
      // one to the same form.
      const { plugin } = await arrangeStagedPlugin([MANAGE_DIGEST_CHECK]);

      const failure = await db.client.plugin
        .update({ where: { id: plugin.id }, data: { pendingSha256: 'B'.repeat(64) } })
        .catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(Error);
      expect(errorText(failure)).toContain('plugins_pending_sha256_format');
      const row = await db.client.plugin.findUniqueOrThrow({ where: { id: plugin.id } });
      expect(row.pendingSha256).toBe(STAGED_SHA);
    });

    it('the database refuses a staged link or registry on a plugin with no staged update (#1096)', async () => {
      // The link and registry describe the staged artifact's provenance, so
      // they mean nothing on a row with no staged update to describe.
      const plugin = await db.client.plugin.create({ data: pluginRowData() });

      const failure = await db.client.plugin
        .update({ where: { id: plugin.id }, data: { pendingFromUrl: 'https://artifacts.example.test/x.tgz' } })
        .catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(Error);
      expect(errorText(failure)).toContain('plugins_staged_provenance_needs_staging');
      const row = await db.client.plugin.findUniqueOrThrow({ where: { id: plugin.id } });
      expect(row.pendingFromUrl).toBeNull();
      expect(row.pendingRegistrySlug).toBeNull();
    });

    it('the database refuses a staged registry alone on a plugin with no staged update (#1096)', async () => {
      // The constraint's other arm: the registry is refused on its own, not
      // only when it rides with a link.
      const plugin = await db.client.plugin.create({ data: pluginRowData() });

      const failure = await db.client.plugin
        .update({ where: { id: plugin.id }, data: { pendingRegistrySlug: 'e2e-registry' } })
        .catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(Error);
      expect(errorText(failure)).toContain('plugins_staged_provenance_needs_staging');
      const row = await db.client.plugin.findUniqueOrThrow({ where: { id: plugin.id } });
      expect(row.pendingFromUrl).toBeNull();
      expect(row.pendingRegistrySlug).toBeNull();
    });
  });

  describe('pending read', () => {
    it('renders the escalations, staging metadata, and the localized consent surface for the Server unit', async () => {
      const admin = await actors.admin();
      const { plugin } = await arrangeStagedPlugin([MANAGE_DIGEST_CHECK, NEW_SERVER_CHECK]);

      const response = await readPending(admin, plugin.slug).expect(200);

      expect(response.body.activeVersion).toBe('1.2.0');
      expect(response.body.pendingVersion).toBe('1.3.0');
      expect(response.body.pendingSince).toBe(STAGED_AT.toISOString());
      expect(response.body.serverGating).toBe(true);
      expect(response.body.deniedRequiredSlugs).toEqual([]);
      expect(response.body.escalations).toEqual([
        expect.objectContaining({ kind: 'new-permission', slug: 'read:safe_http_policy', consentScope: 'server' }),
      ]);

      const { presentation } = response.body;
      // The plugin envelope rides inside the presentation — one wire name
      // for one fact.
      expect(presentation.plugin).toEqual({ id: plugin.id, slug: plugin.slug, enabled: true });
      expect(presentation.source).toBe('staged');
      expect(presentation.manifestVersion).toBe('1.3.0');
      expect(presentation.unit).toEqual({ scopeType: 'Server' });
      // The default locale resolves without fallback — the provenance the
      // renderer keys its "untranslated" affordance on.
      expect(presentation.displayName).toEqual(expect.objectContaining({ value: 'Demo Sink', usedFallback: false }));
      expect(presentation.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            slug: 'read:safe_http_policy',
            decision: 'pending',
            decidableByUnit: true,
            riskLevel: RiskLevel.Medium,
          }),
        ]),
      );
    });

    it('reports the declares[] catalog diff the approval would apply', async () => {
      const admin = await actors.admin();
      // v1.3.0 renames the plugin's own declared permission, so the diff has
      // both halves. `removed` is what makes this load-bearing: approving
      // deletes that permission and every grant on it, and nothing in
      // escalations or checks says so.
      const { plugin } = await arrangeStagedPlugin(
        [{ ...MANAGE_DIGEST_CHECK, slug: 'manage:archive' }],
        ['manage:archive'],
      );

      const response = await readPending(admin, plugin.slug).expect(200);

      expect(response.body.declares).toEqual({
        added: [`plugin|${plugin.slug}|manage:archive`],
        removed: [`plugin|${plugin.slug}|manage:digest`],
      });
    });

    it('reports an empty declares[] diff when the update leaves the catalog alone', async () => {
      const admin = await actors.admin();
      const { plugin } = await arrangeStagedPlugin([MANAGE_DIGEST_CHECK, NEW_SERVER_CHECK]);

      const response = await readPending(admin, plugin.slug).expect(200);

      expect(response.body.declares).toEqual({ added: [], removed: [] });
    });

    it('reports a denied permission the update requires as deniedRequiredSlugs, which approving grants (#1336)', async () => {
      const admin = await actors.admin();
      const { plugin } = await arrangeStagedPlugin([MANAGE_DIGEST_CHECK, { ...NEW_SERVER_CHECK, required: true }]);
      await seedPolicyGrant(plugin, { status: PluginGrantStatus.Denied });

      const response = await readPending(admin, plugin.slug).expect(200);

      expect(response.body.deniedRequiredSlugs).toEqual(['read:safe_http_policy']);
      expect(response.body.serverGating).toBe(true);
    });

    it('the approval surface counts the households that already accepted the staged update, and approval asks exactly the rest (#1336)', async () => {
      const admin = await actors.admin();
      const owners = await Promise.all([actors.user(), actors.user(), actors.user()]);
      const [accepting, ...waiting] = (
        await Promise.all(owners.map((owner) => actors.householdWithMembers({ owner })))
      ).map(({ household }) => household);
      // v1.3.0 asks every household for a new required permission, and users
      // for nothing new.
      const { plugin } = await arrangeStagedPlugin([MANAGE_DIGEST_CHECK, HOUSEHOLD_CHECK], undefined, {
        scope: 'household',
      });

      await db.client.householdPlugin.createMany({
        data: [accepting, ...waiting].map((household) => ({
          householdId: household.id,
          pluginId: plugin.id,
          enabled: true,
          config: {},
        })),
      });

      const before = await readPending(admin, plugin.slug).expect(200);

      expect(before.body.unitCoverage).toEqual({
        household: { switchedOn: 3, covered: 0 },
        user: { switchedOn: 0, covered: 0 },
      });

      // One household accepts the staged update ahead of time, through a
      // review act against the staged sha.
      const unit = { householdId: accepting.id };
      const staged = await readConsentSurface(baseUrl, owners[0], unit, plugin.slug, { staged: true });

      await sendReview(
        baseUrl,
        owners[0],
        unit,
        plugin.slug,
        reviewBody(staged, { [HOUSEHOLD_CHECK.slug]: PluginGrantStatus.Granted }),
      ).expect(200);

      const after = await readPending(admin, plugin.slug).expect(200);

      expect(after.body.unitCoverage).toEqual({
        household: { switchedOn: 3, covered: 1 },
        user: { switchedOn: 0, covered: 0 },
      });

      const approved = await approve(admin, plugin.slug).expect(200);
      const owing = approved.body.reconsentHouseholdUnits as { householdId: string; outstanding: string[] }[];

      expect(owing.map((entry) => entry.householdId).sort()).toEqual(waiting.map((household) => household.id).sort());
      expect(owing).toHaveLength(
        after.body.unitCoverage.household.switchedOn - after.body.unitCoverage.household.covered,
      );
      expect(owing.every((entry) => entry.outstanding.join() === HOUSEHOLD_CHECK.slug)).toBe(true);
      expect(approved.body.reconsentUserUnits).toEqual([]);
    });

    it('draws the 404 / 410 / 409 distinctions', async () => {
      const admin = await actors.admin();

      const absent = await readPending(admin, `absent-${randomUUID().slice(0, 8)}`).expect(404);
      expect(absent.body.code).toBe('PLUGIN_UPDATE_PLUGIN_NOT_FOUND');

      const { plugin: tombstoned } = await arrangeStagedPlugin([MANAGE_DIGEST_CHECK]);
      await request(baseUrl)
        .post(`${PLUGINS_PATH}/${tombstoned.slug}/uninstall`)
        .set(admin.headers)
        .send({})
        .expect(200);
      const gone = await readPending(admin, tombstoned.slug).expect(410);
      expect(gone.body.code).toBe('PLUGIN_UPDATE_TOMBSTONED');
    });

    it('answers 409 once the staged update is resolved', async () => {
      const admin = await actors.admin();
      const { plugin } = await arrangeStagedPlugin([MANAGE_DIGEST_CHECK]);

      await readPending(admin, plugin.slug).expect(200);
      await reject(admin, plugin.slug).expect(200);

      const response = await readPending(admin, plugin.slug).expect(409);
      expect(response.body.code).toBe('PLUGIN_UPDATE_NO_PENDING');
    });
  });
});
