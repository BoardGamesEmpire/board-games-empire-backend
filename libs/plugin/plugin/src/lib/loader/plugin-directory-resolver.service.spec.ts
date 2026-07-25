import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginModuleOptions } from '../plugin-module.options';
import { PluginDirectoryLayoutError, PluginDirectoryNotFoundError } from './loader.errors';
import { PluginDirectoryResolverService } from './plugin-directory-resolver.service';

describe('PluginDirectoryResolverService', () => {
  let pluginsRoot: string;
  let bundledRoot: string;
  let resolver: PluginDirectoryResolverService;

  const options = (): PluginModuleOptions => ({
    pluginsRoot,
    bundledRoot,
    bgeVersion: '0.1.0',
    defaultLocale: 'en',
  });

  const scaffold = async (root: string, slug: string, files: readonly string[]): Promise<string> => {
    const dir = join(root, slug);
    await mkdir(dir, { recursive: true });

    for (const file of files) {
      await writeFile(join(dir, file), '{}');
    }

    return dir;
  };

  beforeEach(async () => {
    // realpath'd: the resolver returns real paths, and a symlinked tmpdir
    // would otherwise make the path assertions environment-dependent.
    pluginsRoot = await realpath(await mkdtemp(join(tmpdir(), 'bge-plugins-')));
    bundledRoot = await realpath(await mkdtemp(join(tmpdir(), 'bge-bundled-')));
    resolver = new PluginDirectoryResolverService(options());
  });

  afterEach(async () => {
    await rm(pluginsRoot, { recursive: true, force: true });
    await rm(bundledRoot, { recursive: true, force: true });
  });

  it('resolves an installed plugin directory with manifest and package descriptor at the root', async () => {
    const dir = await scaffold(pluginsRoot, 'demo-sink', ['manifest.json', 'package.json']);

    const resolved = await resolver.resolve('demo-sink', false);

    expect(resolved).toEqual({
      slug: 'demo-sink',
      rootDir: dir,
      manifestPath: join(dir, 'manifest.json'),
      packageJsonPath: join(dir, 'package.json'),
      bundled: false,
    });
  });

  it('resolves bundled plugins from the bundled root, not the install root', async () => {
    await scaffold(bundledRoot, 'local-disk', ['manifest.json', 'package.json']);

    const resolved = await resolver.resolve('local-disk', true);

    expect(resolved.rootDir).toBe(join(bundledRoot, 'local-disk'));
    expect(resolved.bundled).toBe(true);
  });

  it('does not fall back across roots: a bundled lookup ignores an install-root directory of the same slug', async () => {
    await scaffold(pluginsRoot, 'local-disk', ['manifest.json', 'package.json']);

    await expect(resolver.resolve('local-disk', true)).rejects.toBeInstanceOf(PluginDirectoryNotFoundError);
  });

  it('throws PluginDirectoryNotFoundError for a missing directory', async () => {
    await expect(resolver.resolve('absent', false)).rejects.toBeInstanceOf(PluginDirectoryNotFoundError);
  });

  it('throws PluginDirectoryLayoutError when manifest.json is missing', async () => {
    await scaffold(pluginsRoot, 'no-manifest', ['package.json']);

    await expect(resolver.resolve('no-manifest', false)).rejects.toThrow(/manifest\.json .* is missing or not/);
  });

  it('throws PluginDirectoryLayoutError when package.json is missing', async () => {
    await scaffold(pluginsRoot, 'no-descriptor', ['manifest.json']);

    await expect(resolver.resolve('no-descriptor', false)).rejects.toThrow(/package\.json .* is missing or not/);
  });

  it('rejects a DIRECTORY named manifest.json rather than deferring to an opaque read error', async () => {
    const dir = join(pluginsRoot, 'manifest-is-a-dir');
    await mkdir(join(dir, 'manifest.json'), { recursive: true });
    await writeFile(join(dir, 'package.json'), '{}');

    await expect(resolver.resolve('manifest-is-a-dir', false)).rejects.toBeInstanceOf(PluginDirectoryLayoutError);
    await expect(resolver.resolve('manifest-is-a-dir', false)).rejects.toThrow(/not a regular file/);
  });

  it('rejects a slug that fails the manifest slug pattern before touching the filesystem', async () => {
    await expect(resolver.resolve('../escape', false)).rejects.toBeInstanceOf(PluginDirectoryLayoutError);
    await expect(resolver.resolve('UPPER', false)).rejects.toBeInstanceOf(PluginDirectoryLayoutError);
  });

  describe('symlink containment', () => {
    it('accepts a layout file symlinked to another location inside the plugin directory', async () => {
      const dir = await scaffold(pluginsRoot, 'inner-link', ['manifest.json']);
      await mkdir(join(dir, 'meta'), { recursive: true });
      await writeFile(join(dir, 'meta', 'real-package.json'), '{}');
      await symlink(join(dir, 'meta', 'real-package.json'), join(dir, 'package.json'));

      await expect(resolver.resolve('inner-link', false)).resolves.toEqual(
        expect.objectContaining({ slug: 'inner-link', rootDir: dir }),
      );
    });

    it('rejects a package.json symlinked to a host path outside the plugin directory', async () => {
      const outside = await mkdtemp(join(tmpdir(), 'bge-host-'));
      const hostFile = join(outside, 'host-secret.json');
      await writeFile(hostFile, '{"main":"whatever"}');

      try {
        const dir = await scaffold(pluginsRoot, 'escaping-descriptor', ['manifest.json']);
        await symlink(hostFile, join(dir, 'package.json'));

        await expect(resolver.resolve('escaping-descriptor', false)).rejects.toThrow(
          /package\.json resolves outside the plugin directory/,
        );
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });

    it('rejects a manifest.json symlinked outside the plugin directory', async () => {
      const outside = await mkdtemp(join(tmpdir(), 'bge-host-'));
      await writeFile(join(outside, 'host.json'), '{}');

      try {
        const dir = await scaffold(pluginsRoot, 'escaping-manifest', ['package.json']);
        await symlink(join(outside, 'host.json'), join(dir, 'manifest.json'));

        await expect(resolver.resolve('escaping-manifest', false)).rejects.toThrow(
          /manifest\.json resolves outside the plugin directory/,
        );
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });

    it('rejects a plugin directory that is itself a symlink out of the configured root', async () => {
      const outside = await mkdtemp(join(tmpdir(), 'bge-host-'));
      await writeFile(join(outside, 'manifest.json'), '{}');
      await writeFile(join(outside, 'package.json'), '{}');

      try {
        await symlink(outside, join(pluginsRoot, 'linked-away'));

        await expect(resolver.resolve('linked-away', false)).rejects.toThrow(
          /resolves outside the configured plugin root/,
        );
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });

    it('rejects when the configured root itself cannot be resolved', async () => {
      const missingRootResolver = new PluginDirectoryResolverService({
        pluginsRoot: join(pluginsRoot, 'does-not-exist'),
        bundledRoot,
        bgeVersion: '0.1.0',
        defaultLocale: 'en',
      });

      await expect(missingRootResolver.resolve('demo-sink', false)).rejects.toThrow(
        /configured plugin root .* cannot be resolved/,
      );
    });
  });
});
