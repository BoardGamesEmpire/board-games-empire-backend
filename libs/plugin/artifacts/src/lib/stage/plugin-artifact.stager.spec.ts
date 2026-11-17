import type { DatabaseService, Plugin, PluginArtifact } from '@bge/database';
import {
  PluginDirectoryLayoutError,
  PluginDirectoryNotFoundError,
  PluginUpdateAuthorityError,
  PluginUpdateManifestError,
  PluginUpdatePendingConflictError,
  PluginUpdatePluginNotFoundError,
  PluginUpdateStaticAnalysisError,
  PluginUpdateTombstonedError,
  PluginUpdateVersionConflictError,
  type PluginDirectoryResolverService,
  type PluginGrantAuthorityService,
  type PluginUpdateService,
  type PluginUpdateStageResult,
} from '@bge/plugin';
import { buildPluginArtifactSha256, type PluginArtifactDirectory } from '@boardgamesempire/plugin-contract';
import { Logger } from '@nestjs/common';
import { join } from 'node:path';
import { PluginArtifactBelongsToAnotherPluginError, PluginArtifactNotFoundError } from '../artifacts.errors';
import { PLUGIN_ARTIFACT_TTL_MS, type PluginArtifactStore } from '../store/plugin-artifact.store';
import { PluginArtifactStager } from './plugin-artifact.stager';

describe('PluginArtifactStager (#1096)', () => {
  const sha256 = buildPluginArtifactSha256('a');
  const runningSha256 = buildPluginArtifactSha256('9');
  const rootDir = join('/plugins', 'demo-sink', sha256);
  const directory: PluginArtifactDirectory = {
    slug: 'demo-sink',
    sha256,
    rootDir,
    manifestPath: join(rootDir, 'manifest.json'),
    packageJsonPath: join(rootDir, 'package.json'),
  };
  const LINK = 'https://artifacts.example.test/demo-sink-1.3.0.tgz';

  const artifact = (overrides: Partial<PluginArtifact> = {}): PluginArtifact => ({
    sha256,
    slug: 'demo-sink',
    version: '1.3.0',
    compressedBytes: 1234,
    url: LINK,
    registrySlug: 'official',
    receivedById: 'admin-1',
    receivedAt: new Date('2026-11-16T12:00:00.000Z'),
    expiresAt: new Date(Date.parse('2026-11-16T12:00:00.000Z') + PLUGIN_ARTIFACT_TTL_MS),
    ...overrides,
  });

  /** The living plugin as a first read finds it: running another checksum, with nothing staged. */
  const pluginRow = (overrides: Partial<Plugin> = {}): Plugin =>
    ({
      id: 'plugin-1',
      slug: 'demo-sink',
      version: '1.2.0',
      installedSha256: runningSha256,
      pendingSha256: null,
      pendingVersion: null,
      uninstalledAt: null,
      ...overrides,
    }) as unknown as Plugin;

  const staged = pluginRow({ pendingSha256: sha256, pendingVersion: '1.3.0' });
  const running = pluginRow({ installedSha256: sha256, version: '1.3.0' });

  const stageResult = {
    plugin: staged,
    activated: false,
    dataGatewayNameConflict: 'Demo Gateway',
  } as unknown as PluginUpdateStageResult;

  let store: { refreshForInstall: jest.Mock; remove: jest.Mock };
  let updates: { stage: jest.Mock; describePending: jest.Mock };
  let directories: { resolve: jest.Mock };
  let authority: { isServerAdmin: jest.Mock };
  let db: { plugin: { findUnique: jest.Mock } };
  let warn: jest.SpyInstance;
  let stager: PluginArtifactStager;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    store = {
      refreshForInstall: jest.fn().mockResolvedValue(artifact()),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    updates = {
      stage: jest.fn().mockResolvedValue(stageResult),
      describePending: jest.fn().mockResolvedValue({ dataGatewayNameConflict: null }),
    };
    directories = { resolve: jest.fn().mockResolvedValue(directory) };
    authority = { isServerAdmin: jest.fn().mockResolvedValue(true) };
    db = { plugin: { findUnique: jest.fn().mockResolvedValue(pluginRow()) } };

    stager = new PluginArtifactStager(
      store as unknown as PluginArtifactStore,
      updates as unknown as PluginUpdateService,
      directories as unknown as PluginDirectoryResolverService,
      authority as unknown as PluginGrantAuthorityService,
      db as unknown as DatabaseService,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const failure = (call: Promise<unknown>): Promise<unknown> =>
    call.then(
      () => {
        throw new Error('expected the call to fail');
      },
      (err: unknown) => err,
    );

  const stage = (overrides: Partial<Parameters<PluginArtifactStager['stage']>[0]> = {}) =>
    stager.stage({ slug: 'demo-sink', sha256, actorId: 'admin-1', ...overrides });

  it('stages the artifact with its link and registry, then deletes its row (#1096)', async () => {
    await expect(stage({ acknowledgeForbiddenImports: ['axios'], deepScan: true })).resolves.toEqual({
      plugin: staged,
      activated: false,
      dataGatewayNameConflict: 'Demo Gateway',
    });

    expect(db.plugin.findUnique).toHaveBeenCalledWith({ where: { slug: 'demo-sink' } });
    expect(store.refreshForInstall).toHaveBeenCalledWith(sha256, expect.any(Date));
    expect(directories.resolve).toHaveBeenCalledWith('demo-sink', sha256);
    expect(updates.stage).toHaveBeenCalledWith({
      directory,
      url: LINK,
      registrySlug: 'official',
      initiatorId: 'admin-1',
      acknowledgeForbiddenImports: ['axios'],
      deepScan: true,
    });
    expect(store.remove).toHaveBeenCalledWith(sha256);
    expect(store.remove.mock.invocationCallOrder[0]).toBeGreaterThan(updates.stage.mock.invocationCallOrder[0] ?? 0);
  });

  it('an uploaded artifact stages with no link or registry (#1096)', async () => {
    store.refreshForInstall.mockResolvedValue(artifact({ url: null, registrySlug: null }));

    await stage();

    expect(updates.stage).toHaveBeenCalledWith(
      expect.objectContaining({ directory, url: undefined, registrySlug: undefined, initiatorId: 'admin-1' }),
    );
  });

  it('takes the checksum in either case, with spaces around it (#1096)', async () => {
    await stage({ sha256: ` ${sha256.toUpperCase()}\n` });

    expect(store.refreshForInstall).toHaveBeenCalledWith(sha256, expect.any(Date));
    expect(directories.resolve).toHaveBeenCalledWith('demo-sink', sha256);
  });

  it("checks authority before it reads the plugin or the artifact's row (#1096)", async () => {
    authority.isServerAdmin.mockResolvedValue(false);

    // A value that is no checksum would answer not found: authority comes first.
    const err = await failure(stage({ sha256: 'not a checksum', actorId: 'member-1' }));

    expect(err).toBeInstanceOf(PluginUpdateAuthorityError);
    expect(err).toMatchObject({ actorId: 'member-1' });
    expect(authority.isServerAdmin).toHaveBeenCalledWith('member-1');
    expect(db.plugin.findUnique).not.toHaveBeenCalled();
    expect(store.refreshForInstall).not.toHaveBeenCalled();
    expect(updates.stage).not.toHaveBeenCalled();
  });

  it('a value that is no checksum is not found', async () => {
    for (const value of ['not a checksum', `../../${'a'.repeat(58)}`, 'a'.repeat(65)]) {
      const err = await failure(stage({ sha256: value }));

      expect(err).toBeInstanceOf(PluginArtifactNotFoundError);
      expect(err).toMatchObject({ sha256: value });
    }

    expect(db.plugin.findUnique).not.toHaveBeenCalled();
    expect(store.refreshForInstall).not.toHaveBeenCalled();
  });

  it('an unknown or expired artifact is not found, and the plugin is not touched', async () => {
    store.refreshForInstall.mockResolvedValue(null);

    const err = await failure(stage());

    expect(err).toBeInstanceOf(PluginArtifactNotFoundError);
    expect(err).toMatchObject({ sha256 });
    // The first read, and the look for a winner; neither found this checksum.
    expect(db.plugin.findUnique).toHaveBeenCalledTimes(2);
    expect(directories.resolve).not.toHaveBeenCalled();
    expect(updates.stage).not.toHaveBeenCalled();
    expect(store.remove).not.toHaveBeenCalled();
  });

  it('a slug nobody installed is not found', async () => {
    db.plugin.findUnique.mockResolvedValue(null);

    const err = await failure(stage());

    expect(err).toBeInstanceOf(PluginUpdatePluginNotFoundError);
    expect(err).toMatchObject({ slug: 'demo-sink' });
    expect(store.refreshForInstall).not.toHaveBeenCalled();
    expect(updates.stage).not.toHaveBeenCalled();
  });

  it('an uninstalled plugin answers as uninstalled', async () => {
    const uninstalledAt = new Date('2026-11-01T00:00:00.000Z');
    // Even one whose last checksum is this one: an uninstalled plugin runs nothing.
    db.plugin.findUnique.mockResolvedValue(pluginRow({ uninstalledAt, installedSha256: sha256 }));

    const err = await failure(stage());

    expect(err).toBeInstanceOf(PluginUpdateTombstonedError);
    expect(err).toMatchObject({ slug: 'demo-sink', uninstalledAt });
    expect(store.refreshForInstall).not.toHaveBeenCalled();
    expect(updates.stage).not.toHaveBeenCalled();
  });

  it('refuses an artifact that belongs to another plugin, and keeps its row (#1096)', async () => {
    store.refreshForInstall.mockResolvedValue(artifact({ slug: 'other-sink' }));

    const err = await failure(stage());

    expect(err).toBeInstanceOf(PluginArtifactBelongsToAnotherPluginError);
    expect(err).toMatchObject({ slug: 'demo-sink', artifactSlug: 'other-sink', sha256 });
    expect(directories.resolve).not.toHaveBeenCalled();
    expect(updates.stage).not.toHaveBeenCalled();
    expect(store.remove).not.toHaveBeenCalled();
  });

  it('an artifact whose directory is gone has its row removed and answers not found (#1096)', async () => {
    directories.resolve.mockRejectedValue(new PluginDirectoryNotFoundError('demo-sink', rootDir));

    const err = await failure(stage());

    expect(err).toBeInstanceOf(PluginArtifactNotFoundError);
    expect(store.remove).toHaveBeenCalledWith(sha256);
    expect(updates.stage).not.toHaveBeenCalled();
  });

  it('a directory the resolver refuses for its layout propagates, and keeps the row (#1096)', async () => {
    const refusal = new PluginDirectoryLayoutError('demo-sink', 'refused for the test');
    directories.resolve.mockRejectedValue(refusal);

    await expect(stage()).rejects.toBe(refusal);

    expect(store.remove).not.toHaveBeenCalled();
    expect(updates.stage).not.toHaveBeenCalled();
  });

  // A double click, or a retry after a lost response: a state change already at
  // its target answers 2xx with the current record, and does nothing.
  describe('a staging that is already done (#1096)', () => {
    it('answers the staged update when the plugin already has one from this checksum, and stages nothing', async () => {
      db.plugin.findUnique.mockResolvedValue(staged);
      updates.describePending.mockResolvedValue({ dataGatewayNameConflict: 'Demo Gateway' });

      await expect(stage()).resolves.toEqual({
        plugin: staged,
        activated: false,
        dataGatewayNameConflict: 'Demo Gateway',
      });

      expect(updates.describePending).toHaveBeenCalledWith('demo-sink');
      expect(updates.stage).not.toHaveBeenCalled();
      expect(store.refreshForInstall).not.toHaveBeenCalled();
      expect(store.remove).not.toHaveBeenCalled();
    });

    it('answers the staged update with no DataGateway name when its stored manifest cannot be read (#1096)', async () => {
      db.plugin.findUnique.mockResolvedValue(staged);
      updates.describePending.mockRejectedValue(
        new PluginUpdateManifestError('demo-sink', 'pending', 'unreadable for the test'),
      );

      await expect(stage()).resolves.toEqual({ plugin: staged, activated: false, dataGatewayNameConflict: null });

      expect(updates.stage).not.toHaveBeenCalled();
    });

    it('lets any other failure of the staged-update read propagate (#1096)', async () => {
      db.plugin.findUnique.mockResolvedValue(staged);
      const lost = new Error('connection lost');
      updates.describePending.mockRejectedValue(lost);

      await expect(stage()).rejects.toBe(lost);
    });

    it('answers the plugin when it already runs this checksum', async () => {
      db.plugin.findUnique.mockResolvedValue(running);

      await expect(stage()).resolves.toEqual({ plugin: running, activated: true, dataGatewayNameConflict: null });

      expect(updates.stage).not.toHaveBeenCalled();
      expect(updates.describePending).not.toHaveBeenCalled();
      expect(store.refreshForInstall).not.toHaveBeenCalled();
      expect(store.remove).not.toHaveBeenCalled();
    });

    it('checks authority before it answers (#1096)', async () => {
      authority.isServerAdmin.mockResolvedValue(false);
      db.plugin.findUnique.mockResolvedValue(running);

      const err = await failure(stage({ actorId: 'member-1' }));

      expect(err).toBeInstanceOf(PluginUpdateAuthorityError);
      expect(db.plugin.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('two stagings of one checksum at once (#1096)', () => {
    it('the one that loses answers with what the other staged', async () => {
      // Both find nothing staged; by the time this one fails, the other has committed.
      db.plugin.findUnique.mockResolvedValueOnce(pluginRow()).mockResolvedValueOnce(staged);
      updates.stage.mockRejectedValue(new PluginUpdatePendingConflictError('demo-sink', '1.3.0', '1.3.0'));
      updates.describePending.mockResolvedValue({ dataGatewayNameConflict: 'Demo Gateway' });

      await expect(stage()).resolves.toEqual({
        plugin: staged,
        activated: false,
        dataGatewayNameConflict: 'Demo Gateway',
      });

      expect(db.plugin.findUnique).toHaveBeenCalledTimes(2);
      expect(db.plugin.findUnique).toHaveBeenLastCalledWith({ where: { slug: 'demo-sink' } });
      // The winner deletes the row.
      expect(store.remove).not.toHaveBeenCalled();
    });

    it('the one that loses to an update activated at once answers with the plugin (#1096)', async () => {
      // The other activation committed first, so this one is refused as
      // activating the version that is already active: by its claim, or by
      // the version check when it loaded the row after that commit.
      db.plugin.findUnique.mockResolvedValueOnce(pluginRow()).mockResolvedValueOnce(running);
      updates.stage.mockRejectedValue(new PluginUpdateVersionConflictError('demo-sink', '1.3.0'));

      await expect(stage()).resolves.toEqual({ plugin: running, activated: true, dataGatewayNameConflict: null });
    });

    it('the one that finds the row already deleted answers the same', async () => {
      // Both find nothing staged; the other then stages and deletes the row
      // before this one refreshes it, so the refresh finds no row.
      db.plugin.findUnique.mockResolvedValueOnce(pluginRow()).mockResolvedValueOnce(staged);
      store.refreshForInstall.mockResolvedValue(null);

      await expect(stage()).resolves.toEqual({ plugin: staged, activated: false, dataGatewayNameConflict: null });

      expect(directories.resolve).not.toHaveBeenCalled();
      expect(updates.stage).not.toHaveBeenCalled();
      expect(store.remove).not.toHaveBeenCalled();
    });

    it('a refusal with nothing staged from this checksum is still the answer', async () => {
      // Another checksum's staged update waits: nothing raced this one.
      const conflict = new PluginUpdatePendingConflictError('demo-sink', '1.2.5', '1.3.0');
      db.plugin.findUnique.mockResolvedValue(pluginRow({ pendingSha256: runningSha256, pendingVersion: '1.2.5' }));
      updates.stage.mockRejectedValue(conflict);

      await expect(stage()).rejects.toBe(conflict);

      expect(db.plugin.findUnique).toHaveBeenCalledTimes(2);
    });

    it('a failed look for a winner keeps the staging failure as the answer (#1096)', async () => {
      const conflict = new PluginUpdatePendingConflictError('demo-sink', '1.2.5', '1.3.0');
      db.plugin.findUnique.mockResolvedValueOnce(pluginRow()).mockRejectedValueOnce(new Error('connection lost'));
      updates.stage.mockRejectedValue(conflict);

      await expect(stage()).rejects.toBe(conflict);
    });

    it('a failed look for a winner leaves a warning naming the plugin and the failure (#1096)', async () => {
      // The refusal stays the answer, and a database failure during it still leaves a trace.
      const conflict = new PluginUpdatePendingConflictError('demo-sink', '1.2.5', '1.3.0');
      db.plugin.findUnique.mockResolvedValueOnce(pluginRow()).mockRejectedValueOnce(new Error('connection lost'));
      updates.stage.mockRejectedValue(conflict);

      await expect(stage()).rejects.toBe(conflict);

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("'demo-sink'"));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('connection lost'));
    });

    it('a refused staging whose look for a winner succeeds leaves no warning (#1096)', async () => {
      const conflict = new PluginUpdatePendingConflictError('demo-sink', '1.2.5', '1.3.0');
      db.plugin.findUnique.mockResolvedValue(pluginRow({ pendingSha256: runningSha256, pendingVersion: '1.2.5' }));
      updates.stage.mockRejectedValue(conflict);

      await expect(stage()).rejects.toBe(conflict);

      expect(warn).not.toHaveBeenCalled();
    });

    it('a plugin uninstalled since is no winner (#1096)', async () => {
      const conflict = new Error('refused for the test');
      db.plugin.findUnique
        .mockResolvedValueOnce(pluginRow())
        .mockResolvedValueOnce(pluginRow({ installedSha256: sha256, uninstalledAt: new Date() }));
      updates.stage.mockRejectedValue(conflict);

      await expect(stage()).rejects.toBe(conflict);
    });
  });

  it("a refused staging keeps the artifact's row, so the server admin can try again", async () => {
    const refusal = new PluginUpdateStaticAnalysisError('demo-sink', [], ['axios']);
    updates.stage.mockRejectedValue(refusal);

    await expect(stage()).rejects.toBe(refusal);

    expect(store.remove).not.toHaveBeenCalled();
  });

  it('a row that cannot be deleted afterwards is logged, and the staging still succeeds', async () => {
    store.remove.mockRejectedValue(new Error('connection lost'));

    await expect(stage()).resolves.toEqual({
      plugin: staged,
      activated: false,
      dataGatewayNameConflict: 'Demo Gateway',
    });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining(sha256));
  });

  it('an artifact whose directory is gone still answers not found when its row cannot be deleted (#1096)', async () => {
    directories.resolve.mockRejectedValue(new PluginDirectoryNotFoundError('demo-sink', rootDir));
    store.remove.mockRejectedValue(new Error('connection lost'));

    const err = await failure(stage());

    expect(err).toBeInstanceOf(PluginArtifactNotFoundError);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(sha256));
  });
});
