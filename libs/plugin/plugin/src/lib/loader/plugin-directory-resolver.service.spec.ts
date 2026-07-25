import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
    pluginsRoot = await mkdtemp(join(tmpdir(), 'bge-plugins-'));
    bundledRoot = await mkdtemp(join(tmpdir(), 'bge-bundled-'));
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

    await expect(resolver.resolve('no-manifest', false)).rejects.toThrow(/missing manifest\.json/);
  });

  it('throws PluginDirectoryLayoutError when package.json is missing', async () => {
    await scaffold(pluginsRoot, 'no-descriptor', ['manifest.json']);

    await expect(resolver.resolve('no-descriptor', false)).rejects.toThrow(/missing package\.json/);
  });

  it('rejects a slug that fails the manifest slug pattern before touching the filesystem', async () => {
    await expect(resolver.resolve('../escape', false)).rejects.toBeInstanceOf(PluginDirectoryLayoutError);
    await expect(resolver.resolve('UPPER', false)).rejects.toBeInstanceOf(PluginDirectoryLayoutError);
  });
});
