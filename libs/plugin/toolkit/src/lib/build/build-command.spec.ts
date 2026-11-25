import { extractPluginArchive } from '@boardgamesempire/plugin-analysis';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import type { Header } from 'tar-stream';
import { extract } from 'tar-stream';
import type { BuildOptions, BuildOutcome } from '../cli.js';
import { runNpm } from '../npm/run-npm.js';
import type { ReportItem } from '../report.js';
import type { PluginFixtureOptions } from '../testing/plugin-fixture.js';
import { writePluginFixture } from '../testing/plugin-fixture.js';
import { runBuild } from './build-command.js';

// Each build runs the plugin's own build script and a real npm ci, offline (#1093).
jest.setTimeout(120_000);

/** Every temporary folder the build makes, so each case can check it was removed (#1093). */
const mockBuildTempDirs: string[] = [];

jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof import('node:fs/promises')>('node:fs/promises');
  const path = jest.requireActual<typeof import('node:path')>('node:path');

  return {
    ...actual,
    mkdtemp: async (prefix: string): Promise<string> => {
      const dir = await actual.mkdtemp(prefix);

      if (path.basename(prefix).startsWith('bge-plugin-')) {
        mockBuildTempDirs.push(dir);
      }

      return dir;
    },
  };
});

const TOP_LEVEL = 'demo-sink-1.2.0';
const ARTIFACT = `${TOP_LEVEL}.tgz`;
const SOURCE_DATE_EPOCH = '1700000000';

/** The plugin's own build writes `dist/index.js`, so the plugin artifact shows the build ran. */
const BUILD_SCRIPT = `import { mkdirSync, writeFileSync } from 'node:fs';

mkdirSync('dist', { recursive: true });
writeFileSync('dist/index.js', "// Written by the plugin's own build script.\\nexport const activate = () => undefined;\\n");
`;

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

const codes = (items: readonly ReportItem[]): string[] => items.map((item) => item.code);

/** Every header in a gzip-compressed tar, read with tar-stream, in archive order. */
const readHeaders = async (file: string): Promise<Header[]> => {
  const tar = extract();
  const headers: Header[] = [];
  const reading = pipeline(createReadStream(file), createGunzip(), tar);

  for await (const entry of tar) {
    headers.push(entry.header);
    entry.resume();
  }

  await reading;

  return headers;
};

describe('runBuild (#1093)', () => {
  let root: string;
  let depArtifact: string;
  let savedSourceDateEpoch: string | undefined;

  const optionsFor = (pluginDir: string): BuildOptions => ({
    acceptImports: [],
    bgeVersion: '1.0.0',
    defaultLocale: 'en',
    outDir: join(pluginDir, 'bge-artifacts'),
  });

  /** A fixture plugin, with package-lock.json recorded by npm itself when `recordLockfile` is set. */
  const writePlugin = async (options: PluginFixtureOptions, recordLockfile = false): Promise<string> => {
    const pluginDir = await writePluginFixture(root, options);

    if (recordLockfile) {
      await runNpm(['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], pluginDir);
    }

    return pluginDir;
  };

  beforeAll(async () => {
    savedSourceDateEpoch = process.env['SOURCE_DATE_EPOCH'];
    root = await mkdtemp(join(tmpdir(), 'bge-build-command-spec-'));

    // A dependency with a bin, packed by npm so the plugin can name it by an
    // absolute path; everything stays offline (#1093).
    const depDir = join(root, 'dep');
    await mkdir(join(depDir, 'bin'), { recursive: true });
    await writeFile(
      join(depDir, 'package.json'),
      JSON.stringify({ bin: { dep: 'bin/dep.js' }, license: 'MIT', main: 'index.js', name: 'dep', version: '1.0.0' }),
    );
    await writeFile(join(depDir, 'index.js'), 'module.exports = 1;\n');
    await writeFile(join(depDir, 'bin', 'dep.js'), '#!/usr/bin/env node\nconsole.log(1);\n');
    await runNpm(['pack', '--ignore-scripts'], depDir);
    depArtifact = join(depDir, 'dep-1.0.0.tgz');
  });

  afterEach(() => {
    if (savedSourceDateEpoch === undefined) {
      delete process.env['SOURCE_DATE_EPOCH'];
    } else {
      process.env['SOURCE_DATE_EPOCH'] = savedSourceDateEpoch;
    }

    for (const dir of mockBuildTempDirs) {
      expect(existsSync(dir)).toBe(false);
    }
  });

  afterAll(async () => {
    await rm(root, { force: true, recursive: true });
  });

  describe('a plugin that passes every check', () => {
    let pluginDir: string;
    let outcome: BuildOutcome;
    let artifactPath: string;

    beforeAll(async () => {
      // No files field, so npm's selection would take in the default output
      // folder inside the plugin's folder: the second build below shows the
      // build leaves it out (#1093). `.npmignore` keeps the build script out.
      pluginDir = await writePlugin(
        {
          files: { '.npmignore': 'scripts/\n', 'scripts/build.mjs': BUILD_SCRIPT },
          packageJson: {
            dependencies: { dep: `file:${depArtifact}` },
            files: undefined,
            scripts: { build: 'node scripts/build.mjs' },
          },
        },
        true,
      );
      process.env['SOURCE_DATE_EPOCH'] = SOURCE_DATE_EPOCH;
      outcome = await runBuild(pluginDir, optionsFor(pluginDir));
      artifactPath = join(pluginDir, 'bge-artifacts', ARTIFACT);
    });

    it('writes <slug>-<version>.tgz and a checksum file sha256sum can check', async () => {
      const bytes = await readFile(artifactPath);

      expect(outcome.report.errors).toEqual([]);
      expect(outcome.artifact).toEqual({
        path: artifactPath,
        sha256: sha256(bytes),
        sidecarPath: `${artifactPath}.sha256`,
      });
      expect((await readdir(join(pluginDir, 'bge-artifacts'))).sort()).toEqual([ARTIFACT, `${ARTIFACT}.sha256`]);
      await expect(readFile(`${artifactPath}.sha256`, 'utf8')).resolves.toBe(`${sha256(bytes)}  ${ARTIFACT}\n`);
    });

    it("is accepted by the server's own extractor, with its dependency installed and listed, and no .bin links", async () => {
      const intoDir = join(await mkdtemp(join(root, 'extracted-')), 'plugin');

      await extractPluginArchive(artifactPath, intoDir);

      expect(existsSync(join(intoDir, 'node_modules', 'dep', 'package.json'))).toBe(true);
      expect(existsSync(join(intoDir, 'node_modules', '.bin'))).toBe(false);
      await expect(readFile(join(intoDir, 'SOURCES.md'), 'utf8')).resolves.toContain('| dep | 1.0.0 | MIT |');
      await expect(readFile(join(intoDir, 'dist', 'index.js'), 'utf8')).resolves.toContain(
        "Written by the plugin's own build script.",
      );
    });

    it('puts every entry under the one top-level folder, none of them a link, with the mtime SOURCE_DATE_EPOCH gives', async () => {
      const headers = await readHeaders(artifactPath);

      expect(headers.length).toBeGreaterThan(1);

      for (const header of headers) {
        expect(header.name.startsWith(`${TOP_LEVEL}/`)).toBe(true);
        expect(['directory', 'file']).toContain(header.type);
        expect(header.mtime.getTime() / 1000).toBe(Number(SOURCE_DATE_EPOCH));
      }
    });

    it('writes the same bytes on a second build into the same folder, which packs none of the earlier output', async () => {
      const firstBytes = await readFile(artifactPath);
      process.env['SOURCE_DATE_EPOCH'] = SOURCE_DATE_EPOCH;

      const second = await runBuild(pluginDir, optionsFor(pluginDir));

      expect(second.report).toEqual(outcome.report);
      expect(codes(second.report.warnings)).not.toContain('PLUGIN_ARTIFACT_LEFT_OUT');
      expect(second.artifact?.sha256).toBe(outcome.artifact?.sha256);
      expect((await readFile(artifactPath)).equals(firstBytes)).toBe(true);
    });
  });

  describe('a plugin the server would refuse', () => {
    it('returns the report with no plugin artifact, and writes nothing, for a forbidden import', async () => {
      const pluginDir = await writePlugin({
        indexJs: "import axios from 'axios';\nexport const activate = () => axios;\n",
        lockfile: true,
      });

      const outcome = await runBuild(pluginDir, optionsFor(pluginDir));

      expect(outcome.artifact).toBeUndefined();
      expect(outcome.report.errors).toEqual([
        { at: 'dist/index.js', code: 'esm-import', message: expect.stringContaining('"axios"') },
      ]);
      expect(existsSync(join(pluginDir, 'bge-artifacts'))).toBe(false);
    });
  });

  describe('a plugin that cannot be built', () => {
    it('refuses a plugin without package-lock.json as LOCKFILE_MISSING, before running its build', async () => {
      const pluginDir = await writePlugin({ packageJson: { scripts: { build: 'node -e "process.exit(3)"' } } });

      await expect(runBuild(pluginDir, optionsFor(pluginDir))).rejects.toMatchObject({ code: 'LOCKFILE_MISSING' });
    });

    it("reports a failing build script as PLUGIN_BUILD_FAILED, with the script's last words", async () => {
      const pluginDir = await writePlugin({
        lockfile: true,
        packageJson: { scripts: { build: 'echo the build broke >&2 && exit 3' } },
      });

      await expect(runBuild(pluginDir, optionsFor(pluginDir))).rejects.toMatchObject({
        code: 'PLUGIN_BUILD_FAILED',
        message: expect.stringContaining('the build broke'),
      });
      expect(existsSync(join(pluginDir, 'bge-artifacts'))).toBe(false);
    });

    it('explains that a dependency named by a relative file: path cannot be installed into the plugin artifact', async () => {
      // `../dep` resolves from the plugin's folder, so npm records it; the
      // build installs from a copy in a temporary folder, where it does not
      // (#1093). A known limit, which the README states.
      const pluginDir = await writePlugin({ packageJson: { dependencies: { dep: 'file:../dep' } } }, true);

      const failure = await runBuild(pluginDir, optionsFor(pluginDir)).catch((error: unknown) => error);

      expect(failure).toMatchObject({ code: 'DEPENDENCY_INSTALL_FAILED' });
      expect(failure).toMatchObject({ message: expect.stringContaining('relative file: path') });
      expect(failure).toMatchObject({ message: expect.stringContaining('absolute path') });
      expect(failure).toMatchObject({ message: expect.stringContaining('.tgz') });
      expect(existsSync(join(pluginDir, 'bge-artifacts'))).toBe(false);
    });
  });

  // Runs last, after every build above that got as far as staging its files.
  it('removes its temporary folder after every build, written or refused', () => {
    expect(mockBuildTempDirs.length).toBeGreaterThan(0);
    expect(mockBuildTempDirs.filter((dir) => existsSync(dir))).toEqual([]);
  });
});
