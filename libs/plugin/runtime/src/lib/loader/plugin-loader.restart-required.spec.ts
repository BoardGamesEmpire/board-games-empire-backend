import { PluginActorScope, SystemActorScope } from '@bge/actor-context';
import { DatabaseService, PluginCategory, PluginScope, type Plugin } from '@bge/database';
import { createMockDatabaseService, type MockDatabaseService } from '@bge/testing';
import type { InstalledPluginDirectory, PluginContext } from '@boardgamesempire/plugin-contract';
import type { PluginManifest } from '@boardgamesempire/plugin-manifest';
import { validatePluginManifest } from '@boardgamesempire/plugin-manifest';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginConfigService } from '../config/plugin-config.service';
import { PluginContextFactory } from '../context/plugin-context.factory';
import { PluginLoadFailedEvent } from '../events/plugin.events';
import type { PluginModuleOptions } from '../plugin-module.options';
import { PluginDirectoryResolverService } from './plugin-directory-resolver.service';
import { PluginInstanceRegistry } from './plugin-instance-registry';
import { PluginLoaderService } from './plugin-loader.service';
import type { PluginModuleImporter } from './plugin-module-importer';

jest.mock('@boardgamesempire/plugin-manifest', () => ({
  validatePluginManifest: jest.fn(),
  PLUGIN_SLUG_PATTERN: /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/,
}));

/**
 * The C3 loader deltas (#59): D-AT `restartRequired` clearing on the boot
 * that loads the activated version, the advisory disk-version comparison
 * behind it, and the D-AS tombstone predicate on the boot query. The
 * broader load/quarantine matrix lives in `plugin-loader.service.spec.ts`.
 */
describe('PluginLoaderService — restart-required and tombstones', () => {
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
  let registry: PluginInstanceRegistry;
  let emitter: jest.Mocked<Pick<EventEmitter2, 'emit'>>;
  let loader: PluginLoaderService;

  const context: PluginContext = {} as PluginContext;
  const validateMock = validatePluginManifest as jest.MockedFunction<typeof validatePluginManifest>;

  const makePluginRow = (overrides: Partial<Plugin> = {}): Plugin =>
    ({
      id: 'plugin-1',
      slug: 'demo-sink',
      version: '1.3.0',
      category: PluginCategory.FeedbackSink,
      scope: PluginScope.Server,
      enabled: true,
      bundled: false,
      manifestJson: { slug: 'demo-sink' },
      config: {},
      loadFailed: false,
      loadError: null,
      restartRequired: false,
      uninstalledAt: null,
      ...overrides,
    }) as Plugin;

  const scaffoldDirectory = async (slug: string, diskVersion: string | null): Promise<InstalledPluginDirectory> => {
    const rootDir = join(workDir, slug);
    await mkdir(join(rootDir, 'dist'), { recursive: true });
    await writeFile(join(rootDir, 'package.json'), JSON.stringify({ exports: './dist/index.js' }));
    await writeFile(
      join(rootDir, 'manifest.json'),
      diskVersion === null ? 'not json' : JSON.stringify({ slug, version: diskVersion }),
    );
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
    workDir = await realpath(await mkdtemp(join(tmpdir(), 'bge-loader-c3-')));
    db = createMockDatabaseService();
    db.plugin.update.mockResolvedValue(makePluginRow());
    directories = { resolve: jest.fn() } as unknown as jest.Mocked<Pick<PluginDirectoryResolverService, 'resolve'>>;
    importer = { importModule: jest.fn().mockResolvedValue({ default: () => ({}) }) };
    registry = new PluginInstanceRegistry();
    emitter = { emit: jest.fn() } as unknown as jest.Mocked<Pick<EventEmitter2, 'emit'>>;
    validateMock.mockReturnValue({
      manifest,
      permissionChecks: [],
      declaredPermissions: [],
      externalPermissionChecks: [],
      warnings: [],
    });

    const contextFactory = { create: jest.fn().mockReturnValue(context) };
    const configService = { prime: jest.fn(), evict: jest.fn() };
    const systemActorScope = { run: jest.fn(<T>(_reason: string, fn: () => T): T => fn()) };
    const pluginActorScope = {
      run: jest.fn(<T>(_pluginId: string, _unit: unknown, _reason: string, fn: () => T): T => fn()),
    };

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

  it('queries only enabled, non-tombstoned rows (D-AS predicate)', async () => {
    db.plugin.findMany.mockResolvedValue([]);

    await loader.loadAllEnabled();

    expect(db.plugin.findMany).toHaveBeenCalledWith({ where: { enabled: true, uninstalledAt: null } });
  });

  it('clears restartRequired on the boot that loads the matching disk version (D-AT)', async () => {
    const plugin = makePluginRow({ restartRequired: true });
    db.plugin.findMany.mockResolvedValue([plugin]);
    directories.resolve.mockResolvedValue(await scaffoldDirectory('demo-sink', '1.3.0'));

    await loader.loadAllEnabled();

    expect(registry.has('demo-sink')).toBe(true);
    expect(db.plugin.update).toHaveBeenCalledWith({
      where: { id: 'plugin-1' },
      data: { restartRequired: false },
    });
  });

  it('clears restartRequired and stale quarantine flags in ONE recovery write', async () => {
    const plugin = makePluginRow({ restartRequired: true, loadFailed: true, loadError: 'old failure' });
    db.plugin.findMany.mockResolvedValue([plugin]);
    directories.resolve.mockResolvedValue(await scaffoldDirectory('demo-sink', '1.3.0'));

    await loader.loadAllEnabled();

    expect(db.plugin.update).toHaveBeenCalledTimes(1);
    expect(db.plugin.update).toHaveBeenCalledWith({
      where: { id: 'plugin-1' },
      data: { loadFailed: false, loadError: null, restartRequired: false },
    });
  });

  it('writes nothing after a clean load with neither flag set', async () => {
    db.plugin.findMany.mockResolvedValue([makePluginRow()]);
    directories.resolve.mockResolvedValue(await scaffoldDirectory('demo-sink', '1.3.0'));

    await loader.loadAllEnabled();

    expect(registry.has('demo-sink')).toBe(true);
    expect(db.plugin.update).not.toHaveBeenCalled();
  });

  /**
   * A version mismatch is advisory. The directory resolver exposes ONE path
   * per plugin, so a staged-but-unapproved update's files legitimately sit
   * there while the row still names the active version — quarantining would
   * force-disable a healthy plugin awaiting consent, and for a bundled
   * plugin (whose path is BGE's own) it would be unavoidable.
   */
  describe('on-disk version mismatch is advisory, never a quarantine', () => {
    it('loads the plugin and LEAVES restartRequired set when the disk holds another version', async () => {
      db.plugin.findMany.mockResolvedValue([makePluginRow({ restartRequired: true })]);
      directories.resolve.mockResolvedValue(await scaffoldDirectory('demo-sink', '1.2.0'));

      await loader.loadAllEnabled();

      expect(registry.isEnabled('demo-sink')).toBe(true);
      expect(importer.importModule).toHaveBeenCalled();
      expect(db.plugin.update).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalledWith(PluginLoadFailedEvent.eventName, expect.anything());
    });

    it('loads the plugin when the on-disk manifest is unreadable, without claiming the restart happened', async () => {
      db.plugin.findMany.mockResolvedValue([makePluginRow({ restartRequired: true })]);
      directories.resolve.mockResolvedValue(await scaffoldDirectory('demo-sink', null));

      await loader.loadAllEnabled();

      expect(registry.isEnabled('demo-sink')).toBe(true);
      expect(db.plugin.update).not.toHaveBeenCalled();
    });

    it('still clears a stale quarantine flag on mismatch — the two flags answer different questions', async () => {
      db.plugin.findMany.mockResolvedValue([
        makePluginRow({ restartRequired: true, loadFailed: true, loadError: 'old failure' }),
      ]);
      directories.resolve.mockResolvedValue(await scaffoldDirectory('demo-sink', '1.2.0'));

      await loader.loadAllEnabled();

      expect(db.plugin.update).toHaveBeenCalledWith({
        where: { id: 'plugin-1' },
        data: { loadFailed: false, loadError: null },
      });
    });

    it('does not touch the row when the disk mismatches and no flag is set', async () => {
      db.plugin.findMany.mockResolvedValue([makePluginRow()]);
      directories.resolve.mockResolvedValue(await scaffoldDirectory('demo-sink', '9.9.9'));

      await loader.loadAllEnabled();

      expect(registry.isEnabled('demo-sink')).toBe(true);
      expect(db.plugin.update).not.toHaveBeenCalled();
    });
  });
});
