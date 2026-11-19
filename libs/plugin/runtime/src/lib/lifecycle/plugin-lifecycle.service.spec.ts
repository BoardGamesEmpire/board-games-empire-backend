import type { Plugin } from '@bge/database';
import { PluginCategory, PluginExecutionMode, PluginScope, Prisma } from '@bge/database';
import type { PluginLoadRecordRow } from '@bge/database/testing';
import { fakePluginLoadRecords } from '@bge/database/testing';
import type { MockDatabaseService } from '@bge/testing';
import { createMockDatabaseService, rawQueryText } from '@bge/testing';
import { PluginEvent } from '@boardgamesempire/plugin-contract';
import { buildPluginManifest } from '@boardgamesempire/plugin-manifest';
import { Logger } from '@nestjs/common';
import { PluginConfigValidationError } from '../config/config-schema.errors';
import { PluginConfigSchemaService } from '../config/plugin-config-schema.service';
import type { PluginDisabledEvent } from '../events/plugin.events';
import { PluginConfigUpdatedEvent, PluginEnabledEvent, PluginUninstalledEvent } from '../events/plugin.events';
import type { PluginGrantAuthorityService } from '../grants/plugin-grant-authority.service';
import type { PluginInstanceRegistry } from '../loader/plugin-instance-registry';
import type { ClaimedPluginRow } from '../manifest/manifest-move';
import { buildPluginModuleOptions } from '../testing/plugin-module-options.fixture';
import {
  PluginLifecycleAuthorityError,
  PluginLifecycleManifestError,
  PluginLifecycleNotFoundError,
  PluginLifecyclePluginChangedError,
  PluginLifecycleTombstonedError,
} from './lifecycle.errors';
import { PluginLifecycleService } from './plugin-lifecycle.service';

describe('PluginLifecycleService', () => {
  const options = buildPluginModuleOptions();

  const activeManifest = buildPluginManifest();

  const makePlugin = (overrides: Partial<Plugin> = {}): Plugin => ({
    id: 'plugin-1',
    slug: 'demo-sink',
    version: '1.2.0',
    category: PluginCategory.FeedbackSink,
    scope: PluginScope.Server,
    executionMode: PluginExecutionMode.InProcess,
    enabled: false,
    manifestJson: activeManifest as unknown as Prisma.JsonValue,
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
    pendingStagingId: null,
    pendingFromUrl: null,
    pendingRegistrySlug: null,
    restartRequired: false,
    uninstalledAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  });

  /**
   * A row of `updateConfig`'s in-transaction claim of the plugin row.
   * `manifest_matches` is the comparison the database performs against the
   * plugin manifest the caller validated; it defaults TRUE because an
   * unmoved plugin manifest is the ordinary case (#578).
   */
  const claimedRow = (
    overrides: Partial<ClaimedPluginRow & { config: Prisma.JsonValue }> = {},
  ): ClaimedPluginRow & { config: Prisma.JsonValue } => ({
    uninstalled_at: null,
    version: '1.2.0',
    installed_at: new Date(0),
    config: {},
    manifest_matches: true,
    ...overrides,
  });

  let db: MockDatabaseService;
  let authority: jest.Mocked<Pick<PluginGrantAuthorityService, 'isServerAdmin'>>;
  let registry: jest.Mocked<Pick<PluginInstanceRegistry, 'has' | 'setEnabled' | 'unregister'>>;
  let emitter: { emit: jest.Mock };
  let service: PluginLifecycleService;

  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  beforeEach(() => {
    db = createMockDatabaseService();
    authority = { isServerAdmin: jest.fn().mockResolvedValue(true) };
    registry = { has: jest.fn().mockReturnValue(true), setEnabled: jest.fn(), unregister: jest.fn() };
    emitter = { emit: jest.fn() };

    service = new PluginLifecycleService(
      db as never,
      authority as unknown as PluginGrantAuthorityService,
      registry as unknown as PluginInstanceRegistry,
      new PluginConfigSchemaService(),
      emitter as never,
      options,
    );

    db.$transaction.mockImplementation((cb) => cb(db));
    db.plugin.updateMany.mockResolvedValue({ count: 1 });
    db.plugin.update.mockResolvedValue(makePlugin());
    db.$queryRaw.mockResolvedValue([claimedRow()] as never);
    db.householdPlugin.findMany.mockResolvedValue([]);
    db.userPlugin.findMany.mockResolvedValue([]);
    db.pluginGrant.deleteMany.mockResolvedValue({ count: 0 });
    db.pluginPermission.deleteMany.mockResolvedValue({ count: 0 });
    db.householdPlugin.deleteMany.mockResolvedValue({ count: 0 });
    db.userPlugin.deleteMany.mockResolvedValue({ count: 0 });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  const emittedEvent = <T>(routingKey: string): T => {
    const call = emitter.emit.mock.calls.find(([key]) => key === routingKey);
    if (!call) {
      throw new Error(`no event emitted on '${routingKey}'`);
    }

    return call[1] as T;
  };

  describe('shared guards', () => {
    it.each(['enable', 'disable', 'uninstall'] as const)('%s requires a server admin', async (method) => {
      authority.isServerAdmin.mockResolvedValue(false);

      await expect(service[method]({ slug: 'demo-sink', actorId: 'intruder' })).rejects.toThrow(
        PluginLifecycleAuthorityError,
      );
      expect(db.plugin.updateMany).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('updateConfig requires a server admin', async () => {
      authority.isServerAdmin.mockResolvedValue(false);

      await expect(service.updateConfig({ slug: 'demo-sink', actorId: 'intruder', config: {} })).rejects.toThrow(
        PluginLifecycleAuthorityError,
      );
    });

    it('rejects an unknown slug', async () => {
      db.plugin.findUnique.mockResolvedValue(null);

      await expect(service.enable({ slug: 'ghost', actorId: 'admin-1' })).rejects.toThrow(PluginLifecycleNotFoundError);
    });

    it.each(['enable', 'disable', 'uninstall'] as const)('%s rejects a tombstoned plugin', async (method) => {
      db.plugin.findUnique.mockResolvedValue(makePlugin({ uninstalledAt: new Date('2026-08-01T00:00:00Z') }));

      await expect(service[method]({ slug: 'demo-sink', actorId: 'admin-1' })).rejects.toThrow(
        PluginLifecycleTombstonedError,
      );
      expect(db.plugin.updateMany).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });
  });

  describe('enable / disable', () => {
    it('enable writes the flag under a not-already-enabled guard and emits PluginEnabledEvent', async () => {
      db.plugin.findUnique.mockResolvedValue(makePlugin({ enabled: false }));
      db.plugin.findUniqueOrThrow.mockResolvedValue(makePlugin({ enabled: true }));

      const result = await service.enable({ slug: 'demo-sink', actorId: 'admin-1' });

      expect(result.enabled).toBe(true);
      expect(db.plugin.updateMany).toHaveBeenCalledWith({
        where: { id: 'plugin-1', enabled: false, uninstalledAt: null },
        data: { enabled: true },
      });

      const event = emittedEvent<PluginEnabledEvent>(PluginEvent.Enabled);
      expect(event).toBeInstanceOf(PluginEnabledEvent);
      expect(event.before.enabled).toBe(false);
      expect(event.after.enabled).toBe(true);
    });

    it('disable writes the flag and emits PluginDisabledEvent', async () => {
      db.plugin.findUnique.mockResolvedValue(makePlugin({ enabled: true }));
      db.plugin.findUniqueOrThrow.mockResolvedValue(makePlugin({ enabled: false }));

      const result = await service.disable({ slug: 'demo-sink', actorId: 'admin-1' });

      expect(result.enabled).toBe(false);
      const event = emittedEvent<PluginDisabledEvent>(PluginEvent.Disabled);
      expect(event.before.enabled).toBe(true);
      expect(event.after.enabled).toBe(false);
    });

    it('enable is idempotent: state already matches → no write, no event', async () => {
      db.plugin.findUnique.mockResolvedValue(makePlugin({ enabled: true }));

      const result = await service.enable({ slug: 'demo-sink', actorId: 'admin-1' });

      expect(result.enabled).toBe(true);
      expect(db.plugin.updateMany).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
      expect(registry.setEnabled).not.toHaveBeenCalled();
    });

    it('flips the in-process registry so serving follows the DB write without a restart', async () => {
      db.plugin.findUnique.mockResolvedValue(makePlugin({ enabled: true }));
      db.plugin.findUniqueOrThrow.mockResolvedValue(makePlugin({ enabled: false }));

      await service.disable({ slug: 'demo-sink', actorId: 'admin-1' });

      expect(registry.setEnabled).toHaveBeenCalledWith('demo-sink', false);
    });

    it('cold enable — the loader never registered the plugin, so serving needs a restart and the row says so', async () => {
      registry.has.mockReturnValue(false);
      db.plugin.findUnique.mockResolvedValue(makePlugin({ enabled: false }));
      db.plugin.findUniqueOrThrow.mockResolvedValue(makePlugin({ enabled: true, restartRequired: true }));

      await expect(service.enable({ slug: 'demo-sink', actorId: 'admin-1' })).resolves.toBeDefined();

      expect(registry.setEnabled).not.toHaveBeenCalled();
      // The DB now says enabled but this process holds no instance — without
      // restartRequired that gap would be invisible to diagnostics. The
      // loader's success path clears it on the boot that loads the plugin.
      expect(db.plugin.updateMany).toHaveBeenCalledWith({
        where: { id: 'plugin-1', enabled: false, uninstalledAt: null },
        data: { enabled: true, restartRequired: true },
      });
    });

    it('a warm enable does not demand a restart — the registry flip serves immediately', async () => {
      db.plugin.findUnique.mockResolvedValue(makePlugin({ enabled: false }));
      db.plugin.findUniqueOrThrow.mockResolvedValue(makePlugin({ enabled: true }));

      await service.enable({ slug: 'demo-sink', actorId: 'admin-1' });

      expect(db.plugin.updateMany).toHaveBeenCalledWith({
        where: { id: 'plugin-1', enabled: false, uninstalledAt: null },
        data: { enabled: true },
      });
    });

    describe('a plugin this process does not load (#1083)', () => {
      const installedAt = new Date('2026-11-01T00:00:00Z');

      // A table that answers the lookup's filter, so the specs assert what a
      // record means rather than the query's shape.
      const loads = fakePluginLoadRecords();
      let apiService: PluginLifecycleService;

      const loadRecord = (overrides: Partial<PluginLoadRecordRow> = {}): PluginLoadRecordRow => ({
        slug: 'demo-gateway',
        processRole: 'coordinator',
        installedAt,
        ready: true,
        heartbeatAt: new Date(),
        ...overrides,
      });

      const gateway = (overrides: Partial<Plugin> = {}): Plugin =>
        makePlugin({ slug: 'demo-gateway', category: PluginCategory.DataGateway, installedAt, ...overrides });

      /** The `data` of the guarded enable write. */
      const enableWrite = () => db.plugin.updateMany.mock.calls[0]?.[0]?.data;

      beforeEach(() => {
        loads.rows = [];
        // The api's categories: every one but data-gateway.
        apiService = new PluginLifecycleService(
          db as never,
          authority as unknown as PluginGrantAuthorityService,
          registry as unknown as PluginInstanceRegistry,
          new PluginConfigSchemaService(),
          emitter as never,
          buildPluginModuleOptions({
            loadCategories: Object.values(PluginCategory).filter((c) => c !== PluginCategory.DataGateway),
          }),
        );
        // This process never registered it; only a load record can say it is loaded.
        registry.has.mockReturnValue(false);
        db.pluginProcessLoad.findFirst.mockImplementation(loads.findFirst as never);
        db.plugin.findUnique.mockResolvedValue(gateway({ enabled: false }));
        db.plugin.findUniqueOrThrow.mockResolvedValue(gateway({ enabled: true }));
      });

      it("enabling a plugin this process doesn't load needs no restart while a live load record names its install (#1083)", async () => {
        loads.rows = [loadRecord()];

        await apiService.enable({ slug: 'demo-gateway', actorId: 'admin-1' });

        expect(enableWrite()).toEqual({ enabled: true });
      });

      it("enabling a plugin this process doesn't load needs one when no record does (#1083)", async () => {
        await apiService.enable({ slug: 'demo-gateway', actorId: 'admin-1' });

        expect(enableWrite()).toEqual({ enabled: true, restartRequired: true });
      });

      it("enabling a plugin this process doesn't load needs one after a reinstall, whatever the old copy's record says (#1083)", async () => {
        loads.rows = [loadRecord({ installedAt: new Date('2026-10-01T00:00:00Z') })];

        await apiService.enable({ slug: 'demo-gateway', actorId: 'admin-1' });

        expect(enableWrite()).toEqual({ enabled: true, restartRequired: true });
      });

      it("enabling a plugin this process doesn't load needs a restart while its only record is of a load that failed (#1083)", async () => {
        loads.rows = [loadRecord({ ready: false })];

        await apiService.enable({ slug: 'demo-gateway', actorId: 'admin-1' });

        expect(enableWrite()).toEqual({ enabled: true, restartRequired: true });
      });

      it("enabling a plugin updated into data-gateway needs a restart while only the api's old record names its install (#1083)", async () => {
        loads.rows = [loadRecord({ processRole: 'api' })];

        await apiService.enable({ slug: 'demo-gateway', actorId: 'admin-1' });

        expect(enableWrite()).toEqual({ enabled: true, restartRequired: true });
      });

      it('a category this process loads still goes by its own memory', async () => {
        // A feedback sink loads in the api; a live record of another api
        // process says nothing about this one.
        const sink = makePlugin({ slug: 'demo-gateway', installedAt, enabled: false });
        db.plugin.findUnique.mockResolvedValue(sink);
        db.plugin.findUniqueOrThrow.mockResolvedValue({ ...sink, enabled: true });
        loads.rows = [loadRecord({ processRole: 'api' })];

        await apiService.enable({ slug: 'demo-gateway', actorId: 'admin-1' });

        expect(enableWrite()).toEqual({ enabled: true, restartRequired: true });
        expect(db.pluginProcessLoad.findFirst).not.toHaveBeenCalled();
      });

      it("disabling a plugin this process doesn't load asks no load record (#1083)", async () => {
        db.plugin.findUnique.mockResolvedValue(gateway({ enabled: true }));
        db.plugin.findUniqueOrThrow.mockResolvedValue(gateway({ enabled: false }));

        await apiService.disable({ slug: 'demo-gateway', actorId: 'admin-1' });

        expect(enableWrite()).toEqual({ enabled: false });
        expect(db.pluginProcessLoad.findFirst).not.toHaveBeenCalled();
      });
    });

    it('a lost write race resolves idempotently — no event from the losing call', async () => {
      db.plugin.findUnique.mockResolvedValue(makePlugin({ enabled: false }));
      db.plugin.updateMany.mockResolvedValue({ count: 0 });

      const result = await service.enable({ slug: 'demo-sink', actorId: 'admin-1' });

      expect(result).toBeDefined();
      expect(emitter.emit).not.toHaveBeenCalled();
    });
  });

  describe('updateConfig', () => {
    // The fixture manifest's config.schema: { type: 'object', properties: { webhookUrl: { type: 'string' } } }.

    it('persists a schema-valid payload and emits PluginConfigUpdatedEvent with both snapshots', async () => {
      db.plugin.findUnique.mockResolvedValue(makePlugin({ config: { webhookUrl: 'https://old.example.test' } }));
      db.$queryRaw.mockResolvedValue([claimedRow({ config: { webhookUrl: 'https://old.example.test' } })] as never);
      db.plugin.update.mockResolvedValue(makePlugin({ config: { webhookUrl: 'https://new.example.test' } }));

      const result = await service.updateConfig({
        slug: 'demo-sink',
        actorId: 'admin-1',
        config: { webhookUrl: 'https://new.example.test' },
      });

      expect(result.config).toEqual({ webhookUrl: 'https://new.example.test' });
      // Last-writer-wins by decision: no version/updatedAt fencing, and no
      // uninstalled-plugin guard either, because the row claim before it has
      // already refused an uninstalled plugin and holds the row (#578).
      expect(db.plugin.update).toHaveBeenCalledWith({
        where: { id: 'plugin-1' },
        data: { config: { webhookUrl: 'https://new.example.test' } },
      });

      const event = emittedEvent<PluginConfigUpdatedEvent>(PluginEvent.ConfigUpdated);
      expect(event).toBeInstanceOf(PluginConfigUpdatedEvent);
      expect(event.before.config).toEqual({ webhookUrl: 'https://old.example.test' });
      expect(event.after.config).toEqual({ webhookUrl: 'https://new.example.test' });
    });

    it('reports the document the claim found as the before-snapshot, not the pre-transaction read (#578)', async () => {
      // A second PATCH queued behind a first: it read the config before the
      // first committed, and its claim then returns what the first wrote. The
      // event has to report the change from that document, or the record
      // skips the first PATCH's write.
      db.plugin.findUnique.mockResolvedValue(makePlugin({ config: { webhookUrl: 'https://x.example.test' } }));
      db.$queryRaw.mockResolvedValue([claimedRow({ config: { webhookUrl: 'https://y.example.test' } })] as never);
      db.plugin.update.mockResolvedValue(makePlugin({ config: { webhookUrl: 'https://z.example.test' } }));

      await service.updateConfig({
        slug: 'demo-sink',
        actorId: 'admin-1',
        config: { webhookUrl: 'https://z.example.test' },
      });

      const event = emittedEvent<PluginConfigUpdatedEvent>(PluginEvent.ConfigUpdated);
      expect(event.before.config).toEqual({ webhookUrl: 'https://y.example.test' });
      expect(event.after.config).toEqual({ webhookUrl: 'https://z.example.test' });
    });

    // Compared with the document the claim read, in the transaction: key
    // order is no change, and the row served is the one read there (#903).
    it('a document equal to the stored one writes nothing and emits nothing (#903)', async () => {
      const stored = { webhookUrl: 'https://same.example.test', retries: 2 };
      db.plugin.findUnique.mockResolvedValue(makePlugin({ config: { webhookUrl: 'https://stale.example.test' } }));
      db.$queryRaw.mockResolvedValue([claimedRow({ config: stored })] as never);
      const current = makePlugin({ config: stored });
      db.plugin.findUniqueOrThrow.mockResolvedValue(current);

      const result = await service.updateConfig({
        slug: 'demo-sink',
        actorId: 'admin-1',
        config: { retries: 2, webhookUrl: 'https://same.example.test' },
      });

      expect(db.plugin.update).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
      expect(result).toBe(current);
      expect(db.plugin.findUniqueOrThrow).toHaveBeenCalledWith({ where: { id: 'plugin-1' } });
    });

    describe('the plugin-row claim (#578)', () => {
      it('claims the plugin row FOR NO KEY UPDATE, comparing the plugin manifest it validated against, before the write', async () => {
        db.plugin.findUnique.mockResolvedValue(makePlugin());

        // A document other than the stored `{}`, which would write nothing (#903).
        await service.updateConfig({ slug: 'demo-sink', actorId: 'admin-1', config: { webhookUrl: 'https://x.test' } });

        const [strings, ...values] = db.$queryRaw.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
        expect(rawQueryText(strings)).toBe(
          'SELECT uninstalled_at, version, installed_at, config, manifest_json = ?::jsonb AS manifest_matches ' +
            'FROM plugins WHERE id = ? FOR NO KEY UPDATE',
        );
        expect(values).toEqual([JSON.stringify(activeManifest), 'plugin-1']);
        expect(db.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(db.plugin.update.mock.invocationCallOrder[0]);
      });

      it('refuses a document validated against a plugin manifest that was replaced at the same version', async () => {
        db.plugin.findUnique.mockResolvedValue(makePlugin());
        db.$queryRaw.mockResolvedValue([claimedRow({ manifest_matches: false })] as never);

        const refusal = await service
          .updateConfig({ slug: 'demo-sink', actorId: 'admin-1', config: {} })
          .catch((err: unknown) => err);

        expect(refusal).toBeInstanceOf(PluginLifecyclePluginChangedError);
        expect((refusal as PluginLifecyclePluginChangedError).kind).toBe('version-activated');
        expect(db.plugin.update).not.toHaveBeenCalled();
        expect(emitter.emit).not.toHaveBeenCalled();
      });

      it('refuses a moved version as an activation, naming both versions', async () => {
        db.plugin.findUnique.mockResolvedValue(makePlugin());
        db.$queryRaw.mockResolvedValue([claimedRow({ version: '1.3.0', manifest_matches: false })] as never);

        const refusal = await service
          .updateConfig({ slug: 'demo-sink', actorId: 'admin-1', config: {} })
          .catch((err: unknown) => err);

        expect(refusal).toBeInstanceOf(PluginLifecyclePluginChangedError);
        expect(refusal).toMatchObject({ kind: 'version-activated', expectedVersion: '1.2.0', actualVersion: '1.3.0' });
        expect(db.plugin.update).not.toHaveBeenCalled();
      });

      it('refuses after a reinstall over an uninstalled plugin as reinstalled', async () => {
        db.plugin.findUnique.mockResolvedValue(makePlugin());
        db.$queryRaw.mockResolvedValue([claimedRow({ installed_at: new Date(1) })] as never);

        const refusal = await service
          .updateConfig({ slug: 'demo-sink', actorId: 'admin-1', config: {} })
          .catch((err: unknown) => err);

        expect(refusal).toBeInstanceOf(PluginLifecyclePluginChangedError);
        expect((refusal as PluginLifecyclePluginChangedError).kind).toBe('reinstalled');
        expect(db.plugin.update).not.toHaveBeenCalled();
      });

      it('refuses a plugin uninstalled after the read with the uninstalled-plugin error', async () => {
        db.plugin.findUnique.mockResolvedValue(makePlugin());
        db.$queryRaw.mockResolvedValue([claimedRow({ uninstalled_at: new Date('2026-08-01T00:00:00Z') })] as never);

        await expect(service.updateConfig({ slug: 'demo-sink', actorId: 'admin-1', config: {} })).rejects.toThrow(
          PluginLifecycleTombstonedError,
        );
        expect(db.plugin.update).not.toHaveBeenCalled();
      });

      it('refuses a plugin whose row vanished after the read as not installed', async () => {
        db.plugin.findUnique.mockResolvedValue(makePlugin());
        db.$queryRaw.mockResolvedValue([] as never);

        await expect(service.updateConfig({ slug: 'demo-sink', actorId: 'admin-1', config: {} })).rejects.toThrow(
          PluginLifecycleNotFoundError,
        );
      });

      it('binds the retry to the plugin manifest now stored and writes against it', async () => {
        const manifestB = { ...activeManifest, version: '1.3.0' };
        const pluginB = makePlugin({ version: '1.3.0', manifestJson: manifestB as unknown as Prisma.JsonValue });

        db.plugin.findUnique.mockResolvedValueOnce(makePlugin()).mockResolvedValueOnce(pluginB);
        db.plugin.update.mockResolvedValue(pluginB);
        db.$queryRaw
          .mockResolvedValueOnce([claimedRow({ manifest_matches: false })] as never)
          .mockResolvedValueOnce([claimedRow({ version: '1.3.0' })] as never);

        await expect(service.updateConfig({ slug: 'demo-sink', actorId: 'admin-1', config: {} })).rejects.toThrow(
          PluginLifecyclePluginChangedError,
        );
        expect(db.plugin.update).not.toHaveBeenCalled();

        await service.updateConfig({ slug: 'demo-sink', actorId: 'admin-1', config: { webhookUrl: 'https://x.test' } });

        expect(db.plugin.update).toHaveBeenCalledTimes(1);
        const [, ...retryValues] = db.$queryRaw.mock.calls[1] as unknown as [TemplateStringsArray, ...unknown[]];
        expect(retryValues).toEqual([JSON.stringify(manifestB), 'plugin-1']);
      });
    });

    it('rejects a schema-violating payload with the collected issues — no write, no event', async () => {
      db.plugin.findUnique.mockResolvedValue(makePlugin());

      await expect(
        service.updateConfig({ slug: 'demo-sink', actorId: 'admin-1', config: { webhookUrl: 42 } }),
      ).rejects.toThrow(PluginConfigValidationError);

      expect(db.plugin.update).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('carries the violations on the error for the 422 body', async () => {
      db.plugin.findUnique.mockResolvedValue(makePlugin());

      try {
        await service.updateConfig({ slug: 'demo-sink', actorId: 'admin-1', config: { webhookUrl: 42 } });
        fail('expected PluginConfigValidationError');
      } catch (err) {
        expect(err).toBeInstanceOf(PluginConfigValidationError);
        expect((err as PluginConfigValidationError).issues).toEqual(
          expect.arrayContaining([expect.objectContaining({ path: '/webhookUrl', keyword: 'type' })]),
        );
      }
    });

    it('treats an unreadable stored manifest as corrupted server state, never a payload problem', async () => {
      db.plugin.findUnique.mockResolvedValue(makePlugin({ manifestJson: { not: 'a manifest' } }));

      await expect(service.updateConfig({ slug: 'demo-sink', actorId: 'admin-1', config: {} })).rejects.toThrow(
        PluginLifecycleManifestError,
      );
      expect(db.plugin.update).not.toHaveBeenCalled();
    });

    it('rejects a tombstoned plugin before validating anything', async () => {
      db.plugin.findUnique.mockResolvedValue(makePlugin({ uninstalledAt: new Date('2026-08-01T00:00:00Z') }));

      await expect(service.updateConfig({ slug: 'demo-sink', actorId: 'admin-1', config: {} })).rejects.toThrow(
        PluginLifecycleTombstonedError,
      );
    });
  });

  describe('uninstall', () => {
    beforeEach(() => {
      db.plugin.findUnique.mockResolvedValue(makePlugin({ enabled: true }));
      db.plugin.findUniqueOrThrow.mockResolvedValue(
        makePlugin({ enabled: false, uninstalledAt: new Date('2026-08-16T00:00:00Z'), restartRequired: true }),
      );
    });

    it('tombstones with force-disable, restartRequired, and the staged update cleared — one guarded write', async () => {
      await service.uninstall({ slug: 'demo-sink', actorId: 'admin-1' });

      expect(db.plugin.updateMany).toHaveBeenCalledWith({
        where: { id: 'plugin-1', uninstalledAt: null },
        data: {
          enabled: false,
          uninstalledAt: expect.any(Date),
          restartRequired: true,
          pendingVersion: null,
          pendingManifestJson: Prisma.DbNull,
          pendingSha256: null,
          pendingSince: null,
          pendingStagingId: null,
          pendingFromUrl: null,
          pendingRegistrySlug: null,
        },
      });
    });

    it('purges every grant (durable denials included) and the declared-permission catalog — reinstall is fresh consent', async () => {
      await service.uninstall({ slug: 'demo-sink', actorId: 'admin-1' });

      expect(db.pluginGrant.deleteMany).toHaveBeenCalledWith({ where: { pluginId: 'plugin-1' } });
      expect(db.pluginPermission.deleteMany).toHaveBeenCalledWith({ where: { pluginId: 'plugin-1' } });
    });

    it("uninstall disables the plugin's DataGateway row and keeps it (#1083)", async () => {
      db.plugin.findUnique.mockResolvedValue(makePlugin({ enabled: true, category: PluginCategory.DataGateway }));
      db.dataGateway.updateMany.mockResolvedValue({ count: 1 });

      await service.uninstall({ slug: 'demo-sink', actorId: 'admin-1' });

      // Only the flag moves: the row keeps its id and everything on it,
      // because the game sources imported through it hang on it.
      expect(db.dataGateway.updateMany).toHaveBeenCalledWith({
        where: { pluginId: 'plugin-1' },
        data: { enabled: false },
      });
      expect(db.dataGateway.delete).not.toHaveBeenCalled();
      expect(db.dataGateway.deleteMany).not.toHaveBeenCalled();
      // Inside the transaction, after the claim: a lost uninstall race moves no row.
      expect(db.plugin.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
        db.dataGateway.updateMany.mock.invocationCallOrder[0],
      );
    });

    it('a concurrent uninstall leaves the DataGateway row alone (#1083)', async () => {
      db.plugin.updateMany.mockResolvedValue({ count: 0 });
      db.plugin.findUnique
        .mockResolvedValueOnce(makePlugin({ enabled: true, category: PluginCategory.DataGateway }))
        .mockResolvedValueOnce(makePlugin({ uninstalledAt: new Date('2026-08-16T01:00:00Z') }));

      await expect(service.uninstall({ slug: 'demo-sink', actorId: 'admin-1' })).rejects.toThrow(
        PluginLifecycleTombstonedError,
      );
      expect(db.dataGateway.updateMany).not.toHaveBeenCalled();
    });

    it('asks the same of a plugin of another category, which has no row to match (#1083)', async () => {
      await service.uninstall({ slug: 'demo-sink', actorId: 'admin-1' });

      expect(db.dataGateway.updateMany).toHaveBeenCalledWith({
        where: { pluginId: 'plugin-1' },
        data: { enabled: false },
      });
    });

    it('retains household/user config rows by default — they are what the tombstone preserves', async () => {
      await service.uninstall({ slug: 'demo-sink', actorId: 'admin-1' });

      expect(db.householdPlugin.deleteMany).not.toHaveBeenCalled();
      expect(db.userPlugin.deleteMany).not.toHaveBeenCalled();
    });

    it('purgeData: true deletes the unit config rows too', async () => {
      await service.uninstall({ slug: 'demo-sink', actorId: 'admin-1', purgeData: true });

      expect(db.householdPlugin.deleteMany).toHaveBeenCalledWith({ where: { pluginId: 'plugin-1' } });
      expect(db.userPlugin.deleteMany).toHaveBeenCalledWith({ where: { pluginId: 'plugin-1' } });
    });

    it('switches every household and user unit enablement off, after reading the affected units, and keeps their configuration (#1328)', async () => {
      await service.uninstall({ slug: 'demo-sink', actorId: 'admin-1' });

      // Only `enabled` moves: each unit keeps its configuration, and a
      // reinstall finds every unit off, so switching on again is a consent
      // act under the new sha.
      expect(db.householdPlugin.updateMany).toHaveBeenCalledWith({
        where: { pluginId: 'plugin-1', enabled: true },
        data: { enabled: false },
      });
      expect(db.userPlugin.updateMany).toHaveBeenCalledWith({
        where: { pluginId: 'plugin-1', enabled: true },
        data: { enabled: false },
      });

      // After both reads: switched off first, the units that were on would
      // be missing from the uninstall event that announces them.
      const lastRead = Math.max(
        db.householdPlugin.findMany.mock.invocationCallOrder[0],
        db.userPlugin.findMany.mock.invocationCallOrder[0],
      );

      expect(lastRead).toBeLessThan(db.householdPlugin.updateMany.mock.invocationCallOrder[0]);
      expect(lastRead).toBeLessThan(db.userPlugin.updateMany.mock.invocationCallOrder[0]);
    });

    it('switches nothing off under purgeData, which deletes the unit enablements (#1328)', async () => {
      await service.uninstall({ slug: 'demo-sink', actorId: 'admin-1', purgeData: true });

      expect(db.householdPlugin.updateMany).not.toHaveBeenCalled();
      expect(db.userPlugin.updateMany).not.toHaveBeenCalled();
    });

    it('snapshots the units AFTER the tombstone claim — a first enable racing this must not be purged unannounced', async () => {
      await service.uninstall({ slug: 'demo-sink', actorId: 'admin-1', purgeData: true });

      // The claim's row lock is what orders a concurrent unit writer (whose
      // path reads the plugin row FOR SHARE) against this snapshot; read
      // before it, a unit committing in that window is purged without ever
      // reaching affectedUnits.
      const claimOrder = db.plugin.updateMany.mock.invocationCallOrder[0];

      expect(claimOrder).toBeLessThan(db.householdPlugin.findMany.mock.invocationCallOrder[0]);
      expect(claimOrder).toBeLessThan(db.userPlugin.findMany.mock.invocationCallOrder[0]);

      // Still before the purge: under purgeData the rows are gone by commit.
      expect(db.householdPlugin.findMany.mock.invocationCallOrder[0]).toBeLessThan(
        db.householdPlugin.deleteMany.mock.invocationCallOrder[0],
      );
      expect(db.userPlugin.findMany.mock.invocationCallOrder[0]).toBeLessThan(
        db.userPlugin.deleteMany.mock.invocationCallOrder[0],
      );
    });

    it('captures the ENABLED units before the purge and carries them on the event and the result', async () => {
      db.householdPlugin.findMany.mockResolvedValue([{ householdId: 'hh_1' }] as never);
      db.userPlugin.findMany.mockResolvedValue([{ userId: 'usr_1' }] as never);

      const result = await service.uninstall({ slug: 'demo-sink', actorId: 'admin-1', purgeData: true });

      expect(db.householdPlugin.findMany).toHaveBeenCalledWith({
        where: { pluginId: 'plugin-1', enabled: true },
        select: { householdId: true },
      });
      expect(db.userPlugin.findMany).toHaveBeenCalledWith({
        where: { pluginId: 'plugin-1', enabled: true },
        select: { userId: true },
      });

      const expectedUnits = [
        { scopeType: 'Household', householdId: 'hh_1' },
        { scopeType: 'User', userId: 'usr_1' },
      ];
      expect(result.affectedUnits).toEqual(expectedUnits);

      const event = emittedEvent<PluginUninstalledEvent>(PluginEvent.Uninstalled);
      expect(event).toBeInstanceOf(PluginUninstalledEvent);
      expect(event.affectedUnits).toEqual(expectedUnits);
      expect(event.before).toEqual({ id: 'plugin-1', slug: 'demo-sink', version: '1.2.0' });
    });

    it('emits only the uninstalled event — the force-disable rides it, not a second disabled event', async () => {
      await service.uninstall({ slug: 'demo-sink', actorId: 'admin-1' });

      expect(emitter.emit).toHaveBeenCalledTimes(1);
      expect(emitter.emit.mock.calls[0][0]).toBe(PluginEvent.Uninstalled);
    });

    it('drops the loaded instance from the in-process registry; a never-loaded plugin is tolerated', async () => {
      await service.uninstall({ slug: 'demo-sink', actorId: 'admin-1' });
      expect(registry.unregister).toHaveBeenCalledWith('demo-sink');

      jest.clearAllMocks();
      db.$transaction.mockImplementation((cb) => cb(db));
      db.plugin.findUnique.mockResolvedValue(makePlugin({ enabled: true }));
      db.plugin.findUniqueOrThrow.mockResolvedValue(makePlugin({ enabled: false, uninstalledAt: new Date() }));
      db.plugin.updateMany.mockResolvedValue({ count: 1 });
      db.householdPlugin.findMany.mockResolvedValue([]);
      db.userPlugin.findMany.mockResolvedValue([]);
      registry.has.mockReturnValue(false);

      await service.uninstall({ slug: 'demo-sink', actorId: 'admin-1' });
      expect(registry.unregister).not.toHaveBeenCalled();
    });

    it('a concurrent uninstall surfaces as the tombstone error, not a partial second purge', async () => {
      db.plugin.updateMany.mockResolvedValue({ count: 0 });
      db.plugin.findUnique
        .mockResolvedValueOnce(makePlugin({ enabled: true }))
        .mockResolvedValueOnce(makePlugin({ uninstalledAt: new Date('2026-08-16T01:00:00Z') }));

      await expect(service.uninstall({ slug: 'demo-sink', actorId: 'admin-1' })).rejects.toThrow(
        PluginLifecycleTombstonedError,
      );
      expect(emitter.emit).not.toHaveBeenCalled();
    });
  });
});
