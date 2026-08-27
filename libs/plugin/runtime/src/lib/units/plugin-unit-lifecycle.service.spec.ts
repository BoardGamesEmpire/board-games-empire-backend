import {
  PluginCategory,
  PluginExecutionMode,
  PluginGrantScope,
  PluginGrantStatus,
  PluginScope,
  PluginUnitDormantReason,
  Prisma,
  type HouseholdPlugin,
  type Plugin,
  type UserPlugin,
} from '@bge/database';
import { createMockDatabaseService, type MockDatabaseService } from '@bge/testing';
import { PluginEvent } from '@boardgamesempire/plugin-contract';
import { buildPluginManifest, type PluginManifest } from '@boardgamesempire/plugin-manifest';
import { Logger } from '@nestjs/common';
import { PluginConfigValidationError } from '../config/config-schema.errors';
import { PluginConfigSchemaService } from '../config/plugin-config-schema.service';
import {
  HouseholdPluginConfigUpdatedEvent,
  HouseholdPluginDisabledEvent,
  HouseholdPluginEnabledEvent,
  UserPluginDisabledEvent,
  UserPluginEnabledEvent,
} from '../events/plugin.events';
import type { PluginGrantAuthorityService } from '../grants/plugin-grant-authority.service';
import type { PluginModuleOptions } from '../plugin-module.options';
import { PluginUnitLifecycleService } from './plugin-unit-lifecycle.service';
import {
  PluginUnitAuthorityError,
  PluginUnitConfigRequiredError,
  PluginUnitNotEnrolledError,
  PluginUnitPluginChangedError,
  PluginUnitPluginNotFoundError,
  PluginUnitPluginTombstonedError,
  PluginUnitScopeError,
} from './unit.errors';

describe('PluginUnitLifecycleService', () => {
  const options: PluginModuleOptions = {
    pluginsRoot: '/var/lib/bge/plugins',
    bundledRoot: '/srv/bge/plugins/bundled',
    bgeVersion: '0.3.0',
    defaultLocale: 'en',
  };

  const CANONICAL_DIGEST = 'plugin|demo-sink|manage:digest';

  /** Household-scope manifest with one REQUIRED household-consented check. */
  const householdManifest = (config?: Partial<PluginManifest['config']>): PluginManifest =>
    buildPluginManifest({
      scope: 'household',
      permissions: {
        declares: ['manage:digest'],
        checks: [
          {
            slug: 'manage:digest',
            required: true,
            reason: { en: 'Stores and manages the digest configuration it owns.' },
            consentScope: 'household',
          },
        ],
      },
      config,
    });

  const makePlugin = (overrides: Partial<Plugin> = {}): Plugin => ({
    id: 'plugin-1',
    slug: 'demo-sink',
    version: '1.2.0',
    category: PluginCategory.FeedbackSink,
    scope: PluginScope.Household,
    executionMode: PluginExecutionMode.InProcess,
    enabled: true,
    bundled: false,
    manifestJson: householdManifest() as unknown as Prisma.JsonValue,
    config: {},
    loadFailed: false,
    loadError: null,
    installedById: null,
    installedAt: new Date(0),
    updateCheckEnabled: false,
    lastUpdateCheckAt: null,
    latestKnownVersion: null,
    latestKnownChannel: null,
    securityAdvisory: null,
    installedFromUrl: null,
    installedSha256: 'sha-1',
    registrySlug: null,
    pendingVersion: null,
    pendingManifestJson: null,
    pendingSha256: null,
    pendingSince: null,
    restartRequired: false,
    uninstalledAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  });

  const makeHouseholdRow = (overrides: Partial<HouseholdPlugin> = {}): HouseholdPlugin => ({
    id: 'hp-1',
    householdId: 'hh-1',
    pluginId: 'plugin-1',
    enabled: true,
    suspendedForConsent: false,
    suspendedAt: null,
    config: {},
    dormantReason: null,
    dormantAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  });

  const makeUserRow = (overrides: Partial<UserPlugin> = {}): UserPlugin => ({
    id: 'up-1',
    userId: 'user-1',
    pluginId: 'plugin-1',
    enabled: true,
    suspendedForConsent: false,
    suspendedAt: null,
    config: {},
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  });

  const enableInput = { slug: 'demo-sink', householdId: 'hh-1', actorId: 'admin-1' };

  let db: MockDatabaseService;
  let authority: jest.Mocked<Pick<PluginGrantAuthorityService, 'isHouseholdAdmin'>>;
  let emitter: { emit: jest.Mock };
  let service: PluginUnitLifecycleService;

  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  beforeEach(() => {
    db = createMockDatabaseService();
    db.$transaction.mockImplementation((cb) => cb(db));
    db.plugin.findUnique.mockResolvedValue(makePlugin());
    // The in-transaction liveness re-read (FOR SHARE): alive by default.
    db.$queryRaw.mockResolvedValue([
      { uninstalled_at: null, scope: PluginScope.Household, version: '1.2.0', installed_at: new Date(0) },
    ] as never);
    db.pluginGrant.findMany.mockResolvedValue([]);
    authority = { isHouseholdAdmin: jest.fn().mockResolvedValue(true) };
    emitter = { emit: jest.fn() };

    service = new PluginUnitLifecycleService(
      db as never,
      authority as unknown as PluginGrantAuthorityService,
      new PluginConfigSchemaService(),
      emitter as never,
      options,
    );
  });

  const emittedEvents = () => emitter.emit.mock.calls.map(([name, event]) => ({ name, event }));

  describe('enableHousehold', () => {
    it('creates the row enabled with empty config on first enable and emits a creation-shaped enabled event', async () => {
      db.householdPlugin.findUnique.mockResolvedValue(null);
      const created = makeHouseholdRow({ config: {} });
      db.householdPlugin.create.mockResolvedValue(created);

      const row = await service.enableHousehold(enableInput);

      expect(row).toBe(created);
      expect(db.householdPlugin.create).toHaveBeenCalledWith({
        data: {
          householdId: 'hh-1',
          pluginId: 'plugin-1',
          enabled: true,
          suspendedForConsent: false,
          suspendedAt: null,
          config: {},
        },
      });

      const [{ name, event }] = emittedEvents();
      expect(name).toBe(PluginEvent.Enabled);
      expect(event).toBeInstanceOf(HouseholdPluginEnabledEvent);
      expect(event.before).toBeNull();
      expect(event.after.enabled).toBe(true);
      expect(event.bornSuspendedSlugs).toEqual([]);
    });

    it('is born suspended when a required household-scope check carries a durable denial, and the event names it', async () => {
      db.householdPlugin.findUnique.mockResolvedValue(null);
      db.pluginGrant.findMany.mockResolvedValue([{ permissionSlug: CANONICAL_DIGEST }] as never);
      db.householdPlugin.create.mockImplementation((({ data }: { data: Partial<HouseholdPlugin> }) =>
        Promise.resolve(makeHouseholdRow(data))) as never);

      const row = await service.enableHousehold(enableInput);

      expect(row.suspendedForConsent).toBe(true);
      // Denied specifically, never merely pending, and only the REQUIRED
      // household-scope slugs enter the probe — the delta-scoping the
      // suspension machinery uses.
      expect(db.pluginGrant.findMany).toHaveBeenCalledWith({
        where: {
          pluginId: 'plugin-1',
          scopeType: PluginGrantScope.Household,
          scopeId: 'hh-1',
          status: PluginGrantStatus.Denied,
          permissionSlug: { in: [CANONICAL_DIGEST] },
        },
        select: { permissionSlug: true },
      });
      expect(db.householdPlugin.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ suspendedForConsent: true, suspendedAt: expect.any(Date) }),
      });

      // The blocking slugs ride the creation event: no suspension event
      // fires for a birth state, so this is the durable "why".
      const [{ event }] = emittedEvents();
      expect(event.bornSuspendedSlugs).toEqual([CANONICAL_DIGEST]);
    });

    it('skips the denial probe entirely when the manifest has no required household-scope checks', async () => {
      const optionalOnly = buildPluginManifest({
        scope: 'household',
        permissions: {
          declares: ['manage:digest'],
          checks: [
            {
              slug: 'manage:digest',
              required: false,
              reason: { en: 'Optional digest management.' },
              consentScope: 'household',
            },
          ],
        },
      });
      db.plugin.findUnique.mockResolvedValue(makePlugin({ manifestJson: optionalOnly as unknown as Prisma.JsonValue }));
      db.householdPlugin.findUnique.mockResolvedValue(null);
      db.householdPlugin.create.mockResolvedValue(makeHouseholdRow());

      await service.enableHousehold(enableInput);

      expect(db.pluginGrant.findMany).not.toHaveBeenCalled();
      expect(db.householdPlugin.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ suspendedForConsent: false }),
      });
    });

    it('opens the transaction plugin-row first: liveness re-read, then the scope lock, then the unit row', async () => {
      db.householdPlugin.findUnique.mockResolvedValue(makeHouseholdRow({ enabled: false }));
      db.householdPlugin.update.mockResolvedValue(makeHouseholdRow());

      await service.enableHousehold(enableInput);

      const [advisoryStrings, ...advisoryValues] = db.$executeRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
      expect(advisoryStrings.join('?')).toContain('pg_advisory_xact_lock(hashtextextended(');
      expect(advisoryValues).toContain('plugin_grant:household_unit:hh-1:plugin-1');

      const [livenessStrings] = db.$queryRaw.mock.calls[0] as [TemplateStringsArray];
      expect(livenessStrings.join('?').replace(/\s+/g, ' ')).toContain(
        'SELECT uninstalled_at, scope, version, installed_at FROM plugins WHERE id = ? FOR SHARE',
      );

      // The plugin row MUST precede the advisory lock. Uninstall and
      // activation claim that row before touching grant rows, and decide()
      // holds a grant row while taking this advisory — advisory-first would
      // close the cycle advisory → plugin → grant → advisory, which
      // Postgres resolves by aborting a caller.
      const livenessOrder = db.$queryRaw.mock.invocationCallOrder[0];
      const advisoryOrder = db.$executeRaw.mock.invocationCallOrder[0];
      const readOrder = db.householdPlugin.findUnique.mock.invocationCallOrder[0];
      expect(livenessOrder).toBeLessThan(advisoryOrder);
      expect(advisoryOrder).toBeLessThan(readOrder);
    });

    it('refuses when a concurrent activation promoted a new version after the manifest was read', async () => {
      // The probe and the config gate were both derived from 1.2.0's
      // manifest. Applying them against 1.3.0 can create a serving row
      // beside a durable denial of a newly required check, or suspend one
      // over a check 1.3.0 dropped and no decision can heal. Activation's
      // own suspension pass cannot cover for it: that pass runs inside the
      // activation transaction, so a row created after it committed is
      // invisible to it.
      db.householdPlugin.findUnique.mockResolvedValue(null);
      db.$queryRaw.mockResolvedValue([
        { uninstalled_at: null, scope: PluginScope.Household, version: '1.3.0', installed_at: new Date(0) },
      ] as never);

      await expect(service.enableHousehold(enableInput)).rejects.toMatchObject({
        name: 'PluginUnitPluginChangedError',
        kind: 'version-activated',
      });
      expect(db.householdPlugin.create).not.toHaveBeenCalled();
      expect(db.$executeRaw).not.toHaveBeenCalled();
    });

    it('refuses a SAME-VERSION reinstall — a tombstone reinstall replaces the manifest in place', async () => {
      // The installer's reinstall branch updates manifestJson on the same
      // row at possibly the same version, stamping a fresh installedAt.
      // Version alone cannot see that, so installedAt is carried too.
      db.householdPlugin.findUnique.mockResolvedValue(null);
      db.$queryRaw.mockResolvedValue([
        { uninstalled_at: null, scope: PluginScope.Household, version: '1.2.0', installed_at: new Date(9_000) },
      ] as never);

      await expect(service.enableHousehold(enableInput)).rejects.toMatchObject({
        name: 'PluginUnitPluginChangedError',
        kind: 'reinstalled',
      });
      expect(db.householdPlugin.create).not.toHaveBeenCalled();
    });

    it('classifies a DIFFERENT-version reinstall as a reinstall, not an activation', async () => {
      // A reinstall installs whatever version it was handed, so it can move
      // version AND installedAt. installedAt is tested first because the
      // installer is its only writer — testing version first would report
      // this as an activation and tell the client consent survived, when
      // the reinstall's uninstall purged every grant.
      db.householdPlugin.findUnique.mockResolvedValue(null);
      db.$queryRaw.mockResolvedValue([
        { uninstalled_at: null, scope: PluginScope.Household, version: '1.3.0', installed_at: new Date(9_000) },
      ] as never);

      await expect(service.enableHousehold(enableInput)).rejects.toMatchObject({
        name: 'PluginUnitPluginChangedError',
        kind: 'reinstalled',
        expectedVersion: '1.2.0',
        actualVersion: '1.3.0',
      });
      expect(db.householdPlugin.create).not.toHaveBeenCalled();
    });

    it('refuses a config PATCH judged against a superseded schema', async () => {
      db.$queryRaw.mockResolvedValue([
        { uninstalled_at: null, scope: PluginScope.Household, version: '1.3.0', installed_at: new Date(0) },
      ] as never);

      await expect(
        service.updateHouseholdConfig({ ...enableInput, config: { webhookUrl: 'https://x' } }),
      ).rejects.toBeInstanceOf(PluginUnitPluginChangedError);
      expect(db.householdPlugin.update).not.toHaveBeenCalled();
    });

    it('does NOT refuse a version move on disable — no manifest judgment rides a switch flip', async () => {
      // Deliberate asymmetry: refusing here would invent a failure for a
      // path that derived nothing from the manifest.
      db.householdPlugin.findUnique.mockResolvedValue(makeHouseholdRow({ enabled: true }));
      db.householdPlugin.update.mockResolvedValue(makeHouseholdRow({ enabled: false }));
      db.$queryRaw.mockResolvedValue([
        { uninstalled_at: null, scope: PluginScope.Household, version: '1.3.0', installed_at: new Date(0) },
      ] as never);

      await expect(service.disableHousehold(enableInput)).resolves.toMatchObject({ enabled: false });
    });

    it('refuses when a concurrent activation re-scoped the plugin to server after the pre-read', async () => {
      // Activation rewrites version/scope/manifestJson together, and the
      // FOR SHARE re-read is what sees it. A household row for a
      // server-scope plugin is an artifact the manifest gate says cannot
      // exist and nothing else cleans up, so the refusal is the whole point.
      db.$queryRaw.mockResolvedValue([
        { uninstalled_at: null, scope: PluginScope.Server, version: '1.2.0', installed_at: new Date(0) },
      ] as never);

      await expect(service.enableHousehold(enableInput)).rejects.toBeInstanceOf(PluginUnitScopeError);
      expect(db.householdPlugin.create).not.toHaveBeenCalled();
      expect(db.householdPlugin.update).not.toHaveBeenCalled();
      // Refused before serializing anyone else on this unit's advisory key.
      expect(db.$executeRaw).not.toHaveBeenCalled();
    });

    it('refuses inside the transaction when a concurrent uninstall tombstoned the plugin after the pre-read', async () => {
      // The pre-transaction load saw the plugin alive; the FOR SHARE
      // re-read is what keeps an enable from committing a fresh row beside
      // a tombstone whose purge promised no such row exists.
      db.householdPlugin.findUnique.mockResolvedValue(null);
      db.$queryRaw.mockResolvedValue([
        { uninstalled_at: new Date(7), scope: PluginScope.Household, version: '1.2.0', installed_at: new Date(0) },
      ] as never);

      await expect(service.enableHousehold(enableInput)).rejects.toBeInstanceOf(PluginUnitPluginTombstonedError);
      expect(db.householdPlugin.create).not.toHaveBeenCalled();
    });

    it('validates inline config, writes it with the creation, and announces the initial document as a config write', async () => {
      db.householdPlugin.findUnique.mockResolvedValue(null);
      db.householdPlugin.create.mockResolvedValue(makeHouseholdRow({ config: { webhookUrl: 'https://x' } }));

      await service.enableHousehold({ ...enableInput, config: { webhookUrl: 'https://x' } });

      expect(db.householdPlugin.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ config: { webhookUrl: 'https://x' } }),
      });

      const events = emittedEvents();
      expect(events).toHaveLength(2);
      expect(events[0].event).toBeInstanceOf(HouseholdPluginEnabledEvent);
      expect(events[1].event).toBeInstanceOf(HouseholdPluginConfigUpdatedEvent);
      // The before is the `{}` column default the row was born from.
      expect(events[1].event.before.config).toEqual({});
      expect(events[1].event.after.config).toEqual({ webhookUrl: 'https://x' });
    });

    it('rejects schema-invalid inline config with the validator issues, before any transaction', async () => {
      await expect(service.enableHousehold({ ...enableInput, config: { webhookUrl: 42 } })).rejects.toMatchObject({
        constructor: PluginConfigValidationError,
        issues: [expect.objectContaining({ path: '/webhookUrl' })],
      });

      expect(db.$transaction).not.toHaveBeenCalled();
    });

    it('refuses a first enable without config when the manifest requires household config (empty issues)', async () => {
      const requiring = householdManifest({
        schema: { type: 'object', properties: { webhookUrl: { type: 'string' } }, required: ['webhookUrl'] },
        requiresHouseholdConfig: true,
      });
      db.plugin.findUnique.mockResolvedValue(makePlugin({ manifestJson: requiring as unknown as Prisma.JsonValue }));
      db.householdPlugin.findUnique.mockResolvedValue(null);

      await expect(service.enableHousehold(enableInput)).rejects.toMatchObject({
        constructor: PluginUnitConfigRequiredError,
        issues: [],
      });
      expect(db.householdPlugin.create).not.toHaveBeenCalled();
    });

    it('refuses an enable whose RETAINED config no longer satisfies the active schema, naming the violations', async () => {
      const requiring = householdManifest({
        schema: { type: 'object', properties: { webhookUrl: { type: 'string' } }, required: ['webhookUrl'] },
        requiresHouseholdConfig: true,
      });
      db.plugin.findUnique.mockResolvedValue(makePlugin({ manifestJson: requiring as unknown as Prisma.JsonValue }));
      db.householdPlugin.findUnique.mockResolvedValue(makeHouseholdRow({ enabled: false, config: {} }));

      await expect(service.enableHousehold(enableInput)).rejects.toMatchObject({
        constructor: PluginUnitConfigRequiredError,
        issues: [expect.objectContaining({ keyword: 'required' })],
      });
      expect(db.householdPlugin.update).not.toHaveBeenCalled();
    });

    it('idempotency outranks the gate: an ALREADY-ENABLED unit with stale retained config returns unchanged', async () => {
      // The gate guards the transition INTO service; a retry of a
      // previously successful enable must not 409 a unit that never left.
      const requiring = householdManifest({
        schema: { type: 'object', properties: { webhookUrl: { type: 'string' } }, required: ['webhookUrl'] },
        requiresHouseholdConfig: true,
      });
      db.plugin.findUnique.mockResolvedValue(makePlugin({ manifestJson: requiring as unknown as Prisma.JsonValue }));
      const enabled = makeHouseholdRow({ enabled: true, config: {} });
      db.householdPlugin.findUnique.mockResolvedValue(enabled);

      await expect(service.enableHousehold(enableInput)).resolves.toBe(enabled);
      expect(db.householdPlugin.update).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('enables over a retained config that still satisfies the required schema', async () => {
      const requiring = householdManifest({
        schema: { type: 'object', properties: { webhookUrl: { type: 'string' } }, required: ['webhookUrl'] },
        requiresHouseholdConfig: true,
      });
      db.plugin.findUnique.mockResolvedValue(makePlugin({ manifestJson: requiring as unknown as Prisma.JsonValue }));
      const retained = makeHouseholdRow({ enabled: false, config: { webhookUrl: 'https://x' } });
      db.householdPlugin.findUnique.mockResolvedValue(retained);
      db.householdPlugin.update.mockResolvedValue({ ...retained, enabled: true });

      const row = await service.enableHousehold(enableInput);

      expect(row.enabled).toBe(true);
    });

    it('flips an existing disabled row without touching consent state, and the event carries the real before', async () => {
      const before = makeHouseholdRow({ enabled: false });
      db.householdPlugin.findUnique.mockResolvedValue(before);
      db.householdPlugin.update.mockResolvedValue({ ...before, enabled: true });

      await service.enableHousehold(enableInput);

      // `suspendedForConsent` is system state — the admin's switch write
      // must not reference it at all.
      expect(db.householdPlugin.update).toHaveBeenCalledWith({ where: { id: 'hp-1' }, data: { enabled: true } });

      const [{ event }] = emittedEvents();
      expect(event).toBeInstanceOf(HouseholdPluginEnabledEvent);
      expect(event.before.enabled).toBe(false);
    });

    it('a suspended unit stays suspended across an enable flip — late acceptance, not the admin, clears it', async () => {
      const before = makeHouseholdRow({ enabled: false, suspendedForConsent: true, suspendedAt: new Date(1) });
      db.householdPlugin.findUnique.mockResolvedValue(before);
      db.householdPlugin.update.mockResolvedValue({ ...before, enabled: true });

      const row = await service.enableHousehold(enableInput);

      expect(row.suspendedForConsent).toBe(true);
      const [{ event }] = emittedEvents();
      expect(event.after.suspendedForConsent).toBe(true);
    });

    it('re-enabling an already-enabled row without config is a no-op: no write, no event', async () => {
      db.householdPlugin.findUnique.mockResolvedValue(makeHouseholdRow());

      await service.enableHousehold(enableInput);

      expect(db.householdPlugin.update).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('enable with config on an already-enabled row writes the config and emits ONLY the config event', async () => {
      const before = makeHouseholdRow();
      db.householdPlugin.findUnique.mockResolvedValue(before);
      db.householdPlugin.update.mockResolvedValue({ ...before, config: { webhookUrl: 'https://y' } });

      await service.enableHousehold({ ...enableInput, config: { webhookUrl: 'https://y' } });

      expect(db.householdPlugin.update).toHaveBeenCalledWith({
        where: { id: 'hp-1' },
        data: { config: { webhookUrl: 'https://y' } },
      });
      const events = emittedEvents();
      expect(events).toHaveLength(1);
      expect(events[0].event).toBeInstanceOf(HouseholdPluginConfigUpdatedEvent);
    });

    /**
     * The short-circuit above it exists because "an enable that changes nothing
     * must return the unchanged row". A DORMANT row makes that premise false:
     * dormancy is written without touching `enabled`, so the row reads as
     * enabled while serving nothing, and answering 200-unchanged would leave the
     * admin's obvious next move — press Enable again — doing nothing forever.
     */
    it('re-runs the gate for an ENABLED but dormant row, healing it from the retained document', async () => {
      const requiring = householdManifest({
        schema: { type: 'object', properties: { webhookUrl: { type: 'string' } }, required: ['webhookUrl'] },
        requiresHouseholdConfig: true,
      });
      db.plugin.findUnique.mockResolvedValue(makePlugin({ manifestJson: requiring as unknown as Prisma.JsonValue }));
      const dormant = makeHouseholdRow({
        enabled: true,
        config: { webhookUrl: 'https://retained' },
        dormantReason: PluginUnitDormantReason.NeedsConfiguration,
        dormantAt: new Date(0),
      });
      db.householdPlugin.findUnique.mockResolvedValue(dormant);
      db.householdPlugin.update.mockResolvedValue({ ...dormant, dormantReason: null, dormantAt: null });

      const row = await service.enableHousehold(enableInput);

      expect(row.dormantReason).toBeNull();
      // `enabled` is absent from the write: it was already true, and the only
      // thing this enable had to change was the dormancy.
      expect(db.householdPlugin.update).toHaveBeenCalledWith({
        where: { id: 'hp-1' },
        data: { dormantReason: null, dormantAt: null },
      });
    });

    it('refuses that same enable with the retained violations when the document still does not conform', async () => {
      const requiring = householdManifest({
        schema: { type: 'object', properties: { webhookUrl: { type: 'string' } }, required: ['webhookUrl'] },
        requiresHouseholdConfig: true,
      });
      db.plugin.findUnique.mockResolvedValue(makePlugin({ manifestJson: requiring as unknown as Prisma.JsonValue }));
      db.householdPlugin.findUnique.mockResolvedValue(
        makeHouseholdRow({
          enabled: true,
          config: {},
          dormantReason: PluginUnitDormantReason.NeedsConfiguration,
          dormantAt: new Date(0),
        }),
      );

      // Actionable, where the short-circuit answered 200 and explained nothing.
      await expect(service.enableHousehold(enableInput)).rejects.toMatchObject({
        constructor: PluginUnitConfigRequiredError,
        issues: [expect.objectContaining({ keyword: 'required' })],
      });
      expect(db.householdPlugin.update).not.toHaveBeenCalled();
    });

    /**
     * The gate's second trigger. `requiresHouseholdConfig` is the manifest
     * demanding a document at all; it does not decide whether the schema binds
     * one the row already holds. A later manifest can make household config
     * optional while the row still carries the document that condemned it — and
     * the write this enable performs is what CURES a config dormancy, so without
     * the dormancy arm of the condition it would clear the reason without ever
     * re-judging the document and put it straight back into service.
     */
    it('still judges the retained document for a dormant row when the manifest no longer requires config', async () => {
      const optional = householdManifest({
        schema: { type: 'object', properties: { webhookUrl: { type: 'string' } }, required: ['webhookUrl'] },
        requiresHouseholdConfig: false,
      });
      db.plugin.findUnique.mockResolvedValue(makePlugin({ manifestJson: optional as unknown as Prisma.JsonValue }));
      db.householdPlugin.findUnique.mockResolvedValue(
        makeHouseholdRow({
          enabled: true,
          config: {},
          dormantReason: PluginUnitDormantReason.NeedsConfiguration,
          dormantAt: new Date(0),
        }),
      );

      await expect(service.enableHousehold(enableInput)).rejects.toMatchObject({
        constructor: PluginUnitConfigRequiredError,
        issues: [expect.objectContaining({ keyword: 'required' })],
      });
      expect(db.householdPlugin.update).not.toHaveBeenCalled();
    });

    it('heals that same row from a conforming retained document under the optional-config manifest', async () => {
      const optional = householdManifest({
        schema: { type: 'object', properties: { webhookUrl: { type: 'string' } }, required: ['webhookUrl'] },
        requiresHouseholdConfig: false,
      });
      db.plugin.findUnique.mockResolvedValue(makePlugin({ manifestJson: optional as unknown as Prisma.JsonValue }));
      const dormant = makeHouseholdRow({
        enabled: true,
        config: { webhookUrl: 'https://retained' },
        dormantReason: PluginUnitDormantReason.NeedsConfiguration,
        dormantAt: new Date(0),
      });
      db.householdPlugin.findUnique.mockResolvedValue(dormant);
      db.householdPlugin.update.mockResolvedValue({ ...dormant, dormantReason: null, dormantAt: null });

      expect((await service.enableHousehold(enableInput)).dormantReason).toBeNull();
    });

    it('leaves an ordinary enable ungated: optional config, no dormancy, and a document nothing ever judged', async () => {
      const optional = householdManifest({
        schema: { type: 'object', properties: { webhookUrl: { type: 'string' } }, required: ['webhookUrl'] },
        requiresHouseholdConfig: false,
      });
      db.plugin.findUnique.mockResolvedValue(makePlugin({ manifestJson: optional as unknown as Prisma.JsonValue }));
      const before = makeHouseholdRow({ enabled: false, config: {} });
      db.householdPlugin.findUnique.mockResolvedValue(before);
      db.householdPlugin.update.mockResolvedValue({ ...before, enabled: true });

      await service.enableHousehold(enableInput);

      // The widened gate must not start refusing this: an optional-config
      // manifest never demanded a document here, and no reconciliation ever
      // condemned the one the row holds.
      expect(db.householdPlugin.update).toHaveBeenCalledWith({ where: { id: 'hp-1' }, data: { enabled: true } });
    });

    it('clears a config dormancy when the enable supplies a conforming document (#370)', async () => {
      const before = makeHouseholdRow({
        enabled: false,
        config: { webhookUrl: 42 },
        dormantReason: PluginUnitDormantReason.NeedsConfiguration,
        dormantAt: new Date(0),
      });
      db.householdPlugin.findUnique.mockResolvedValue(before);
      db.householdPlugin.update.mockResolvedValue({ ...before, enabled: true, dormantReason: null, dormantAt: null });

      await service.enableHousehold({ ...enableInput, config: { webhookUrl: 'https://z' } });

      expect(db.householdPlugin.update).toHaveBeenCalledWith({
        where: { id: 'hp-1' },
        data: { enabled: true, config: { webhookUrl: 'https://z' }, dormantReason: null, dormantAt: null },
      });
    });

    it('refuses the household surface for a server-scope plugin — the scope-coherence rule at the writer', async () => {
      db.plugin.findUnique.mockResolvedValue(makePlugin({ scope: PluginScope.Server }));

      await expect(service.enableHousehold(enableInput)).rejects.toBeInstanceOf(PluginUnitScopeError);
    });

    it('refuses a non-admin of the anchoring household', async () => {
      authority.isHouseholdAdmin.mockResolvedValue(false);

      await expect(service.enableHousehold(enableInput)).rejects.toBeInstanceOf(PluginUnitAuthorityError);
      expect(db.$transaction).not.toHaveBeenCalled();
    });

    it('404s an unknown slug and 410s a tombstone', async () => {
      db.plugin.findUnique.mockResolvedValue(null);
      await expect(service.enableHousehold(enableInput)).rejects.toBeInstanceOf(PluginUnitPluginNotFoundError);

      db.plugin.findUnique.mockResolvedValue(makePlugin({ uninstalledAt: new Date(5) }));
      await expect(service.enableHousehold(enableInput)).rejects.toBeInstanceOf(PluginUnitPluginTombstonedError);
    });
  });

  describe('disableHousehold', () => {
    it('flips the switch and emits the disabled event', async () => {
      const before = makeHouseholdRow();
      db.householdPlugin.findUnique.mockResolvedValue(before);
      db.householdPlugin.update.mockResolvedValue({ ...before, enabled: false });

      const row = await service.disableHousehold(enableInput);

      expect(row.enabled).toBe(false);
      expect(db.householdPlugin.update).toHaveBeenCalledWith({ where: { id: 'hp-1' }, data: { enabled: false } });
      const [{ name, event }] = emittedEvents();
      expect(name).toBe(PluginEvent.Disabled);
      expect(event).toBeInstanceOf(HouseholdPluginDisabledEvent);
    });

    it('is idempotent on an already-disabled row: no write, no event', async () => {
      db.householdPlugin.findUnique.mockResolvedValue(makeHouseholdRow({ enabled: false }));

      await service.disableHousehold(enableInput);

      expect(db.householdPlugin.update).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('404s a household that never enabled the plugin — enable is the row creator', async () => {
      db.householdPlugin.findUnique.mockResolvedValue(null);

      await expect(service.disableHousehold(enableInput)).rejects.toBeInstanceOf(PluginUnitNotEnrolledError);
    });

    /**
     * D-CL. The row is dormant, on the household admin's screen with a reason
     * attached (#354's list), and disable is the only operation that could act
     * on it — so this path does not require the household surface the other two
     * writers do.
     */
    it('switches off a row the plugin scope no longer admits, where enable and config PATCH refuse', async () => {
      db.plugin.findUnique.mockResolvedValue(makePlugin({ scope: PluginScope.Server }));
      db.$queryRaw.mockResolvedValue([
        { uninstalled_at: null, scope: PluginScope.Server, version: '1.2.0', installed_at: new Date(0) },
      ] as never);
      const before = makeHouseholdRow({ dormantReason: PluginUnitDormantReason.ScopeOrphaned });
      db.householdPlugin.findUnique.mockResolvedValue(before);
      db.householdPlugin.update.mockResolvedValue({ ...before, enabled: false });

      const row = await service.disableHousehold(enableInput);

      expect(row.enabled).toBe(false);
      // The dormancy is NOT cleared by switching the row off: the two are
      // independent, and a re-scope back must restore the admin's own intent
      // rather than one this path invented.
      expect(db.householdPlugin.update).toHaveBeenCalledWith({ where: { id: 'hp-1' }, data: { enabled: false } });

      await expect(service.enableHousehold(enableInput)).rejects.toBeInstanceOf(PluginUnitScopeError);
      await expect(
        service.updateHouseholdConfig({ ...enableInput, config: { webhookUrl: 'https://z' } }),
      ).rejects.toBeInstanceOf(PluginUnitScopeError);
    });
  });

  describe('updateHouseholdConfig', () => {
    it('validates against the active schema, writes last-writer-wins, and emits the config event', async () => {
      const before = makeHouseholdRow();
      db.householdPlugin.findUnique.mockResolvedValue(before);
      db.householdPlugin.update.mockResolvedValue({ ...before, config: { webhookUrl: 'https://z' } });

      await service.updateHouseholdConfig({ ...enableInput, config: { webhookUrl: 'https://z' } });

      expect(db.householdPlugin.update).toHaveBeenCalledWith({
        where: { id: 'hp-1' },
        data: { config: { webhookUrl: 'https://z' } },
      });
      const [{ name, event }] = emittedEvents();
      expect(name).toBe(PluginEvent.ConfigUpdated);
      expect(event).toBeInstanceOf(HouseholdPluginConfigUpdatedEvent);
    });

    it('clears a config dormancy — the document that caused it has just been replaced (#370)', async () => {
      const before = makeHouseholdRow({
        config: { webhookUrl: 42 },
        dormantReason: PluginUnitDormantReason.NeedsConfiguration,
        dormantAt: new Date(0),
      });
      db.householdPlugin.findUnique.mockResolvedValue(before);
      db.householdPlugin.update.mockResolvedValue({
        ...before,
        config: { webhookUrl: 'https://z' },
        dormantReason: null,
        dormantAt: null,
      });

      await service.updateHouseholdConfig({ ...enableInput, config: { webhookUrl: 'https://z' } });

      expect(db.householdPlugin.update).toHaveBeenCalledWith({
        where: { id: 'hp-1' },
        data: { config: { webhookUrl: 'https://z' }, dormantReason: null, dormantAt: null },
      });
    });

    it('leaves the dormancy fields out of an ordinary write entirely', async () => {
      const before = makeHouseholdRow();
      db.householdPlugin.findUnique.mockResolvedValue(before);
      db.householdPlugin.update.mockResolvedValue({ ...before, config: { webhookUrl: 'https://z' } });

      await service.updateHouseholdConfig({ ...enableInput, config: { webhookUrl: 'https://z' } });

      expect(db.householdPlugin.update).toHaveBeenCalledWith({
        where: { id: 'hp-1' },
        data: { config: { webhookUrl: 'https://z' } },
      });
    });

    it('rejects a schema violation with issues[] before any transaction', async () => {
      await expect(
        service.updateHouseholdConfig({ ...enableInput, config: { webhookUrl: 42 } }),
      ).rejects.toBeInstanceOf(PluginConfigValidationError);
      expect(db.$transaction).not.toHaveBeenCalled();
    });

    it('404s a household that never enabled the plugin', async () => {
      db.householdPlugin.findUnique.mockResolvedValue(null);

      await expect(
        service.updateHouseholdConfig({ ...enableInput, config: { webhookUrl: 'https://z' } }),
      ).rejects.toBeInstanceOf(PluginUnitNotEnrolledError);
    });
  });

  describe('user enable/disable', () => {
    const userInput = { slug: 'demo-sink', userId: 'user-1' };

    it('re-enables the anchor under the user advisory lock and emits the user enabled event', async () => {
      const before = makeUserRow({ enabled: false });
      db.userPlugin.findUnique.mockResolvedValue(before);
      db.userPlugin.update.mockResolvedValue({ ...before, enabled: true });

      const row = await service.enableUser(userInput);

      expect(row.enabled).toBe(true);
      const [strings, ...values] = db.$executeRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
      expect(strings.join('?')).toContain('pg_advisory_xact_lock(hashtextextended(');
      expect(values).toContain('plugin_grant:user_unit:user-1:plugin-1');

      const [{ name, event }] = emittedEvents();
      expect(name).toBe(PluginEvent.Enabled);
      expect(event).toBeInstanceOf(UserPluginEnabledEvent);
    });

    it('disables without touching consent state and emits the user disabled event', async () => {
      const before = makeUserRow({ suspendedForConsent: true, suspendedAt: new Date(1) });
      db.userPlugin.findUnique.mockResolvedValue(before);
      db.userPlugin.update.mockResolvedValue({ ...before, enabled: false });

      const row = await service.disableUser(userInput);

      expect(db.userPlugin.update).toHaveBeenCalledWith({ where: { id: 'up-1' }, data: { enabled: false } });
      expect(row.suspendedForConsent).toBe(true);
      const [{ event }] = emittedEvents();
      expect(event).toBeInstanceOf(UserPluginDisabledEvent);
    });

    it('is idempotent: a matching state returns unchanged with no write, no event', async () => {
      db.userPlugin.findUnique.mockResolvedValue(makeUserRow());

      await service.enableUser(userInput);

      expect(db.userPlugin.update).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('404s without an anchor row — decide() remains the only creator (#225)', async () => {
      db.userPlugin.findUnique.mockResolvedValue(null);

      await expect(service.enableUser(userInput)).rejects.toBeInstanceOf(PluginUnitNotEnrolledError);
      await expect(service.disableUser(userInput)).rejects.toBeInstanceOf(PluginUnitNotEnrolledError);
    });

    it('410s a tombstoned plugin, both before the transaction and on the in-transaction re-read', async () => {
      db.plugin.findUnique.mockResolvedValue(makePlugin({ uninstalledAt: new Date(5) }));
      await expect(service.enableUser(userInput)).rejects.toBeInstanceOf(PluginUnitPluginTombstonedError);

      db.plugin.findUnique.mockResolvedValue(makePlugin());
      db.$queryRaw.mockResolvedValue([
        { uninstalled_at: new Date(6), scope: PluginScope.Household, version: '1.2.0', installed_at: new Date(0) },
      ] as never);
      await expect(service.enableUser(userInput)).rejects.toBeInstanceOf(PluginUnitPluginTombstonedError);
    });
  });
});
