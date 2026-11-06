import { buildPluginArtifactSha256 as sha, type PluginArtifactSha256 } from '@boardgamesempire/plugin-contract';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginModuleOptions } from '../plugin-module.options';
import { buildPluginModuleOptions } from '../testing/plugin-module-options.fixture';
import { PluginDirectoryLayoutError, PluginDirectoryNotFoundError } from './loader.errors';
import { PluginDirectoryResolverService } from './plugin-directory-resolver.service';

describe('PluginDirectoryResolverService', () => {
  const SHA_A = sha('a');
  const SHA_B = sha('b');

  let pluginsRoot: string;
  let resolver: PluginDirectoryResolverService;

  const options = (): PluginModuleOptions => buildPluginModuleOptions({ pluginsRoot });

  /** Writes a plugin artifact directory, `<root>/<slug>/<sha256>/`, holding the given files. */
  const scaffold = async (
    root: string,
    slug: string,
    files: readonly string[],
    sha256: string = SHA_A,
  ): Promise<string> => {
    const dir = join(root, slug, sha256);
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
    resolver = new PluginDirectoryResolverService(options());
  });

  afterEach(async () => {
    await rm(pluginsRoot, { recursive: true, force: true });
  });

  it('resolves <pluginsRoot>/<slug>/<sha256> and reports the checksum (#224)', async () => {
    await scaffold(pluginsRoot, 'demo-sink', ['manifest.json', 'package.json']);
    const rootDir = join(pluginsRoot, 'demo-sink', SHA_A);

    const resolved = await resolver.resolve('demo-sink', SHA_A);

    expect(resolved).toStrictEqual({
      slug: 'demo-sink',
      sha256: SHA_A,
      rootDir,
      manifestPath: join(rootDir, 'manifest.json'),
      packageJsonPath: join(rootDir, 'package.json'),
    });
  });

  it('resolves each artifact of a slug by its own checksum (#224)', async () => {
    // An installed artifact and a staged one sit side by side under the slug;
    // the checksum alone says which directory is meant.
    await scaffold(pluginsRoot, 'demo-sink', ['manifest.json', 'package.json'], SHA_A);
    await scaffold(pluginsRoot, 'demo-sink', ['manifest.json', 'package.json'], SHA_B);

    await expect(resolver.resolve('demo-sink', SHA_B)).resolves.toEqual(
      expect.objectContaining({ sha256: SHA_B, rootDir: join(pluginsRoot, 'demo-sink', SHA_B) }),
    );
  });

  it('refuses a checksum that is not 64 lowercase hex characters, before touching the disk (#224)', async () => {
    // The root does not exist: a resolver that touched the disk before
    // checking the checksum would report the root instead.
    const diskless = new PluginDirectoryResolverService({ ...options(), pluginsRoot: join(pluginsRoot, 'missing') });

    for (const refused of ['A'.repeat(64), 'a'.repeat(63), '../' + 'a'.repeat(61), randomUUID()]) {
      const failure = await diskless.resolve('demo-sink', refused).catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(PluginDirectoryLayoutError);
      expect((failure as Error).message).toMatch(/checksum fails .* and cannot be a path segment/);
    }
  });

  it('reports a missing artifact directory as not found, naming slug and checksum (#224)', async () => {
    // The slug has a directory, but not for this artifact.
    await scaffold(pluginsRoot, 'demo-sink', ['manifest.json', 'package.json'], SHA_B);

    const failure = await resolver.resolve('demo-sink', SHA_A).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(PluginDirectoryNotFoundError);
    expect(failure).toMatchObject({ slug: 'demo-sink', expectedPath: join(pluginsRoot, 'demo-sink', SHA_A) });
  });

  it('throws PluginDirectoryNotFoundError when the slug has no directory at all (#224)', async () => {
    await expect(resolver.resolve('absent', SHA_A)).rejects.toBeInstanceOf(PluginDirectoryNotFoundError);
  });

  it('throws PluginDirectoryLayoutError when manifest.json is missing', async () => {
    await scaffold(pluginsRoot, 'no-manifest', ['package.json']);

    await expect(resolver.resolve('no-manifest', SHA_A)).rejects.toThrow(/manifest\.json .* is missing or not/);
  });

  it('throws PluginDirectoryLayoutError when package.json is missing', async () => {
    await scaffold(pluginsRoot, 'no-descriptor', ['manifest.json']);

    await expect(resolver.resolve('no-descriptor', SHA_A)).rejects.toThrow(/package\.json .* is missing or not/);
  });

  it('rejects a DIRECTORY named manifest.json rather than deferring to an opaque read error', async () => {
    const dir = join(pluginsRoot, 'manifest-is-a-dir', SHA_A);
    await mkdir(join(dir, 'manifest.json'), { recursive: true });
    await writeFile(join(dir, 'package.json'), '{}');

    await expect(resolver.resolve('manifest-is-a-dir', SHA_A)).rejects.toBeInstanceOf(PluginDirectoryLayoutError);
    await expect(resolver.resolve('manifest-is-a-dir', SHA_A)).rejects.toThrow(/not a regular file/);
  });

  it('rejects a slug that fails the manifest slug pattern before touching the filesystem', async () => {
    await expect(resolver.resolve('../escape', SHA_A)).rejects.toBeInstanceOf(PluginDirectoryLayoutError);
    await expect(resolver.resolve('UPPER', SHA_A)).rejects.toBeInstanceOf(PluginDirectoryLayoutError);
  });

  describe('symlink containment', () => {
    it('accepts a layout file symlinked to another location inside the plugin directory', async () => {
      const dir = await scaffold(pluginsRoot, 'inner-link', ['manifest.json']);
      await mkdir(join(dir, 'meta'), { recursive: true });
      await writeFile(join(dir, 'meta', 'real-package.json'), '{}');
      await symlink(join(dir, 'meta', 'real-package.json'), join(dir, 'package.json'));

      await expect(resolver.resolve('inner-link', SHA_A)).resolves.toEqual(
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

        await expect(resolver.resolve('escaping-descriptor', SHA_A)).rejects.toThrow(
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

        await expect(resolver.resolve('escaping-manifest', SHA_A)).rejects.toThrow(
          /manifest\.json resolves outside the plugin directory/,
        );
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });

    it('refuses an artifact directory that links out of the plugins root (#224)', async () => {
      const outside = await mkdtemp(join(tmpdir(), 'bge-host-'));
      await writeFile(join(outside, 'manifest.json'), '{}');
      await writeFile(join(outside, 'package.json'), '{}');

      try {
        await mkdir(join(pluginsRoot, 'demo-sink'), { recursive: true });
        await symlink(outside, join(pluginsRoot, 'demo-sink', SHA_A));

        const failure = await resolver.resolve('demo-sink', SHA_A).catch((err: unknown) => err);

        expect(failure).toBeInstanceOf(PluginDirectoryLayoutError);
        expect((failure as Error).message).toMatch(/resolves outside the configured plugin root/);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });

    it('refuses a slug directory that links out of the plugins root (#224)', async () => {
      const outside = await mkdtemp(join(tmpdir(), 'bge-host-'));
      await mkdir(join(outside, SHA_A), { recursive: true });
      await writeFile(join(outside, SHA_A, 'manifest.json'), '{}');
      await writeFile(join(outside, SHA_A, 'package.json'), '{}');

      try {
        await symlink(outside, join(pluginsRoot, 'demo-sink'));

        const failure = await resolver.resolve('demo-sink', SHA_A).catch((err: unknown) => err);

        expect(failure).toBeInstanceOf(PluginDirectoryLayoutError);
        expect((failure as Error).message).toMatch(/resolves outside the configured plugin root/);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });

    it("refuses an artifact directory linked to another slug's artifact inside the root (#224)", async () => {
      // Both stay inside the root, so containment alone would pass, and
      // plugin-b's code would load under plugin-a's row.
      await scaffold(pluginsRoot, 'plugin-b', ['manifest.json', 'package.json'], SHA_B);
      await mkdir(join(pluginsRoot, 'plugin-a'), { recursive: true });
      await symlink(join(pluginsRoot, 'plugin-b', SHA_B), join(pluginsRoot, 'plugin-a', SHA_A));

      const failure = await resolver.resolve('plugin-a', SHA_A).catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(PluginDirectoryLayoutError);
      expect((failure as Error).message).toMatch(/is a link to .*plugin-b/);
    });

    it("refuses a slug directory linked to another slug's directory inside the root (#224)", async () => {
      await scaffold(pluginsRoot, 'plugin-b', ['manifest.json', 'package.json'], SHA_A);
      await symlink(join(pluginsRoot, 'plugin-b'), join(pluginsRoot, 'plugin-a'));

      const failure = await resolver.resolve('plugin-a', SHA_A).catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(PluginDirectoryLayoutError);
      expect((failure as Error).message).toMatch(/is a link to .*plugin-b/);
    });

    it('rejects when the configured root itself cannot be resolved', async () => {
      const missingRootResolver = new PluginDirectoryResolverService(
        buildPluginModuleOptions({ pluginsRoot: join(pluginsRoot, 'does-not-exist') }),
      );

      await expect(missingRootResolver.resolve('demo-sink', SHA_A)).rejects.toThrow(
        /configured plugin root .* cannot be resolved/,
      );
    });
  });

  describe('confirm', () => {
    it('returns the resolved directory for the one its slug and checksum name (#224)', async () => {
      await scaffold(pluginsRoot, 'demo-sink', ['manifest.json', 'package.json']);
      const resolved = await resolver.resolve('demo-sink', SHA_A);

      await expect(resolver.confirm({ ...resolved })).resolves.toStrictEqual(resolved);
    });

    it('accepts the artifact directory spelled through a symlinked plugins root, returning its real paths (#224)', async () => {
      // A configured root behind a link (a bind mount, or macOS's /var →
      // /private/var) is one the loader resolves at boot, so a caller that
      // builds the path from the configured root names the right directory.
      const linkParent = await realpath(await mkdtemp(join(tmpdir(), 'bge-plugins-link-')));

      try {
        await scaffold(pluginsRoot, 'demo-sink', ['manifest.json', 'package.json']);
        const linkedRoot = join(linkParent, 'plugins');
        await symlink(pluginsRoot, linkedRoot);
        const linkedResolver = new PluginDirectoryResolverService({ ...options(), pluginsRoot: linkedRoot });
        const spelled = join(linkedRoot, 'demo-sink', SHA_A);
        const realDir = join(pluginsRoot, 'demo-sink', SHA_A);

        await expect(
          linkedResolver.confirm({
            slug: 'demo-sink',
            sha256: SHA_A,
            rootDir: spelled,
            manifestPath: join(spelled, 'manifest.json'),
            packageJsonPath: join(spelled, 'package.json'),
          }),
        ).resolves.toStrictEqual({
          slug: 'demo-sink',
          sha256: SHA_A,
          rootDir: realDir,
          manifestPath: join(realDir, 'manifest.json'),
          packageJsonPath: join(realDir, 'package.json'),
        });
      } finally {
        await rm(linkParent, { recursive: true, force: true });
      }
    });

    it('refuses a directory that is not where its checksum names, such as a temporary extraction directory (#224)', async () => {
      await scaffold(pluginsRoot, 'demo-sink', ['manifest.json', 'package.json']);
      // A real directory holding the same files, so the refusal is about
      // where it is, not that its path fails to resolve.
      const elsewhere = join(pluginsRoot, '.incoming', randomUUID());
      await mkdir(elsewhere, { recursive: true });
      await writeFile(join(elsewhere, 'manifest.json'), '{}');
      await writeFile(join(elsewhere, 'package.json'), '{}');

      const failure = await resolver
        .confirm({
          slug: 'demo-sink',
          sha256: SHA_A,
          rootDir: elsewhere,
          manifestPath: join(elsewhere, 'manifest.json'),
          packageJsonPath: join(elsewhere, 'package.json'),
        })
        .catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(PluginDirectoryLayoutError);
      expect((failure as Error).message).toMatch(/is not the artifact directory/);
    });

    it('refuses a checksum that is not 64 lowercase hex characters (#224)', async () => {
      const rootDir = join(pluginsRoot, 'demo-sink', SHA_A);

      await expect(
        resolver.confirm({
          slug: 'demo-sink',
          sha256: `sha256:${'A'.repeat(64)}` as unknown as PluginArtifactSha256,
          rootDir,
          manifestPath: join(rootDir, 'manifest.json'),
          packageJsonPath: join(rootDir, 'package.json'),
        }),
      ).rejects.toThrow(PluginDirectoryLayoutError);
    });
  });
});
