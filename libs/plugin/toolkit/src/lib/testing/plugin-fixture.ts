import type { PluginManifestOverrides } from '@boardgamesempire/plugin-manifest';
import { buildPluginManifest } from '@boardgamesempire/plugin-manifest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface PluginFixtureOptions {
  /** Extra files by path relative to the plugin folder, written last so they can replace any file above. */
  readonly files?: Readonly<Record<string, string>>;

  /** The code of `dist/index.js`. */
  readonly indexJs?: string;

  /** Writes a `package-lock.json` for the plugin's `package.json`, as `npm install` would. */
  readonly lockfile?: boolean;

  /**
   * The plugin manifest: overrides on `buildPluginManifest`'s valid baseline,
   * or the exact text of `manifest.json` when a spec needs one that is not
   * JSON or not an object.
   */
  readonly manifest?: PluginManifestOverrides | string;

  /** Fields merged over the generated `package.json`. */
  readonly packageJson?: Readonly<Record<string, unknown>>;
}

/**
 * The baseline's `bgeCompat` with the lowest bound a version stamp can have,
 * so the fixture passes against any `--bge-version`, the `0.0.0` a workspace
 * build stamps included (#1093).
 */
const ANY_BGE_VERSION = '>=0.0.0';

/**
 * For tests (#1093): writes a plugin folder into a new folder under
 * `parentDir` and returns its path. By default it is a plugin that passes
 * every check: a `package.json` whose `files` field selects `dist`, a valid
 * plugin manifest and a `dist/index.js` with no imports. Put `parentDir` under
 * the OS temp folder, never in the repo: npm walks up to the nearest
 * `package.json`, so a fixture inside the workspace could be judged as the
 * workspace itself.
 */
export const writePluginFixture = async (parentDir: string, options: PluginFixtureOptions = {}): Promise<string> => {
  const pluginDir = await mkdtemp(join(parentDir, 'fixture-'));
  const manifest =
    typeof options.manifest === 'string'
      ? undefined
      : buildPluginManifest({ bgeCompat: ANY_BGE_VERSION, ...options.manifest });
  const name = manifest?.slug ?? 'demo-sink';
  const version = manifest?.version ?? '1.2.0';
  const packageJson = {
    files: ['dist'],
    main: 'dist/index.js',
    name,
    type: 'module',
    version,
    ...options.packageJson,
  };
  const files: Record<string, string> = {
    'dist/index.js': options.indexJs ?? 'export const activate = () => undefined;\n',
    'manifest.json': typeof options.manifest === 'string' ? options.manifest : `${JSON.stringify(manifest, null, 2)}\n`,
    'package.json': `${JSON.stringify(packageJson, null, 2)}\n`,
  };

  if (options.lockfile === true) {
    files['package-lock.json'] = `${JSON.stringify(
      { lockfileVersion: 3, name, packages: { '': { name, version } }, requires: true, version },
      null,
      2,
    )}\n`;
  }

  for (const [path, content] of Object.entries({ ...files, ...options.files })) {
    await mkdir(dirname(join(pluginDir, path)), { recursive: true });
    await writeFile(join(pluginDir, path), content);
  }

  return pluginDir;
};
