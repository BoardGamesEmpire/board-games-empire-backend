import {
  PluginCategory,
  PluginGrantScope,
  PluginGrantStatus,
  PluginLifecycleEventType,
  PluginScope,
  PluginUnitDormantReason,
  RiskLevel,
  type Plugin,
} from '@bge/database';
import { createActors, pollUntil, type Actors, type SessionActor } from '@bge/testing-e2e';
import { buildPluginManifest, type PluginManifest } from '@boardgamesempire/plugin-manifest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

/**
 * The wire half of #321: approve/reject/pending over a REAL staged row —
 * grants seeded and re-stamped as persisted rows, the 409 challenge
 * round-trip driven from the error body, suspension visible in both the
 * response and the unit table, and the 404/410/409 distinctions the
 * pending read draws.
 *
 * Staged state is arranged directly on the row — the ingress that calls
 * `stage()` with a resolved directory is #84's, and no endpoint exists.
 * Core checks reference SEEDED permissions only (`permissions` is a
 * preserved table the between-test sweep never truncates, so tests must not
 * write to it): `read:safe_http_policy` (Medium) as the plain new check and
 * `manage:safe_http_policy` (Critical) as the second-factor trigger.
 */
describe('plugin update consent (approve/reject/pending)', () => {
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

  /** Seeded with `conditions: { userId: ... }`, so a user-scope check passes the unit-boundedness gate. */
  const USER_SCOPE_CHECK = {
    slug: 'update:user:profile:own',
    required: true,
    reason: { en: 'Records each member’s digest delivery preference on their profile.' },
    consentScope: 'user' as const,
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

  const activeManifest = (): PluginManifest => manifestWithChecks('1.2.0', [MANAGE_DIGEST_CHECK]);

  const arrangeStagedPlugin = async (
    pendingChecks: readonly Check[],
    pendingDeclares?: readonly string[],
    overrides: {
      /** Defaults to 'server' — every existing caller's plugin. */
      readonly scope?: PluginManifest['scope'];
      /** The ACTIVE row's retained config, pre-activation. Defaults to `{}`. */
      readonly activeConfig?: Record<string, unknown>;
      /** Merged onto the pending manifest's `config` section (D-CN, #370). */
      readonly pendingConfig?: Partial<PluginManifest['config']>;
    } = {},
  ): Promise<{ plugin: Plugin; pending: PluginManifest }> => {
    const scope = overrides.scope ?? 'server';
    const active: PluginManifest = { ...activeManifest(), scope };
    const pendingBase = manifestWithChecks('1.3.0', pendingChecks, pendingDeclares);
    const pending: PluginManifest = {
      ...pendingBase,
      scope,
      ...(overrides.pendingConfig === undefined
        ? {}
        : { config: { ...pendingBase.config, ...overrides.pendingConfig } }),
    };

    const plugin = await db.client.plugin.create({
      data: {
        slug: active.slug,
        version: active.version,
        category: PluginCategory.FeedbackSink,
        scope: scope === 'server' ? PluginScope.Server : PluginScope.Household,
        manifestJson: active as never,
        enabled: true,
        bundled: false,
        installedSha256: randomUUID(),
        config: (overrides.activeConfig ?? {}) as never,
        pendingVersion: pending.version,
        pendingManifestJson: pending as never,
        pendingSha256: 'e2e-new-sha',
        pendingSince: STAGED_AT,
      },
    });

    return { plugin, pending };
  };

  const approve = (actor: SessionActor, slug: string, body: Record<string, unknown> = {}) =>
    request(baseUrl).post(`${PLUGINS_PATH}/${slug}/update/approve`).set(actor.headers).send(body);

  const reject = (actor: SessionActor, slug: string) =>
    request(baseUrl).post(`${PLUGINS_PATH}/${slug}/update/reject`).set(actor.headers).send({});

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
        manifestVersion: plugin.version,
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
      expect(response.body.suspendedHouseholdUnits).toEqual([]);
      expect(response.body.suspendedUserUnits).toEqual([]);
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
      expect(row.installedSha256).toBe('e2e-new-sha');

      const grants = await db.client.pluginGrant.findMany({ where: { pluginId: plugin.id } });
      expect(grants).toHaveLength(2);
      expect(grants).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            permissionSlug: `plugin|${plugin.slug}|manage:digest`,
            scopeType: PluginGrantScope.Server,
            status: PluginGrantStatus.Granted,
            decidedRiskLevel: RiskLevel.Low,
            manifestVersion: '1.3.0',
          }),
          expect.objectContaining({
            permissionSlug: 'read:safe_http_policy',
            scopeType: PluginGrantScope.Server,
            status: PluginGrantStatus.Granted,
            decidedRiskLevel: RiskLevel.Medium,
            manifestVersion: '1.3.0',
          }),
        ]),
      );

      const rows = await awaitLifecycleRow(plugin, PluginLifecycleEventType.UpdateApproved);
      expect(rows).toHaveLength(1);
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
     * The household half of #370's general pass: #369 only re-validated rows
     * already dormant for scope, so an already-serving household row never
     * faced a manifest replacement that came after it.
     */
    it('marks an already-serving household row NeedsConfiguration when activation tightens the schema underneath it (#370)', async () => {
      const admin = await actors.admin();
      const owner = await actors.user();
      const { household } = await actors.householdWithMembers({ owner });
      const { plugin } = await arrangeStagedPlugin([MANAGE_DIGEST_CHECK], undefined, {
        scope: 'household',
        pendingConfig: {
          schema: { type: 'object', properties: { webhookUrl: { type: 'string' } }, required: ['webhookUrl'] },
        },
      });
      const unit = await db.client.householdPlugin.create({
        data: { householdId: household.id, pluginId: plugin.id, enabled: true, config: { webhookUrl: 42 } },
      });

      await approve(admin, plugin.slug).expect(200);

      const row = await db.client.householdPlugin.findUniqueOrThrow({ where: { id: unit.id } });
      expect(row).toMatchObject({ enabled: true, dormantReason: PluginUnitDormantReason.NeedsConfiguration });
    });

    it('re-stamps a risk-escalated server grant at today’s risk and the new version', async () => {
      const admin = await actors.admin();
      const { plugin } = await arrangeStagedPlugin([MANAGE_DIGEST_CHECK, NEW_SERVER_CHECK]);
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
      expect(reStamped.manifestVersion).toBe('1.3.0');
      expect(reStamped.decidedById).toBe(admin.user.id);
    });

    it('round-trips the Critical challenge from the 409 body — the client re-submits, never recomputes', async () => {
      const admin = await actors.admin();
      const { plugin } = await arrangeStagedPlugin([MANAGE_DIGEST_CHECK, CRITICAL_SERVER_CHECK]);

      const challenge = await approve(admin, plugin.slug).expect(409);

      expect(challenge.body.code).toBe('PluginUpdateCriticalConfirmationError');
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

    it('refuses over a durable denial on a permission the update marks required', async () => {
      const admin = await actors.admin();
      const { plugin } = await arrangeStagedPlugin([MANAGE_DIGEST_CHECK, { ...NEW_SERVER_CHECK, required: true }]);
      await seedPolicyGrant(plugin, { status: PluginGrantStatus.Denied });

      const response = await approve(admin, plugin.slug).expect(409);

      expect(response.body.code).toBe('PluginUpdateBlockedByDenialError');
      expect(response.body.deniedRequiredSlugs).toEqual(['read:safe_http_policy']);

      const row = await db.client.plugin.findUniqueOrThrow({ where: { id: plugin.id } });
      expect(row.version).toBe('1.2.0');
      expect(row.pendingVersion).toBe('1.3.0');
    });

    it('suspends user units owing the new decision and reports them on the response', async () => {
      const admin = await actors.admin();
      const { plugin } = await arrangeStagedPlugin([MANAGE_DIGEST_CHECK, USER_SCOPE_CHECK]);
      const unit = await db.client.userPlugin.create({
        data: { userId: admin.user.id, pluginId: plugin.id, enabled: true },
      });

      const response = await approve(admin, plugin.slug).expect(200);

      expect(response.body.suspendedUserUnits).toEqual([
        { userId: admin.user.id, outstanding: ['update:user:profile:own'] },
      ]);
      expect(response.body.suspendedHouseholdUnits).toEqual([]);

      const row = await db.client.userPlugin.findUniqueOrThrow({ where: { id: unit.id } });
      expect(row.suspendedForConsent).toBe(true);
      expect(row.suspendedAt).not.toBeNull();
      // Suspension parks the unit pending re-consent; the member's enable
      // INTENT is not overwritten.
      expect(row.enabled).toBe(true);
    });

    it('answers 410 when the plugin tombstoned while the update sat pending — uninstalled mid-decision, not a 404', async () => {
      const admin = await actors.admin();
      const { plugin } = await arrangeStagedPlugin([MANAGE_DIGEST_CHECK]);

      await request(baseUrl).post(`${PLUGINS_PATH}/${plugin.slug}/uninstall`).set(admin.headers).send({}).expect(200);

      const response = await approve(admin, plugin.slug).expect(410);
      expect(response.body.code).toBe('PluginUpdateTombstonedError');
      expect(response.body.slug).toBe(plugin.slug);
    });

    it('answers 409 when nothing is pending', async () => {
      const admin = await actors.admin();
      const { plugin } = await arrangeStagedPlugin([MANAGE_DIGEST_CHECK]);
      await reject(admin, plugin.slug).expect(200);

      const response = await approve(admin, plugin.slug).expect(409);
      expect(response.body.code).toBe('PluginUpdateNoPendingError');
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
      // Rejection is not an activation: nothing to reload, nothing seeded.
      expect(row.restartRequired).toBe(false);
      await expect(db.client.pluginGrant.count({ where: { pluginId: plugin.id } })).resolves.toBe(0);

      const rows = await awaitLifecycleRow(plugin, PluginLifecycleEventType.UpdateRejected);
      expect(rows).toHaveLength(1);
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
      expect(response.body.blockedByDenial).toEqual([]);
      expect(response.body.escalations).toEqual([
        expect.objectContaining({ kind: 'new-permission', slug: 'read:safe_http_policy', consentScope: 'server' }),
      ]);

      const { presentation } = response.body;
      // The plugin envelope rides inside the presentation — one wire name
      // for one fact.
      expect(presentation.plugin).toEqual({ id: plugin.id, slug: plugin.slug, enabled: true });
      expect(presentation.source).toBe('pending');
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

    it('renders a durable denial as blockedByDenial state — the read reports, only approve refuses', async () => {
      const admin = await actors.admin();
      const { plugin } = await arrangeStagedPlugin([MANAGE_DIGEST_CHECK, { ...NEW_SERVER_CHECK, required: true }]);
      await seedPolicyGrant(plugin, { status: PluginGrantStatus.Denied });

      const response = await readPending(admin, plugin.slug).expect(200);

      expect(response.body.blockedByDenial).toEqual(['read:safe_http_policy']);
    });

    it('draws the 404 / 410 / 409 distinctions', async () => {
      const admin = await actors.admin();

      const absent = await readPending(admin, `absent-${randomUUID().slice(0, 8)}`).expect(404);
      expect(absent.body.code).toBe('PluginUpdatePluginNotFoundError');

      const { plugin: tombstoned } = await arrangeStagedPlugin([MANAGE_DIGEST_CHECK]);
      await request(baseUrl)
        .post(`${PLUGINS_PATH}/${tombstoned.slug}/uninstall`)
        .set(admin.headers)
        .send({})
        .expect(200);
      const gone = await readPending(admin, tombstoned.slug).expect(410);
      expect(gone.body.code).toBe('PluginUpdateTombstonedError');
    });

    it('answers 409 once the staged update is resolved', async () => {
      const admin = await actors.admin();
      const { plugin } = await arrangeStagedPlugin([MANAGE_DIGEST_CHECK]);

      await readPending(admin, plugin.slug).expect(200);
      await reject(admin, plugin.slug).expect(200);

      const response = await readPending(admin, plugin.slug).expect(409);
      expect(response.body.code).toBe('PluginUpdateNoPendingError');
    });
  });
});
