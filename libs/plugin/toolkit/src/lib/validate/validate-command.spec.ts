import type { PluginTarballEntry } from '@boardgamesempire/plugin-analysis';
import { buildPluginTarball } from '@boardgamesempire/plugin-analysis';
import { buildPluginManifest, PLUGIN_ARCHIVE_MAX_COMPRESSED_BYTES } from '@boardgamesempire/plugin-manifest';
import { access, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { runCli } from '../cli.js';
import type { ValidateOptions } from '../options.js';
import type { ReportItem } from '../report.js';
import { writePluginFixture } from '../testing/plugin-fixture.js';
import { runValidate } from './validate-command.js';

// Directory cases spawn a real npm, offline: give it room on a slow runner (#1093).
const NPM_TIMEOUT = 60_000;

const OPTIONS: ValidateOptions = { acceptImports: [], bgeVersion: '1.0.0', defaultLocale: 'en' };

/**
 * Every folder `mkdtemp` makes is recorded, so a case can check that the
 * command removed the ones it made. Listing the shared OS temp folder instead
 * would also see another Jest worker's live folders (#1093).
 */
jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual('node:fs/promises');
  return { ...actual, mkdtemp: jest.fn(actual.mkdtemp) };
});

const codes = (items: readonly ReportItem[]): string[] => items.map((item) => item.code);

/** The `bge-plugin-` folders the command made since the mock was last cleared. */
const commandTempDirs = async (): Promise<string[]> => {
  const made: unknown[] = await Promise.all(jest.mocked(mkdtemp).mock.results.map((result) => result.value));

  return made.filter((path): path is string => typeof path === 'string' && basename(path).startsWith('bge-plugin-'));
};

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

const MANIFEST = JSON.stringify(buildPluginManifest({ bgeCompat: '>=0.0.0' }));
const PACKAGE_JSON = JSON.stringify({ main: 'dist/index.js', name: 'demo-sink', type: 'module', version: '1.2.0' });

/** The entries of a plugin artifact that passes every check, under `demo-sink-1.2.0/`. */
const PLUGIN_ENTRIES: readonly PluginTarballEntry[] = [
  { name: 'demo-sink-1.2.0/', type: 'directory' },
  { content: 'export const activate = () => undefined;\n', name: 'demo-sink-1.2.0/dist/index.js' },
  { content: MANIFEST, name: 'demo-sink-1.2.0/manifest.json' },
  { content: PACKAGE_JSON, name: 'demo-sink-1.2.0/package.json' },
];

describe('runValidate (#1093)', () => {
  let root: string;

  beforeAll(async () => {
    // Not `bge-plugin-`: that prefix is the command's own, which these cases count.
    root = await mkdtemp(join(tmpdir(), 'bge-validate-command-spec-'));
  });

  afterAll(async () => {
    await rm(root, { force: true, recursive: true });
  });

  beforeEach(() => {
    jest.mocked(mkdtemp).mockClear();
  });

  afterEach(async () => {
    const left: string[] = [];

    for (const path of await commandTempDirs()) {
      if (await exists(path)) {
        left.push(path);
      }
    }

    expect(left).toEqual([]);
  });

  const writeArtifact = async (entries: readonly PluginTarballEntry[]): Promise<string> => {
    const path = join(await mkdtemp(join(root, 'artifact-')), 'demo-sink-1.2.0.tgz');
    await writeFile(path, await buildPluginTarball(entries));

    return path;
  };

  describe('a plugin folder', () => {
    it(
      'passes the fixture plugin with only the notes on what it cannot check',
      async () => {
        const report = await runValidate(await writePluginFixture(root, { lockfile: true }), OPTIONS);

        expect(report.errors).toEqual([]);
        expect(report.warnings).toEqual([]);
        expect(codes(report.notes).sort()).toEqual(
          ['CONSENT_COMPARISON_SKIPPED', 'NOT_CHECKED_BEYOND_SCAN', 'NOT_CHECKED_PERMISSION_CATALOG'].sort(),
        );
      },
      NPM_TIMEOUT,
    );

    it(
      'judges only the files its plugin artifact would hold: a forbidden import in a script the files field leaves out is not reported',
      async () => {
        const pluginDir = await writePluginFixture(root, {
          files: { 'scripts/dev.js': "import axios from 'axios';\nexport default axios;\n" },
        });

        const report = await runValidate(pluginDir, OPTIONS);

        expect(report.errors).toEqual([]);
      },
      NPM_TIMEOUT,
    );

    it(
      'reports the same forbidden import once the files field selects it',
      async () => {
        const pluginDir = await writePluginFixture(root, {
          files: { 'scripts/dev.js': "import axios from 'axios';\nexport default axios;\n" },
          packageJson: { files: ['dist', 'scripts'] },
        });

        const report = await runValidate(pluginDir, OPTIONS);

        expect(report.errors).toEqual([
          { at: 'scripts/dev.js', code: 'esm-import', message: expect.stringContaining('"axios"') },
        ]);
      },
      NPM_TIMEOUT,
    );

    it(
      'fails a package-lock.json holding a URL with a password, as build would refuse it (#1093)',
      async () => {
        const pluginDir = await writePluginFixture(root, {
          files: {
            'package-lock.json': JSON.stringify({
              lockfileVersion: 3,
              packages: {
                '': { name: 'demo-sink', version: '1.2.0' },
                'node_modules/dep': {
                  resolved: 'http://alice:s3cr3t@registry.example/dep-1.0.0.tgz',
                  version: '1.0.0',
                },
              },
            }),
          },
        });

        const report = await runValidate(pluginDir, OPTIONS);

        expect(report.errors).toEqual([
          {
            at: 'package-lock.json',
            code: 'URL_CREDENTIALS_REFUSED',
            message: expect.stringContaining('"packages > node_modules/dep > resolved"'),
          },
        ]);
      },
      NPM_TIMEOUT,
    );

    it(
      'warns about a file left out because its name ends like a plugin artifact, with no error',
      async () => {
        const pluginDir = await writePluginFixture(root, {
          files: { 'assets/fixture.tgz': 'not really gzip\n' },
          packageJson: { files: ['dist', 'assets'] },
        });

        const report = await runValidate(pluginDir, OPTIONS);

        expect(report.errors).toEqual([]);
        expect(report.warnings).toEqual([
          {
            at: 'assets/fixture.tgz',
            code: 'PLUGIN_ARTIFACT_LEFT_OUT',
            message: expect.stringContaining('fixture.tgz'),
          },
        ]);
      },
      NPM_TIMEOUT,
    );

    it.each([
      ['slug', { slug: '../evil' }, 'SCHEMA_INVALID'],
      ['version', { version: '../../up' }, 'VERSION_INVALID'],
    ])(
      "uses `package` as the plugin artifact's top-level folder when the plugin manifest's %s is invalid, so the only error is the plugin author's own (#1093)",
      async (_field, manifest, issue) => {
        const pluginDir = await writePluginFixture(root, {
          manifest,
          packageJson: { name: 'demo-sink', version: '1.2.0' },
        });

        const report = await runValidate(pluginDir, OPTIONS);

        expect(codes(report.errors)).toEqual([issue]);
      },
      NPM_TIMEOUT,
    );

    it(
      'reports a folder without manifest.json once, as the missing required file the server would refuse (#1093)',
      async () => {
        const pluginDir = await writePluginFixture(root);
        await rm(join(pluginDir, 'manifest.json'));

        const report = await runValidate(pluginDir, OPTIONS);

        expect(report.errors).toEqual([{ at: 'manifest.json', code: 'required-file', message: expect.any(String) }]);
      },
      NPM_TIMEOUT,
    );

    it(
      'reports a folder without its own package.json as one NPM_PACK_FAILED error, and the command exits 1',
      async () => {
        const pluginDir = await mkdtemp(join(root, 'no-package-json-'));
        await writeFile(join(pluginDir, 'manifest.json'), MANIFEST);
        const out: string[] = [];
        const io = { stderr: { write: () => true }, stdout: { write: (text: string) => out.push(text) } };

        await expect(runCli(['validate', pluginDir, '--json'], io)).resolves.toBe(1);
        expect(JSON.parse(out.join(''))).toMatchObject({ errors: [{ code: 'NPM_PACK_FAILED' }], ok: false });
        expect(JSON.parse(out.join('')).errors).toHaveLength(1);
      },
      NPM_TIMEOUT,
    );

    it(
      'stays quiet about earlier plugin artifacts in the default build output folder',
      async () => {
        const pluginDir = await writePluginFixture(root, {
          files: { 'bge-artifacts/demo-sink-1.1.0.tgz': 'not really gzip\n' },
          packageJson: { files: ['dist', 'bge-artifacts'] },
        });

        const report = await runValidate(pluginDir, OPTIONS);

        expect(report.errors).toEqual([]);
        expect(report.warnings).toEqual([]);
      },
      NPM_TIMEOUT,
    );
  });

  describe('a plugin artifact', () => {
    it('passes a plugin artifact that holds the fixture plugin', async () => {
      const report = await runValidate(await writeArtifact(PLUGIN_ENTRIES), OPTIONS);

      expect(report.errors).toEqual([]);
      expect(codes(report.notes)).toContain('NOT_CHECKED_BEYOND_SCAN');
    });

    it('reports a forbidden import inside the plugin artifact', async () => {
      const report = await runValidate(
        await writeArtifact([
          ...PLUGIN_ENTRIES,
          { content: "import axios from 'axios';\n", name: 'demo-sink-1.2.0/dist/http.js' },
        ]),
        OPTIONS,
      );

      expect(report.errors).toEqual([
        { at: 'dist/http.js', code: 'esm-import', message: expect.stringContaining('"axios"') },
      ]);
    });

    it.each<[string, PluginTarballEntry, string]>([
      [
        'a symbolic link',
        { linkname: '/etc/passwd', name: 'demo-sink-1.2.0/dist/link.js', type: 'symlink' },
        'entry-type',
      ],
      ['a name that climbs out of the folder', { content: 'x', name: 'demo-sink-1.2.0/../escape.js' }, 'unsafe-path'],
      ['a second top-level folder', { content: 'x', name: 'other-1.0.0/index.js' }, 'top-level'],
    ])('refuses %s with the archive rule the server applies', async (_name, entry, rule) => {
      const report = await runValidate(await writeArtifact([...PLUGIN_ENTRIES, entry]), OPTIONS);

      expect(report.errors).toEqual([{ at: expect.any(String), code: rule, message: expect.any(String) }]);
    });

    it('refuses a .tgz that is not gzip, with no entry to point at', async () => {
      const path = join(await mkdtemp(join(root, 'artifact-')), 'broken.tgz');
      await writeFile(path, 'not an archive');

      const report = await runValidate(path, OPTIONS);

      expect(report.errors).toEqual([{ code: 'not-gzip', message: expect.any(String) }]);
    });

    it('refuses a plugin artifact larger than a server accepts by its size alone, before reading it', async () => {
      // Sparse: the length is set without writing the bytes, so it costs no disk.
      const path = join(await mkdtemp(join(root, 'artifact-')), 'huge.tgz');
      await writeFile(path, '');
      await truncate(path, PLUGIN_ARCHIVE_MAX_COMPRESSED_BYTES + 1);
      jest.mocked(mkdtemp).mockClear();

      const report = await runValidate(path, OPTIONS);

      // Zero bytes are not gzip: had anything read the file, this would be not-gzip.
      expect(report).toEqual({
        errors: [{ code: 'ARTIFACT_TOO_LARGE', message: expect.any(String) }],
        notes: [],
        warnings: [],
      });
      expect(jest.mocked(mkdtemp)).not.toHaveBeenCalled();
    });

    it('accepts a plugin artifact of exactly the size a server accepts as far as size goes', async () => {
      const path = join(await mkdtemp(join(root, 'artifact-')), 'at-cap.tgz');
      await writeFile(path, '');
      await truncate(path, PLUGIN_ARCHIVE_MAX_COMPRESSED_BYTES);

      const report = await runValidate(path, OPTIONS);

      expect(codes(report.errors)).toEqual(['not-gzip']);
    });
  });

  describe('--against a plugin artifact', () => {
    it('compares with the plugin manifest inside it', async () => {
      const previous = await writeArtifact(PLUGIN_ENTRIES);
      const base = buildPluginManifest({ bgeCompat: '>=0.0.0' });
      const next = buildPluginManifest({
        bgeCompat: '>=0.0.0',
        permissions: {
          checks: [
            ...base.permissions.checks,
            {
              consentScope: 'user',
              reason: { en: 'Reads the games a user owns to suggest what to play next.' },
              required: true,
              slug: 'read:game',
            },
          ],
        },
      });
      const current = await writeArtifact([
        ...PLUGIN_ENTRIES.filter((entry) => !entry.name.endsWith('manifest.json')),
        { content: JSON.stringify(next), name: 'demo-sink-1.2.0/manifest.json' },
      ]);

      const report = await runValidate(current, { ...OPTIONS, against: previous });

      expect(report.errors).toEqual([]);
      expect(codes(report.warnings)).toContain('REQUIRED_UNIT_SCOPE_PERMISSION_INTRODUCED');
      expect(codes(report.notes)).not.toContain('CONSENT_COMPARISON_SKIPPED');
    });

    it('reports one the server would refuse as AGAINST_UNREADABLE, naming the archive rule', async () => {
      const previous = await writeArtifact([
        ...PLUGIN_ENTRIES,
        { linkname: '/etc/passwd', name: 'demo-sink-1.2.0/dist/link.js', type: 'symlink' },
      ]);

      const report = await runValidate(await writeArtifact(PLUGIN_ENTRIES), { ...OPTIONS, against: previous });

      expect(report.errors).toEqual([
        { at: previous, code: 'AGAINST_UNREADABLE', message: expect.stringContaining('neither a file nor a folder') },
      ]);
    });

    it('reports one larger than a server accepts as AGAINST_UNREADABLE by its size alone, before reading it (#1093)', async () => {
      // Sparse, as above: zero bytes are not gzip, so had anything read the file, this would be not-gzip.
      const previous = join(await mkdtemp(join(root, 'against-huge-')), 'huge.tgz');
      await writeFile(previous, '');
      await truncate(previous, PLUGIN_ARCHIVE_MAX_COMPRESSED_BYTES + 1);

      const report = await runValidate(await writeArtifact(PLUGIN_ENTRIES), { ...OPTIONS, against: previous });

      expect(report.errors).toEqual([
        { at: previous, code: 'AGAINST_UNREADABLE', message: expect.stringContaining('a server accepts') },
      ]);
    });

    it('keeps the reason for a failure it did not foresee, such as a folder given as the earlier version (#1093)', async () => {
      const previous = await mkdtemp(join(root, 'against-folder-'));

      const report = await runValidate(await writeArtifact(PLUGIN_ENTRIES), { ...OPTIONS, against: previous });

      expect(report.errors).toEqual([
        { at: previous, code: 'AGAINST_UNREADABLE', message: expect.stringContaining('EISDIR') },
      ]);
    });
  });

  describe('anything else is a usage error', () => {
    it('for a file that is not a .tgz', async () => {
      const path = join(root, 'README.md');
      await writeFile(path, '# A plugin\n');

      const report = await runValidate(path, OPTIONS);

      expect(codes(report.errors)).toEqual(['USAGE']);
    });

    it('for a path that does not exist, saying there is nothing there (#1093)', async () => {
      const report = await runValidate(join(root, 'no-such-plugin'), OPTIONS);

      expect(report.errors).toEqual([
        { at: join(root, 'no-such-plugin'), code: 'USAGE', message: expect.stringContaining('no such file or folder') },
      ]);
    });
  });
});
