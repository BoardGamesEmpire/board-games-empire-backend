import { PluginActorScope, SystemActorScope } from '@bge/actor-context';
import { DatabaseService, PluginCategory, PluginScope, type Plugin } from '@bge/database';
import { createMockDatabaseService, type MockDatabaseService } from '@bge/testing';
import type { PluginManifest } from '@boardgamesempire/plugin-manifest';
import { validatePluginManifest } from '@boardgamesempire/plugin-manifest';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginConfigService } from '../config/plugin-config.service';
import type { PluginContext } from '../context/plugin-context';
import { PluginContextFactory } from '../context/plugin-context.factory';
import { PluginEvent } from '../events/constants';
import { PluginDisabledEvent, PluginLoadFailedEvent } from '../events/plugin.events';
import type { PluginModuleOptions } from '../plugin-module.options';
import type { InstalledPluginDirectory } from './installed-plugin-directory';
import { PluginDirectoryResolverService } from './plugin-directory-resolver.service';
import { PluginInstanceRegistry } from './plugin-instance-registry';
import { PluginLoaderService } from './plugin-loader.service';
import type { PluginModuleImporter } from './plugin-module-importer';

jest.mock('@boardgamesempire/plugin-manifest', () => ({
  validatePluginManifest: jest.fn(),
  PLUGIN_SLUG_PATTERN: /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/,
}));

describe('PluginLoaderService', () => {
  const manifest = { events: { subscribes: [], emits: [] } } as unknown as PluginManifest;
  const options: PluginModuleOptions = {
    pluginsRoot: '/unused-in-spec/installed',
    bundledRoot: '/unused-in-spec/bundled',
    bgeVersion: '0.1.0',
    defaultLocale: 'en',
  };

  let workDir: string;
  let db: MockDatabaseService;
  let directories: jest.Mocked<Pick<PluginDirectoryResolverService, 'resolve'>>;
  let importer: jest.Mocked<PluginModuleImporter>;
  let contextFactory: jest.Mocked<Pick<PluginContextFactory, 'create'>>;
  let registry: PluginInstanceRegistry;
  let configService: jest.Mocked<Pick<PluginConfigService, 'prime' | 'evict'>>;
  let emitter: jest.Mocked<Pick<EventEmitter2, 'emit'>>;
  let systemActorScope: jest.Mocked<Pick<SystemActorScope, 'run'>>;
  let pluginActorScope: jest.Mocked<Pick<PluginActorScope, 'run'>>;
  let loader: PluginLoaderService;

  const context: PluginContext = {} as PluginContext;
  const validateMock = validatePluginManifest as jest.MockedFunction<typeof validatePluginManifest>;

  const makePluginRow = (overrides: Partial<Plugin> = {}): Plugin =>
    ({
      id: 'plugin-1',
      slug: 'demo-sink',
      version: '1.2.3',
      category: PluginCategory.FeedbackSink,
      scope: PluginScope.Server,
      enabled: true,
      bundled: false,
      manifestJson: { slug: 'demo-sink' },
      config: { apiKey: 'k' },
      loadFailed: false,
      loadError: null,
      ...overrides,
    }) as Plugin;

  /** Scaffolds a real on-disk plugin dir so descriptor reading + entrypoint resolution run unmocked. */
  const scaffoldDirectory = async (slug: string): Promise<InstalledPluginDirectory> => {
    const rootDir = join(workDir, slug);
    await mkdir(join(rootDir, 'dist'), { recursive: true });
    await writeFile(join(rootDir, 'package.json'), JSON.stringify({ exports: './dist/index.js' }));
    await writeFile(join(rootDir, 'manifest.json'), '{}');
    await writeFile(join(rootDir, 'dist', 'index.js'), '// entrypoint');

    return {
      slug,
      rootDir,
      manifestPath: join(rootDir, 'manifest.json'),
      packageJsonPath: join(rootDir, 'package.json'),
      bundled: false,
    };
  };

  beforeEach(async () => {
    // realpath so importer-path assertions survive a symlinked tmpdir
    workDir = await realpath(await mkdtemp(join(tmpdir(), 'bge-loader-')));
    db = createMockDatabaseService();
    db.plugin.update.mockResolvedValue(makePluginRow({ enabled: false, loadFailed: true }));
    directories = { resolve: jest.fn() } as unknown as jest.Mocked<Pick<PluginDirectoryResolverService, 'resolve'>>;
    importer = { importModule: jest.fn() };
    contextFactory = { create: jest.fn().mockReturnValue(context) } as unknown as jest.Mocked<
      Pick<PluginContextFactory, 'create'>
    >;
    registry = new PluginInstanceRegistry();
    configService = { prime: jest.fn(), evict: jest.fn() } as unknown as jest.Mocked<
      Pick<PluginConfigService, 'prime' | 'evict'>
    >;
    emitter = { emit: jest.fn() } as unknown as jest.Mocked<Pick<EventEmitter2, 'emit'>>;
    systemActorScope = {
      run: jest.fn(<T>(_reason: string, fn: () => T): T => fn()),
    } as unknown as jest.Mocked<Pick<SystemActorScope, 'run'>>;
    pluginActorScope = {
      run: jest.fn(<T>(_pluginId: string, _reason: string, fn: () => T): T => fn()),
    } as unknown as jest.Mocked<Pick<PluginActorScope, 'run'>>;
    validateMock.mockReturnValue({ manifest, permissionChecks: [], declaredPermissions: [], externalPermissionChecks: [], warnings: [] });

    loader = new PluginLoaderService(
      db as unknown as DatabaseService,
      directories as unknown as PluginDirectoryResolverService,
      importer,
      contextFactory as unknown as PluginContextFactory,
      registry,
      configService as unknown as PluginConfigService,
      emitter as unknown as EventEmitter2,
      systemActorScope as unknown as SystemActorScope,
      pluginActorScope as unknown as PluginActorScope,
      options,
    );
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  describe('happy path', () => {
    it('loads an enabled plugin: validates the manifest, resolves, imports, and registers enabled', async () => {
      const row = makePluginRow();
      const instance = { sink: true };
      const factory = jest.fn().mockReturnValue(instance);
      db.plugin.findMany.mockResolvedValue([row]);
      directories.resolve.mockResolvedValue(await scaffoldDirectory(row.slug));
      importer.importModule.mockResolvedValue({ default: factory });

      await loader.loadAllEnabled();

      expect(db.plugin.findMany).toHaveBeenCalledWith({ where: { enabled: true } });
      expect(validateMock).toHaveBeenCalledWith(row.manifestJson, { bgeVersion: '0.1.0', defaultLocale: 'en' });
      expect(importer.importModule).toHaveBeenCalledWith(join(workDir, row.slug, 'dist', 'index.js'));
      expect(factory).toHaveBeenCalledWith(context);
      expect(registry.isEnabled(row.slug)).toBe(true);
      expect(registry.resolve(row.slug)).toEqual(
        expect.objectContaining({
          pluginId: row.id,
          slug: row.slug,
          category: PluginCategory.FeedbackSink,
          scope: PluginScope.Server,
          manifest,
          instance,
        }),
      );
    });

    it('primes the config snapshot BEFORE invoking the factory', async () => {
      const order: string[] = [];
      const row = makePluginRow();
      db.plugin.findMany.mockResolvedValue([row]);
      directories.resolve.mockResolvedValue(await scaffoldDirectory(row.slug));
      configService.prime.mockImplementation(() => {
        order.push('prime');
      });
      importer.importModule.mockResolvedValue({
        default: jest.fn(() => {
          order.push('factory');
          return {};
        }),
      });

      await loader.loadAllEnabled();

      expect(configService.prime).toHaveBeenCalledWith(row.slug, row.config);
      expect(order).toEqual(['prime', 'factory']);
    });

    it('invokes the factory inside a plugin-actor scope for the plugin being loaded', async () => {
      const row = makePluginRow();
      db.plugin.findMany.mockResolvedValue([row]);
      directories.resolve.mockResolvedValue(await scaffoldDirectory(row.slug));
      importer.importModule.mockResolvedValue({ default: jest.fn().mockReturnValue({}) });

      await loader.loadAllEnabled();

      expect(pluginActorScope.run).toHaveBeenCalledWith(row.id, 'plugin-boot-load', expect.any(Function));
    });

    it('awaits an async factory', async () => {
      const row = makePluginRow();
      const instance = { async: true };
      db.plugin.findMany.mockResolvedValue([row]);
      directories.resolve.mockResolvedValue(await scaffoldDirectory(row.slug));
      importer.importModule.mockResolvedValue({ default: jest.fn().mockResolvedValue(instance) });

      await loader.loadAllEnabled();

      expect(registry.resolve(row.slug).instance).toBe(instance);
    });

    it('forwards the bundled flag to directory resolution', async () => {
      const row = makePluginRow({ slug: 'local-disk', bundled: true });
      db.plugin.findMany.mockResolvedValue([row]);
      directories.resolve.mockResolvedValue(await scaffoldDirectory(row.slug));
      importer.importModule.mockResolvedValue({ default: jest.fn().mockReturnValue({}) });

      await loader.loadAllEnabled();

      expect(directories.resolve).toHaveBeenCalledWith('local-disk', true);
    });

    it('clears stale failure flags when a previously quarantined plugin loads cleanly after re-enable', async () => {
      const row = makePluginRow({ loadFailed: true, loadError: 'old failure' });
      db.plugin.findMany.mockResolvedValue([row]);
      directories.resolve.mockResolvedValue(await scaffoldDirectory(row.slug));
      importer.importModule.mockResolvedValue({ default: jest.fn().mockReturnValue({}) });

      await loader.loadAllEnabled();

      expect(db.plugin.update).toHaveBeenCalledWith({
        where: { id: row.id },
        data: { loadFailed: false, loadError: null },
      });
    });

    it('is idempotent: a second run skips already-registered plugins without re-importing or quarantining', async () => {
      const row = makePluginRow();
      db.plugin.findMany.mockResolvedValue([row]);
      directories.resolve.mockResolvedValue(await scaffoldDirectory(row.slug));
      importer.importModule.mockResolvedValue({ default: jest.fn().mockReturnValue({}) });

      await loader.loadAllEnabled();
      await loader.loadAllEnabled();

      expect(importer.importModule).toHaveBeenCalledTimes(1);
      expect(db.plugin.update).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
      expect(registry.isEnabled(row.slug)).toBe(true);
    });

    it('does not touch the row when a clean plugin loads cleanly', async () => {
      const row = makePluginRow();
      db.plugin.findMany.mockResolvedValue([row]);
      directories.resolve.mockResolvedValue(await scaffoldDirectory(row.slug));
      importer.importModule.mockResolvedValue({ default: jest.fn().mockReturnValue({}) });

      await loader.loadAllEnabled();

      expect(db.plugin.update).not.toHaveBeenCalled();
    });
  });

  describe('quarantine on load failure', () => {
    it('force-disables in the DB, records the error, emits LoadFailed + Disabled, and continues to the next plugin', async () => {
      const broken = makePluginRow({ id: 'plugin-broken', slug: 'broken-sink' });
      const healthy = makePluginRow({ id: 'plugin-ok', slug: 'healthy-sink' });
      db.plugin.findMany.mockResolvedValue([broken, healthy]);
      directories.resolve.mockImplementation(async (slug: string) => scaffoldDirectory(slug));
      importer.importModule.mockImplementation(async (entrypoint: string) => {
        if (entrypoint.includes('broken-sink')) {
          throw new Error('import exploded');
        }

        return { default: jest.fn().mockReturnValue({}) };
      });

      await loader.loadAllEnabled();

      expect(db.plugin.update).toHaveBeenCalledWith({
        where: { id: 'plugin-broken' },
        data: { enabled: false, loadFailed: true, loadError: 'import exploded' },
        select: { id: true, slug: true, enabled: true, loadFailed: true, loadError: true },
      });
      expect(emitter.emit).toHaveBeenCalledWith(PluginEvent.LoadFailed, expect.any(PluginLoadFailedEvent));
      expect(emitter.emit).toHaveBeenCalledWith(PluginEvent.Disabled, expect.any(PluginDisabledEvent));
      expect(registry.has('broken-sink')).toBe(false);
      expect(registry.isEnabled('healthy-sink')).toBe(true);
    });

    it('evicts any primed config snapshot so a quarantined plugin stops serving config', async () => {
      const row = makePluginRow();
      db.plugin.findMany.mockResolvedValue([row]);
      directories.resolve.mockResolvedValue(await scaffoldDirectory(row.slug));
      importer.importModule.mockResolvedValue({
        default: jest.fn(() => {
          throw new Error('factory exploded');
        }),
      });

      await loader.loadAllEnabled();

      expect(configService.prime).toHaveBeenCalledWith(row.slug, row.config);
      expect(configService.evict).toHaveBeenCalledWith(row.slug);
    });

    it('carries the enablement flip in the Disabled event snapshots', async () => {
      const row = makePluginRow();
      db.plugin.findMany.mockResolvedValue([row]);
      directories.resolve.mockRejectedValue(new Error('directory missing'));

      await loader.loadAllEnabled();

      const disabledCall = emitter.emit.mock.calls.find(([name]) => name === PluginEvent.Disabled);
      const event = disabledCall?.[1] as PluginDisabledEvent;

      expect(event.before).toEqual(expect.objectContaining({ enabled: true }));
      expect(event.after).toEqual(expect.objectContaining({ enabled: false }));
    });

    it('quarantines when the stored manifest fails re-validation', async () => {
      const row = makePluginRow();
      db.plugin.findMany.mockResolvedValue([row]);
      validateMock.mockImplementation(() => {
        throw new Error('manifest drifted');
      });

      await loader.loadAllEnabled();

      expect(directories.resolve).not.toHaveBeenCalled();
      expect(db.plugin.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ loadError: 'manifest drifted' }) }),
      );
    });

    it('quarantines a non-object package.json with a plugin-attributed error', async () => {
      const row = makePluginRow();
      db.plugin.findMany.mockResolvedValue([row]);
      const dir = await scaffoldDirectory(row.slug);
      await writeFile(dir.packageJsonPath, JSON.stringify(['not', 'an', 'object']));
      directories.resolve.mockResolvedValue(dir);

      await loader.loadAllEnabled();

      expect(db.plugin.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ loadError: expect.stringContaining('package.json is not a JSON object') }),
        }),
      );
    });

    it('quarantines when the entrypoint escapes the plugin root through a symlink', async () => {
      const row = makePluginRow();
      db.plugin.findMany.mockResolvedValue([row]);
      const dir = await scaffoldDirectory(row.slug);
      // Replace the real dist with a symlink out of the plugin root.
      await rm(join(dir.rootDir, 'dist'), { recursive: true, force: true });
      const outside = join(workDir, 'outside');
      await mkdir(outside, { recursive: true });
      await writeFile(join(outside, 'index.js'), '// smuggled');
      await symlink(outside, join(dir.rootDir, 'dist'));
      directories.resolve.mockResolvedValue(dir);

      await loader.loadAllEnabled();

      expect(importer.importModule).not.toHaveBeenCalled();
      expect(db.plugin.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            loadError: expect.stringContaining('resolves outside the plugin directory'),
          }),
        }),
      );
    });

    it('quarantines when the module has no default-exported factory', async () => {
      const row = makePluginRow();
      db.plugin.findMany.mockResolvedValue([row]);
      directories.resolve.mockResolvedValue(await scaffoldDirectory(row.slug));
      importer.importModule.mockResolvedValue({ notDefault: true });

      await loader.loadAllEnabled();

      expect(db.plugin.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ loadError: expect.stringContaining('default export') }),
        }),
      );
    });

    it('survives a quarantine persistence failure and still loads the remaining plugins', async () => {
      const broken = makePluginRow({ id: 'plugin-broken', slug: 'broken-sink' });
      const healthy = makePluginRow({ id: 'plugin-ok', slug: 'healthy-sink' });
      db.plugin.findMany.mockResolvedValue([broken, healthy]);
      db.plugin.update.mockRejectedValue(new Error('db down'));
      directories.resolve.mockImplementation(async (slug: string) => scaffoldDirectory(slug));
      importer.importModule.mockImplementation(async (entrypoint: string) => {
        if (entrypoint.includes('broken-sink')) {
          throw new Error('import exploded');
        }

        return { default: jest.fn().mockReturnValue({}) };
      });

      await expect(loader.loadAllEnabled()).resolves.toBeUndefined();
      expect(registry.isEnabled('healthy-sink')).toBe(true);
    });
  });

  describe('onApplicationBootstrap', () => {
    it('runs the whole pass inside a named system actor scope', async () => {
      db.plugin.findMany.mockResolvedValue([]);

      await loader.onApplicationBootstrap();

      expect(systemActorScope.run).toHaveBeenCalledWith('plugin-boot-load', expect.any(Function));
      expect(db.plugin.findMany).toHaveBeenCalled();
    });
  });
});
