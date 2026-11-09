import type { DatabaseService, Plugin, PluginArtifact } from '@bge/database';
import {
  PluginDirectoryLayoutError,
  PluginDirectoryNotFoundError,
  PluginInstallAuthorityError,
  PluginInstallConflictError,
  PluginInstallCriticalConfirmationError,
  type PluginDirectoryResolverService,
  type PluginGrantAuthorityService,
  type PluginInstallerService,
  type PluginInstallResult,
} from '@bge/plugin';
import { buildPluginArtifactSha256, type PluginArtifactDirectory } from '@boardgamesempire/plugin-contract';
import { Logger } from '@nestjs/common';
import { join } from 'node:path';
import { PluginArtifactNotFoundError } from '../artifacts.errors';
import { PLUGIN_ARTIFACT_TTL_MS, type PluginArtifactStore } from '../store/plugin-artifact.store';
import { PluginArtifactInstaller } from './plugin-artifact.installer';

describe('PluginArtifactInstaller (#1094)', () => {
  const sha256 = buildPluginArtifactSha256('a');
  const rootDir = join('/plugins', 'demo-sink', sha256);
  const directory: PluginArtifactDirectory = {
    slug: 'demo-sink',
    sha256,
    rootDir,
    manifestPath: join(rootDir, 'manifest.json'),
    packageJsonPath: join(rootDir, 'package.json'),
  };
  const LINK = 'https://artifacts.example.test/demo-sink-1.2.0.tgz';
  const result = { plugin: { id: 'plugin-1', slug: 'demo-sink' } } as unknown as PluginInstallResult;

  const artifact = (overrides: Partial<PluginArtifact> = {}): PluginArtifact => ({
    sha256,
    slug: 'demo-sink',
    version: '1.2.0',
    compressedBytes: 1234,
    url: LINK,
    registrySlug: null,
    receivedById: 'admin-1',
    receivedAt: new Date('2026-11-05T12:00:00.000Z'),
    expiresAt: new Date(Date.parse('2026-11-05T12:00:00.000Z') + PLUGIN_ARTIFACT_TTL_MS),
    ...overrides,
  });

  let store: { refreshForInstall: jest.Mock; remove: jest.Mock };
  let runtime: { install: jest.Mock };
  let directories: { resolve: jest.Mock };
  let authority: { isServerAdmin: jest.Mock };
  let db: { plugin: { findFirst: jest.Mock } };
  let warn: jest.SpyInstance;
  let installer: PluginArtifactInstaller;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    store = {
      refreshForInstall: jest.fn().mockResolvedValue(artifact()),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    runtime = { install: jest.fn().mockResolvedValue(result) };
    directories = { resolve: jest.fn().mockResolvedValue(directory) };
    authority = { isServerAdmin: jest.fn().mockResolvedValue(true) };
    // No living plugin runs the checksum yet, as before a first install.
    db = { plugin: { findFirst: jest.fn().mockResolvedValue(null) } };

    installer = new PluginArtifactInstaller(
      store as unknown as PluginArtifactStore,
      runtime as unknown as PluginInstallerService,
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

  it('a successful install deletes its artifact row and records the link as provenance (#1094)', async () => {
    await expect(
      installer.install({
        sha256,
        actorId: 'admin-1',
        confirmCriticalSlugs: ['feedback:read'],
        acknowledgeForbiddenImports: ['axios'],
        deepScan: true,
      }),
    ).resolves.toBe(result);

    expect(store.refreshForInstall).toHaveBeenCalledWith(sha256, expect.any(Date));
    expect(directories.resolve).toHaveBeenCalledWith('demo-sink', sha256);
    expect(runtime.install).toHaveBeenCalledWith({
      directory,
      url: LINK,
      registrySlug: undefined,
      installerId: 'admin-1',
      confirmCriticalSlugs: ['feedback:read'],
      acknowledgeForbiddenImports: ['axios'],
      deepScan: true,
    });
    expect(store.remove).toHaveBeenCalledWith(sha256);
    expect(store.remove.mock.invocationCallOrder[0]).toBeGreaterThan(runtime.install.mock.invocationCallOrder[0] ?? 0);
  });

  it('takes the checksum in either case, with spaces around it, as the post does (#1094)', async () => {
    await expect(installer.install({ sha256: ` ${sha256.toUpperCase()}\n`, actorId: 'admin-1' })).resolves.toBe(result);

    expect(db.plugin.findFirst).toHaveBeenCalledWith({ where: { installedSha256: sha256, uninstalledAt: null } });
    expect(store.refreshForInstall).toHaveBeenCalledWith(sha256, expect.any(Date));
    expect(directories.resolve).toHaveBeenCalledWith('demo-sink', sha256);
  });

  describe('two installs of one checksum at once (#1094)', () => {
    const winner = {
      id: 'plugin-1',
      slug: 'demo-sink',
      installedSha256: sha256,
      uninstalledAt: null,
    } as unknown as Plugin;

    it('the one that loses the race answers with the plugin the other installed (#1094)', async () => {
      // Both find nothing installed; by the time this one fails, the other has committed.
      db.plugin.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(winner);
      runtime.install.mockRejectedValue(new PluginInstallConflictError('demo-sink'));

      await expect(installer.install({ sha256, actorId: 'admin-1' })).resolves.toEqual({ plugin: winner });

      expect(db.plugin.findFirst).toHaveBeenLastCalledWith({ where: { installedSha256: sha256, uninstalledAt: null } });
    });

    it('the loser answers with the winner even when the winner deleted the row before this one refreshed it (#1094)', async () => {
      // Both find nothing installed; the other then installs and deletes the
      // row before this one refreshes it, so the refresh finds no row.
      db.plugin.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(winner);
      store.refreshForInstall.mockResolvedValue(null);

      await expect(installer.install({ sha256, actorId: 'admin-1' })).resolves.toEqual({ plugin: winner });

      expect(db.plugin.findFirst).toHaveBeenCalledTimes(2);
      expect(directories.resolve).not.toHaveBeenCalled();
      expect(runtime.install).not.toHaveBeenCalled();
      expect(store.remove).not.toHaveBeenCalled();
    });

    it('a failure with no plugin running the checksum is still the answer (#1094)', async () => {
      const conflict = new PluginInstallConflictError('demo-sink');
      runtime.install.mockRejectedValue(conflict);

      await expect(installer.install({ sha256, actorId: 'admin-1' })).rejects.toBe(conflict);

      expect(db.plugin.findFirst).toHaveBeenCalledTimes(2);
    });

    it('a failed look for the winner keeps the install failure as the answer (#1094)', async () => {
      const conflict = new PluginInstallConflictError('demo-sink');
      runtime.install.mockRejectedValue(conflict);
      db.plugin.findFirst.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('connection lost'));

      await expect(installer.install({ sha256, actorId: 'admin-1' })).rejects.toBe(conflict);
    });
  });

  it('an uploaded artifact installs with no link, and keeps its registry (#1094)', async () => {
    store.refreshForInstall.mockResolvedValue(artifact({ url: null, registrySlug: 'official' }));

    await installer.install({ sha256, actorId: 'admin-1' });

    expect(runtime.install).toHaveBeenCalledWith(
      expect.objectContaining({ directory, url: undefined, registrySlug: 'official', installerId: 'admin-1' }),
    );
  });

  it('installing an expired artifact that was never installed answers not found (#1094)', async () => {
    store.refreshForInstall.mockResolvedValue(null);

    const err = await failure(installer.install({ sha256, actorId: 'admin-1' }));

    expect(err).toBeInstanceOf(PluginArtifactNotFoundError);
    expect(err).toMatchObject({ name: 'PluginArtifactNotFoundError', sha256 });
    expect(db.plugin.findFirst).toHaveBeenCalledWith({ where: { installedSha256: sha256, uninstalledAt: null } });
    expect(directories.resolve).not.toHaveBeenCalled();
    expect(runtime.install).not.toHaveBeenCalled();
  });

  // A double click, or a retry after a lost response: a state change already at
  // its target answers 2xx with the current record, and nothing is emitted
  // (ADR-0002).
  describe('an install that is already done (#1094)', () => {
    const installed = {
      id: 'plugin-1',
      slug: 'demo-sink',
      installedSha256: sha256,
      uninstalledAt: null,
    } as unknown as Plugin;

    it('answers with the plugin running the checksum, and installs, emits and refreshes nothing (#1094)', async () => {
      db.plugin.findFirst.mockResolvedValue(installed);
      // The first install deleted the artifact's row.
      store.refreshForInstall.mockResolvedValue(null);

      await expect(installer.install({ sha256, actorId: 'admin-1' })).resolves.toEqual({ plugin: installed });

      expect(db.plugin.findFirst).toHaveBeenCalledWith({ where: { installedSha256: sha256, uninstalledAt: null } });
      expect(runtime.install).not.toHaveBeenCalled();
      expect(directories.resolve).not.toHaveBeenCalled();
      expect(store.refreshForInstall).not.toHaveBeenCalled();
      // A row posted again since is done with too.
      expect(store.remove).toHaveBeenCalledWith(sha256);
    });

    it('still answers with the plugin when the artifact row cannot be deleted (#1094)', async () => {
      db.plugin.findFirst.mockResolvedValue(installed);
      store.remove.mockRejectedValue(new Error('connection lost'));

      await expect(installer.install({ sha256, actorId: 'admin-1' })).resolves.toEqual({ plugin: installed });

      expect(warn).toHaveBeenCalledWith(expect.stringContaining(sha256));
    });

    it('checks authority before it looks for the plugin (#1094)', async () => {
      authority.isServerAdmin.mockResolvedValue(false);
      db.plugin.findFirst.mockResolvedValue(installed);

      const err = await failure(installer.install({ sha256, actorId: 'member-1' }));

      expect(err).toBeInstanceOf(PluginInstallAuthorityError);
      expect(db.plugin.findFirst).not.toHaveBeenCalled();
    });
  });

  it('checks authority before it touches the artifact row, so only a server admin can extend its expiry (#1094)', async () => {
    authority.isServerAdmin.mockResolvedValue(false);

    // A value that is not a checksum would answer not found: authority comes first.
    const err = await failure(installer.install({ sha256: 'not a checksum', actorId: 'member-1' }));

    expect(err).toBeInstanceOf(PluginInstallAuthorityError);
    expect(authority.isServerAdmin).toHaveBeenCalledWith('member-1');
    expect(store.refreshForInstall).not.toHaveBeenCalled();
    expect(runtime.install).not.toHaveBeenCalled();
  });

  it.each(['not a checksum', `../../${'a'.repeat(58)}`, 'a'.repeat(65)])(
    'a value that is not a checksum, %j, answers not found without touching a row (#1094)',
    async (value) => {
      const err = await failure(installer.install({ sha256: value, actorId: 'admin-1' }));

      expect(err).toBeInstanceOf(PluginArtifactNotFoundError);
      expect(err).toMatchObject({ sha256: value });
      expect(db.plugin.findFirst).not.toHaveBeenCalled();
      expect(store.refreshForInstall).not.toHaveBeenCalled();
    },
  );

  it('an artifact whose directory is gone has its row removed and answers not found (#1094)', async () => {
    directories.resolve.mockRejectedValue(new PluginDirectoryNotFoundError('demo-sink', rootDir));

    const err = await failure(installer.install({ sha256, actorId: 'admin-1' }));

    expect(err).toBeInstanceOf(PluginArtifactNotFoundError);
    expect(store.remove).toHaveBeenCalledWith(sha256);
    expect(runtime.install).not.toHaveBeenCalled();
  });

  it('an artifact whose directory is gone still answers not found when its row cannot be deleted (#1094)', async () => {
    directories.resolve.mockRejectedValue(new PluginDirectoryNotFoundError('demo-sink', rootDir));
    store.remove.mockRejectedValue(new Error('connection lost'));

    const err = await failure(installer.install({ sha256, actorId: 'admin-1' }));

    expect(err).toBeInstanceOf(PluginArtifactNotFoundError);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(sha256));
    expect(runtime.install).not.toHaveBeenCalled();
  });

  it('a directory the resolver refuses for its layout propagates, and keeps the row (#1094)', async () => {
    const refusal = new PluginDirectoryLayoutError('demo-sink', 'refused for the test');
    directories.resolve.mockRejectedValue(refusal);

    await expect(installer.install({ sha256, actorId: 'admin-1' })).rejects.toBe(refusal);

    expect(store.remove).not.toHaveBeenCalled();
    expect(runtime.install).not.toHaveBeenCalled();
  });

  it('a refused install keeps the artifact row, so the server admin can try again (#1094)', async () => {
    const refusal = new PluginInstallCriticalConfirmationError('demo-sink', ['feedback:read'], []);
    runtime.install.mockRejectedValue(refusal);

    await expect(installer.install({ sha256, actorId: 'admin-1' })).rejects.toBe(refusal);

    expect(store.remove).not.toHaveBeenCalled();
  });

  it('a row that cannot be deleted after the install is logged, and the install still succeeds (#1094)', async () => {
    store.remove.mockRejectedValue(new Error('connection lost'));

    await expect(installer.install({ sha256, actorId: 'admin-1' })).resolves.toBe(result);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining(sha256));
  });
});
