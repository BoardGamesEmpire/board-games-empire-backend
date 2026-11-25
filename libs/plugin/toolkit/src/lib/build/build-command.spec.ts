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
import { runNpm } from '../npm/run-npm.js';
import type { BuildOptions } from '../options.js';
import type { BuildOutcome, ReportItem } from '../report.js';
import type { PluginFixtureOptions } from '../testing/plugin-fixture.js';
import { writePluginFixture } from '../testing/plugin-fixture.js';
import { runBuild } from './build-command.js';

// Each build runs the plugin's own build script and a real npm ci, offline (#1093).
jest.setTimeout(120_000);

/** Every temporary folder the build makes, so each case can check it was removed (#1093). */
const mockBuildTempDirs: string[] = [];

/** While set, writing a checksum file fails as on a full disk (#1093). */
let mockFailChecksumWrite = false;

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
    writeFile: async (...args: Parameters<typeof actual.writeFile>): Promise<void> => {
      if (mockFailChecksumWrite && String(args[0]).endsWith('.tgz.sha256')) {
        throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC', syscall: 'write' });
      }

      return actual.writeFile(...args);
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

    it("leaves out npm's hidden lockfile, which records the plugin author's temporary folder, and SOURCES.md shows the file: dependency as local (#1093)", async () => {
      const intoDir = join(await mkdtemp(join(root, 'extracted-')), 'plugin');

      await extractPluginArchive(artifactPath, intoDir);

      expect((await readHeaders(artifactPath)).map((header) => header.name)).not.toContain(
        `${TOP_LEVEL}/node_modules/.package-lock.json`,
      );
      await expect(readFile(join(intoDir, 'SOURCES.md'), 'utf8')).resolves.toContain('| dep | 1.0.0 | MIT | local |');
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

    it('refuses a package.json holding a URL with a password, since it would ship in the plugin artifact, and never prints the password (#1093)', async () => {
      const pluginDir = await writePlugin({
        lockfile: true,
        packageJson: { repository: { type: 'git', url: 'https://alice:s3cr3t@git.example/demo-sink.git' } },
      });

      const outcome = await runBuild(pluginDir, optionsFor(pluginDir));

      expect(outcome.artifact).toBeUndefined();
      expect(outcome.report.errors).toEqual([
        { at: 'package.json', code: 'URL_CREDENTIALS_REFUSED', message: expect.stringContaining('"repository > url"') },
      ]);
      expect(JSON.stringify(outcome.report)).not.toContain('s3cr3t');
      expect(existsSync(join(pluginDir, 'bge-artifacts'))).toBe(false);
    });

    it('refuses a package-lock.json holding a URL with a password before npm ci reads it, so npm never fetches with it (#1093)', async () => {
      // The host does not resolve: had npm ci run, the build would fail as DEPENDENCY_INSTALL_FAILED.
      const resolved = 'https://alice:s3cr3t@registry.invalid/dep/-/dep-1.0.0.tgz';
      const pluginDir = await writePlugin({ packageJson: { dependencies: { dep: '1.0.0' } } });
      await writeFile(
        join(pluginDir, 'package-lock.json'),
        JSON.stringify({
          lockfileVersion: 3,
          name: 'demo-sink',
          packages: {
            '': { dependencies: { dep: '1.0.0' }, name: 'demo-sink', version: '1.2.0' },
            'node_modules/dep': { license: 'MIT', resolved, version: '1.0.0' },
          },
          requires: true,
          version: '1.2.0',
        }),
      );

      const outcome = await runBuild(pluginDir, optionsFor(pluginDir));

      expect(outcome.artifact).toBeUndefined();
      expect(outcome.report.errors).toEqual([
        {
          at: 'package-lock.json',
          code: 'URL_CREDENTIALS_REFUSED',
          message: expect.stringContaining('"packages > node_modules/dep > resolved"'),
        },
      ]);
      expect(JSON.stringify(outcome.report)).not.toContain('s3cr3t');
      expect(existsSync(join(pluginDir, 'bge-artifacts'))).toBe(false);
    });
  });

  it('removes an earlier checksum file before the new plugin artifact lands, so a failed checksum write leaves no stale one beside it (#1093)', async () => {
    const pluginDir = await writePlugin({ lockfile: true });
    const outDir = join(pluginDir, 'bge-artifacts');
    await mkdir(outDir);
    await writeFile(join(outDir, `${ARTIFACT}.sha256`), `${'0'.repeat(64)}  ${ARTIFACT}\n`);
    mockFailChecksumWrite = true;

    try {
      await expect(runBuild(pluginDir, optionsFor(pluginDir))).rejects.toMatchObject({ code: 'ENOSPC' });
    } finally {
      mockFailChecksumWrite = false;
    }

    expect(existsSync(join(outDir, ARTIFACT))).toBe(true);
    expect(existsSync(join(outDir, `${ARTIFACT}.sha256`))).toBe(false);
  });

  describe('a plugin that cannot be built', () => {
    it('refuses a plugin without package-lock.json as LOCKFILE_MISSING, before running its build', async () => {
      const pluginDir = await writePlugin({ packageJson: { scripts: { build: 'node -e "process.exit(3)"' } } });

      await expect(runBuild(pluginDir, optionsFor(pluginDir))).rejects.toMatchObject({ code: 'LOCKFILE_MISSING' });
    });

    it.each([
      ['from npm 6', `${JSON.stringify({ dependencies: {}, lockfileVersion: 1, name: 'demo-sink' })}\n`, 'npm 7'],
      ['that is not JSON', '{ "lockfileVersion": ', 'not valid JSON'],
    ])(
      "refuses a package-lock.json %s as LOCKFILE_UNSUPPORTED at that file, before running the plugin's build (#1093)",
      async (_name, lockfile, said) => {
        const pluginDir = await writePlugin({
          files: { 'package-lock.json': lockfile },
          packageJson: { scripts: { build: 'node -e "process.exit(3)"' } },
        });

        await expect(runBuild(pluginDir, optionsFor(pluginDir))).rejects.toMatchObject({
          at: 'package-lock.json',
          code: 'LOCKFILE_UNSUPPORTED',
          message: expect.stringContaining(said),
        });
      },
    );

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
