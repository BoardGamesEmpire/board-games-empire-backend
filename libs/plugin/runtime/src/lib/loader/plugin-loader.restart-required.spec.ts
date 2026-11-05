import { PluginActorScope, SystemActorScope } from '@bge/actor-context';
import { DatabaseService, PluginCategory, PluginScope, type Plugin } from '@bge/database';
import { createMockDatabaseService, type MockDatabaseService } from '@bge/testing';
import type { PluginArtifactDirectory, PluginContext } from '@boardgamesempire/plugin-contract';
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
 * The C3 loader deltas (#59): `restartRequired` clearing on the boot
 * that loads the activated version, the advisory disk-version comparison
 * behind it, and the tombstone predicate on the boot query. The
 * broader load/quarantine matrix lives in `plugin-loader.service.spec.ts`.
 */
describe('PluginLoaderService — restart-required and tombstones', () => {
  const manifest = { events: { subscribes: [], emits: [] } } as unknown as PluginManifest;
  const options: PluginModuleOptions = {
    pluginsRoot: '/unused-in-spec/installed',
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
      manifestJson: { slug: 'demo-sink' },
      config: {},
      loadFailed: false,
      loadError: null,
      restartRequired: false,
      uninstalledAt: null,
      ...overrides,
    }) as Plugin;

  const scaffoldDirectory = async (slug: string, diskVersion: string | null): Promise<PluginArtifactDirectory> => {
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
      sha256: 'a'.repeat(64),
      rootDir,
      manifestPath: join(rootDir, 'manifest.json'),
      packageJsonPath: join(rootDir, 'package.json'),
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

  it('queries only enabled, non-tombstoned rows', async () => {
    db.plugin.findMany.mockResolvedValue([]);

    await loader.loadAllEnabled();

    expect(db.plugin.findMany).toHaveBeenCalledWith({ where: { enabled: true, uninstalledAt: null } });
  });

  it('clears restartRequired on the boot that loads the matching disk version', async () => {
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
   * Every plugin artifact has a directory of its own, named by its checksum
   * (#224), so the directory a row's installedSha256 names holds exactly the
   * version the row activated. Another version there is drift — activated in
   * the database with the code never placed, or a directory edited by hand —
   * so the plugin is quarantined before any of its code is imported.
   */
  describe('a disk version that does not match the row quarantines the plugin (#224)', () => {
    const quarantineWrite = () =>
      (db.plugin.update.mock.calls as [{ data: Record<string, unknown> }][]).find(
        ([args]) => args.data['loadFailed'] === true,
      )?.[0];

    it('quarantines when the artifact directory holds another version, without importing it', async () => {
      db.plugin.findMany.mockResolvedValue([makePluginRow({ version: '1.1.0', restartRequired: true })]);
      directories.resolve.mockResolvedValue(await scaffoldDirectory('demo-sink', '1.0.0'));

      await loader.loadAllEnabled();

      expect(importer.importModule).not.toHaveBeenCalled();
      expect(registry.has('demo-sink')).toBe(false);
      expect(quarantineWrite()?.data).toEqual({
        enabled: false,
        loadFailed: true,
        loadError: expect.stringContaining('holds v1.0.0, but its version on record is v1.1.0'),
      });
      expect(emitter.emit).toHaveBeenCalledWith(PluginLoadFailedEvent.eventName, expect.anything());
    });

    it('quarantines when the on-disk manifest is unreadable', async () => {
      db.plugin.findMany.mockResolvedValue([makePluginRow({ restartRequired: true })]);
      directories.resolve.mockResolvedValue(await scaffoldDirectory('demo-sink', null));

      await loader.loadAllEnabled();

      expect(importer.importModule).not.toHaveBeenCalled();
      expect(quarantineWrite()?.data).toEqual({
        enabled: false,
        loadFailed: true,
        loadError: expect.stringContaining('holds a manifest with no readable version'),
      });
    });

    it('quarantines when the on-disk manifest names no version string', async () => {
      db.plugin.findMany.mockResolvedValue([makePluginRow()]);
      const directory = await scaffoldDirectory('demo-sink', '1.3.0');
      await writeFile(directory.manifestPath, JSON.stringify({ slug: 'demo-sink', version: 130 }));
      directories.resolve.mockResolvedValue(directory);

      await loader.loadAllEnabled();

      expect(importer.importModule).not.toHaveBeenCalled();
      expect(quarantineWrite()?.data).toEqual(
        expect.objectContaining({ loadError: expect.stringContaining('holds a manifest with no readable version') }),
      );
    });

    it('quarantines a mismatch even when restartRequired is false', async () => {
      db.plugin.findMany.mockResolvedValue([makePluginRow()]);
      directories.resolve.mockResolvedValue(await scaffoldDirectory('demo-sink', '9.9.9'));

      await loader.loadAllEnabled();

      expect(importer.importModule).not.toHaveBeenCalled();
      expect(registry.has('demo-sink')).toBe(false);
      expect(quarantineWrite()?.data).toEqual(expect.objectContaining({ enabled: false, loadFailed: true }));
    });
  });
});
