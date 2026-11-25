import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { NpmCommandError } from '../npm/run-npm.js';
import { ToolkitError } from '../toolkit.errors.js';
import { npmPackFailure, selectPluginFiles } from './select-plugin-files.js';

// Every case spawns a real npm, offline: give it room on a slow runner (#1093).
const NPM_TIMEOUT = 60_000;

/**
 * Fixtures live under the OS temp directory, never in the repo: npm walks up
 * to the nearest package.json, so a fixture inside the workspace could be
 * judged as the workspace itself (#1093).
 */
const writeProject = async (root: string, files: Readonly<Record<string, string>>): Promise<string> => {
  const projectDir = await mkdtemp(join(root, 'plugin-'));

  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(projectDir, path)), { recursive: true });
    await writeFile(join(projectDir, path), content);
  }

  return projectDir;
};

const packageJson = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ name: 'dice-tools', version: '1.0.0', ...extra });

/**
 * Run through `npm run nx`, the child npm inherits the parent npm's variables
 * naming the workspace root (`npm_config_local_prefix`, `npm_package_json`).
 * Every selection below is the fixture's own, so npm judged the folder it ran
 * in, not the project that launched it (#1093).
 */
describe('selectPluginFiles (#1093)', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'bge-select-plugin-files-'));
  });

  afterAll(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it(
    "takes npm's selection for a files field, and adds manifest.json and package-lock.json, which npm leaves out",
    async () => {
      const projectDir = await writeProject(root, {
        'dist/index.js': 'export {};\n',
        'manifest.json': '{}\n',
        'package-lock.json': '{}\n',
        'package.json': packageJson({ files: ['dist'] }),
        'src/index.ts': 'export {};\n',
      });

      await expect(selectPluginFiles(projectDir, {})).resolves.toEqual({
        files: ['dist/index.js', 'manifest.json', 'package-lock.json', 'package.json'],
        leftOut: [],
      });
    },
    NPM_TIMEOUT,
  );

  it(
    'leaves out earlier plugin artifacts in the output folder and stray .tgz files elsewhere, naming only the stray ones',
    async () => {
      const projectDir = await writeProject(root, {
        'bge-artifacts/notes.txt': 'kept out with its folder\n',
        'bge-artifacts/x-1.0.0.tgz': 'not really gzip\n',
        'bge-artifacts/x-1.0.0.tgz.sha256': 'ab  x-1.0.0.tgz\n',
        'index.js': 'export {};\n',
        'manifest.json': '{}\n',
        'old.tgz': 'not really gzip\n',
        'old.tgz.sha256': 'ab  old.tgz\n',
        'package.json': packageJson(),
      });

      await expect(selectPluginFiles(projectDir, { excludeDir: 'bge-artifacts' })).resolves.toEqual({
        files: ['index.js', 'manifest.json', 'package.json'],
        leftOut: ['old.tgz', 'old.tgz.sha256'],
      });
    },
    NPM_TIMEOUT,
  );

  it(
    'names a .tgz the plugin ships among its files as left out, so the plugin author can rename it',
    async () => {
      // Dropped silently, the file would be missing at runtime (#1093).
      const projectDir = await writeProject(root, {
        'assets/fixture.tgz': 'a real asset\n',
        'index.js': 'export {};\n',
        'package.json': packageJson(),
      });

      await expect(selectPluginFiles(projectDir, { excludeDir: 'bge-artifacts' })).resolves.toEqual({
        files: ['index.js', 'package.json'],
        leftOut: ['assets/fixture.tgz'],
      });
    },
    NPM_TIMEOUT,
  );

  it(
    'matches excludeDir as a whole folder name, not as a prefix of another',
    async () => {
      const projectDir = await writeProject(root, {
        'out/a.js': 'export {};\n',
        'out/a.tgz': 'old build\n',
        'out-of-scope/b.js': 'export {};\n',
        'package.json': packageJson(),
      });

      await expect(selectPluginFiles(projectDir, { excludeDir: 'out/' })).resolves.toEqual({
        files: ['out-of-scope/b.js', 'package.json'],
        leftOut: [],
      });
    },
    NPM_TIMEOUT,
  );

  it(
    "never runs the plugin's lifecycle scripts while listing its files",
    async () => {
      const projectDir = await writeProject(root, {
        'index.js': 'export {};\n',
        'package.json': packageJson({
          scripts: {
            prepack: "node -e \"require('fs').writeFileSync('PREPACK_RAN', '')\"",
            prepare: "node -e \"require('fs').writeFileSync('PREPARE_RAN', '')\"",
          },
        }),
      });

      const selected = await selectPluginFiles(projectDir, {});

      expect(selected.files).toEqual(['index.js', 'package.json']);
      // Neither script left its marker file behind.
      expect((await readdir(projectDir)).sort()).toEqual(['index.js', 'package.json']);
    },
    NPM_TIMEOUT,
  );

  it(
    "reports NPM_PACK_FAILED with npm's own words when the folder's package.json is not valid JSON",
    async () => {
      const projectDir = await writeProject(root, { 'manifest.json': '{}\n', 'package.json': '{ not json' });

      const failure = await selectPluginFiles(projectDir, {}).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ToolkitError);
      expect(failure).toMatchObject({
        at: undefined,
        code: 'NPM_PACK_FAILED',
        message: expect.stringMatching(
          /^npm could not list the plugin's files \(npm pack --dry-run\)\. Check that the folder holds a valid package\.json\.[\s\S]*EJSONPARSE/,
        ),
      });
    },
    NPM_TIMEOUT,
  );

  it(
    "refuses a folder without its own package.json instead of listing an ancestor project's files",
    async () => {
      // npm walks up to the nearest package.json; the parent's files must never be listed (#1093).
      const parentDir = await writeProject(root, {
        'package.json': packageJson(),
        'parent-only.js': 'export {};\n',
      });
      const projectDir = join(parentDir, 'nested-plugin');
      await mkdir(projectDir);
      await writeFile(join(projectDir, 'manifest.json'), '{}\n');

      const failure = await selectPluginFiles(projectDir, {}).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ToolkitError);
      expect(failure).toMatchObject({ at: undefined, code: 'NPM_PACK_FAILED' });
      expect((failure as ToolkitError).message).toContain('There is no package.json in');
      expect((failure as ToolkitError).message).not.toContain('parent-only.js');
    },
    NPM_TIMEOUT,
  );

  it(
    'refuses a package.json that is a folder',
    async () => {
      const parentDir = await writeProject(root, { 'package.json': packageJson() });
      const projectDir = join(parentDir, 'nested-plugin');
      await mkdir(join(projectDir, 'package.json'), { recursive: true });

      await expect(selectPluginFiles(projectDir, {})).rejects.toMatchObject({
        code: 'NPM_PACK_FAILED',
        message: expect.stringContaining('There is no package.json in'),
      });
    },
    NPM_TIMEOUT,
  );
});

describe('npmPackFailure (#1093)', () => {
  const args = ['pack', '--dry-run', '--json', '--ignore-scripts'];

  it('says npm could not be run, with the reason, when npm never started or was cut off', () => {
    // spawn ENOENT or an overrun output buffer: the package.json is not the
    // problem, so the plugin author is not sent to look at it.
    const failure = npmPackFailure(new NpmCommandError(args, 'spawn npm ENOENT', null));

    expect(failure).toMatchObject({ code: 'NPM_PACK_FAILED' });
    expect(failure.message).toBe(
      "npm could not list the plugin's files (npm pack --dry-run). npm could not be run: spawn npm ENOENT",
    );
  });

  it('points at package.json and quotes npm when npm ran and failed', () => {
    const failure = npmPackFailure(new NpmCommandError(args, 'npm error code EJSONPARSE\n', 1));

    expect(failure.message).toBe(
      "npm could not list the plugin's files (npm pack --dry-run). Check that the folder holds a valid package.json. npm said:\nnpm error code EJSONPARSE",
    );
  });
});
