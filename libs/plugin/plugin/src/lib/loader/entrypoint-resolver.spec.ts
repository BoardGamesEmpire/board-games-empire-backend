import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { assertResolvedEntrypointContained, resolvePluginEntrypoint } from './entrypoint-resolver';
import { PluginEntrypointError } from './loader.errors';

describe('resolvePluginEntrypoint', () => {
  const slug = 'demo-plugin';
  const rootDir = resolve(sep, 'srv', 'bge', 'plugins', slug);

  describe('exports-first resolution', () => {
    it('resolves a string exports field', () => {
      const entry = resolvePluginEntrypoint(slug, { exports: './dist/index.js' }, rootDir);

      expect(entry).toBe(join(rootDir, 'dist', 'index.js'));
    });

    it('resolves the root subpath of a subpath map', () => {
      const entry = resolvePluginEntrypoint(
        slug,
        { exports: { '.': './dist/index.js', './package.json': './package.json' } },
        rootDir,
      );

      expect(entry).toBe(join(rootDir, 'dist', 'index.js'));
    });

    it("resolves a condition map preferring 'import'", () => {
      const entry = resolvePluginEntrypoint(
        slug,
        { exports: { import: './dist/index.mjs', default: './dist/index.cjs' } },
        rootDir,
      );

      expect(entry).toBe(join(rootDir, 'dist', 'index.mjs'));
    });

    it("falls through to 'default' when 'import' and 'node' are absent", () => {
      const entry = resolvePluginEntrypoint(slug, { exports: { default: './dist/index.js' } }, rootDir);

      expect(entry).toBe(join(rootDir, 'dist', 'index.js'));
    });

    it('resolves conditions nested under the root subpath', () => {
      const entry = resolvePluginEntrypoint(
        slug,
        { exports: { '.': { import: './dist/index.mjs', default: './dist/index.cjs' } } },
        rootDir,
      );

      expect(entry).toBe(join(rootDir, 'dist', 'index.mjs'));
    });

    it('walks array alternatives to the first resolvable entry', () => {
      const entry = resolvePluginEntrypoint(
        slug,
        { exports: [{ require: './dist/index.cjs' }, './dist/index.js'] },
        rootDir,
      );

      expect(entry).toBe(join(rootDir, 'dist', 'index.js'));
    });

    it('treats a null root subpath as unresolvable', () => {
      expect(() => resolvePluginEntrypoint(slug, { exports: { '.': null } }, rootDir)).toThrow(PluginEntrypointError);
    });

    it("rejects a subpath map without a root ('.') entry", () => {
      expect(() => resolvePluginEntrypoint(slug, { exports: { './feature': './dist/feature.js' } }, rootDir)).toThrow(
        PluginEntrypointError,
      );
    });

    it('rejects a condition map with only unhonored conditions', () => {
      expect(() => resolvePluginEntrypoint(slug, { exports: { require: './dist/index.cjs' } }, rootDir)).toThrow(
        PluginEntrypointError,
      );
    });

    it("prefers 'exports' over 'main' when both are present", () => {
      const entry = resolvePluginEntrypoint(
        slug,
        { exports: './dist/from-exports.js', main: './dist/from-main.js' },
        rootDir,
      );

      expect(entry).toBe(join(rootDir, 'dist', 'from-exports.js'));
    });
  });

  describe('main fallback', () => {
    it("resolves 'main' when 'exports' is absent", () => {
      const entry = resolvePluginEntrypoint(slug, { main: 'dist/index.js' }, rootDir);

      expect(entry).toBe(join(rootDir, 'dist', 'index.js'));
    });

    it('rejects a descriptor with neither exports nor main', () => {
      expect(() => resolvePluginEntrypoint(slug, {}, rootDir)).toThrow(PluginEntrypointError);
    });

    it('rejects an empty-string main', () => {
      expect(() => resolvePluginEntrypoint(slug, { main: '' }, rootDir)).toThrow(PluginEntrypointError);
    });
  });

  describe('containment', () => {
    it('rejects an entrypoint that traverses out of the plugin directory', () => {
      expect(() => resolvePluginEntrypoint(slug, { main: '../../../etc/anything.js' }, rootDir)).toThrow(
        PluginEntrypointError,
      );
    });

    it('rejects an absolute-path entrypoint', () => {
      expect(() => resolvePluginEntrypoint(slug, { main: resolve(sep, 'etc', 'anything.js') }, rootDir)).toThrow(
        PluginEntrypointError,
      );
    });

    it('rejects an entrypoint resolving to the root itself', () => {
      expect(() => resolvePluginEntrypoint(slug, { main: '.' }, rootDir)).toThrow(PluginEntrypointError);
    });

    it('accepts an interior path that merely CONTAINS dot-dot segments while staying inside the root', () => {
      const entry = resolvePluginEntrypoint(slug, { main: './dist/../dist/index.js' }, rootDir);

      expect(entry).toBe(join(rootDir, 'dist', 'index.js'));
    });
  });

  describe('assertResolvedEntrypointContained (symlink-aware)', () => {
    let workDir: string;
    let pluginDir: string;

    beforeEach(async () => {
      workDir = await realpath(await mkdtemp(join(tmpdir(), 'bge-entry-')));
      pluginDir = join(workDir, 'plugin');
      await mkdir(join(pluginDir, 'dist'), { recursive: true });
    });

    afterEach(async () => {
      await rm(workDir, { recursive: true, force: true });
    });

    it('returns the real path of a regular file inside the root', async () => {
      const entry = join(pluginDir, 'dist', 'index.js');
      await writeFile(entry, '// entry');

      await expect(assertResolvedEntrypointContained(slug, entry, pluginDir)).resolves.toBe(entry);
    });

    it('accepts a symlink that stays inside the plugin root', async () => {
      const target = join(pluginDir, 'dist', 'index.js');
      await writeFile(target, '// entry');
      const link = join(pluginDir, 'entry-link.js');
      await symlink(target, link);

      await expect(assertResolvedEntrypointContained(slug, link, pluginDir)).resolves.toBe(target);
    });

    it('rejects an entrypoint whose real location escapes the root through a symlinked directory', async () => {
      // dist-link -> a directory OUTSIDE the plugin root; the lexical path
      // `<root>/dist-link/outside.js` passes pure path arithmetic.
      const outside = join(workDir, 'outside');
      await mkdir(outside, { recursive: true });
      await writeFile(join(outside, 'outside.js'), '// smuggled');
      await symlink(outside, join(pluginDir, 'dist-link'));

      await expect(
        assertResolvedEntrypointContained(slug, join(pluginDir, 'dist-link', 'outside.js'), pluginDir),
      ).rejects.toThrow(/resolves outside the plugin directory/);
    });

    it('rejects a file symlink pointing out of the root', async () => {
      const outsideFile = join(workDir, 'host-file.js');
      await writeFile(outsideFile, '// host');
      const link = join(pluginDir, 'dist', 'index.js');
      await symlink(outsideFile, link);

      await expect(assertResolvedEntrypointContained(slug, link, pluginDir)).rejects.toThrow(
        /resolves outside the plugin directory/,
      );
    });

    it('rejects a missing entrypoint with a plugin-attributed error', async () => {
      await expect(
        assertResolvedEntrypointContained(slug, join(pluginDir, 'dist', 'absent.js'), pluginDir),
      ).rejects.toThrow(/does not exist/);
    });
  });
});
