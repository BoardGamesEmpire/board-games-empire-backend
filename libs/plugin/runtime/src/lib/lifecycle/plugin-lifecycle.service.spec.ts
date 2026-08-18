import { PluginCategory, PluginExecutionMode, PluginScope, Prisma, type Plugin } from '@bge/database';
import { createMockDatabaseService, type MockDatabaseService } from '@bge/testing';
import { PluginEvent } from '@boardgamesempire/plugin-contract';
import { buildPluginManifest } from '@boardgamesempire/plugin-manifest';
import { Logger } from '@nestjs/common';
import { PluginConfigValidationError } from '../config/config-schema.errors';
import { PluginConfigSchemaService } from '../config/plugin-config-schema.service';
import {
  PluginConfigUpdatedEvent,
  PluginDisabledEvent,
  PluginEnabledEvent,
  PluginUninstalledEvent,
} from '../events/plugin.events';
import type { PluginGrantAuthorityService } from '../grants/plugin-grant-authority.service';
import type { PluginInstanceRegistry } from '../loader/plugin-instance-registry';
import type { PluginModuleOptions } from '../plugin-module.options';
import {
  PluginLifecycleAuthorityError,
  PluginLifecycleManifestError,
  PluginLifecycleNotFoundError,
  PluginLifecycleTombstonedError,
  PluginUninstallBundledError,
} from './lifecycle.errors';
import { PluginLifecycleService } from './plugin-lifecycle.service';

describe('PluginLifecycleService', () => {
  const options: PluginModuleOptions = {
    pluginsRoot: '/var/lib/bge/plugins',
    bundledRoot: '/srv/bge/plugins/bundled',
    bgeVersion: '0.3.0',
    defaultLocale: 'en',
  };

  const activeManifest = buildPluginManifest();

  const makePlugin = (overrides: Partial<Plugin> = {}): Plugin => ({
    id: 'plugin-1',
    slug: 'demo-sink',
    version: '1.2.0',
    category: PluginCategory.FeedbackSink,
    scope: PluginScope.Server,
    executionMode: PluginExecutionMode.InProcess,
    enabled: false,
    bundled: false,
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
    restartRequired: false,
    uninstalledAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
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
      db.plugin.findUniqueOrThrow.mockResolvedValue(makePlugin({ config: { webhookUrl: 'https://new.example.test' } }));

      const result = await service.updateConfig({
        slug: 'demo-sink',
        actorId: 'admin-1',
        config: { webhookUrl: 'https://new.example.test' },
      });

      expect(result.config).toEqual({ webhookUrl: 'https://new.example.test' });
      // Last-writer-wins by decision: the only write precondition is the
      // tombstone guard — no version/updatedAt fencing.
      expect(db.plugin.updateMany).toHaveBeenCalledWith({
        where: { id: 'plugin-1', uninstalledAt: null },
        data: { config: { webhookUrl: 'https://new.example.test' } },
      });

      const event = emittedEvent<PluginConfigUpdatedEvent>(PluginEvent.ConfigUpdated);
      expect(event).toBeInstanceOf(PluginConfigUpdatedEvent);
      expect(event.before.config).toEqual({ webhookUrl: 'https://old.example.test' });
      expect(event.after.config).toEqual({ webhookUrl: 'https://new.example.test' });
    });

    it('rejects a schema-violating payload with the collected issues — no write, no event', async () => {
      db.plugin.findUnique.mockResolvedValue(makePlugin());

      await expect(
        service.updateConfig({ slug: 'demo-sink', actorId: 'admin-1', config: { webhookUrl: 42 } }),
      ).rejects.toThrow(PluginConfigValidationError);

      expect(db.plugin.updateMany).not.toHaveBeenCalled();
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
      expect(db.plugin.updateMany).not.toHaveBeenCalled();
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

    it('refuses a bundled plugin — disable is the kill switch, BGE upgrades carry the code', async () => {
      db.plugin.findUnique.mockResolvedValue(makePlugin({ bundled: true }));

      await expect(service.uninstall({ slug: 'demo-sink', actorId: 'admin-1' })).rejects.toThrow(
        PluginUninstallBundledError,
      );
      expect(db.plugin.updateMany).not.toHaveBeenCalled();
      expect(db.pluginGrant.deleteMany).not.toHaveBeenCalled();
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
        },
      });
    });

    it('purges every grant (durable denials included) and the declared-permission catalog — reinstall is fresh consent', async () => {
      await service.uninstall({ slug: 'demo-sink', actorId: 'admin-1' });

      expect(db.pluginGrant.deleteMany).toHaveBeenCalledWith({ where: { pluginId: 'plugin-1' } });
      expect(db.pluginPermission.deleteMany).toHaveBeenCalledWith({ where: { pluginId: 'plugin-1' } });
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
      expect(event.before).toEqual({ id: 'plugin-1', slug: 'demo-sink', version: '1.2.0', bundled: false });
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
