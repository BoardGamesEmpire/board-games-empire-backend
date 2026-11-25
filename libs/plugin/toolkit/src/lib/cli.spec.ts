import { join, resolve } from 'node:path';
import type { BuildOptions, BuildOutcome, CliCommands, ValidateOptions } from './cli.js';
import { runCli } from './cli.js';
import { BGE_VERSION } from './generated/bge-version.js';
import type { ValidationReport } from './report.js';
import { ToolkitError } from './toolkit.errors.js';

const clean: ValidationReport = {
  errors: [],
  notes: [{ code: 'NOT_CHECKED_BEYOND_SCAN', message: 'The scan does not run the code.' }],
  warnings: [{ at: 'dist/x.js', code: 'non-literal-require', message: 'The scan cannot tell what is loaded.' }],
};

const failing: ValidationReport = {
  ...clean,
  errors: [{ at: 'dist/index.js', code: 'esm-import', message: 'The code imports "axios", a forbidden import.' }],
};

const artifact = { path: '/p/bge-artifacts/x-1.0.0.tgz', sha256: 'ab'.repeat(32), sidecarPath: '/p/x.tgz.sha256' };

const setup = (overrides: { build?: BuildOutcome; validate?: ValidationReport } = {}) => {
  const out: string[] = [];
  const err: string[] = [];
  const validate = jest.fn<Promise<ValidationReport>, [string, ValidateOptions]>(
    async () => overrides.validate ?? clean,
  );
  const build = jest.fn<Promise<BuildOutcome>, [string, BuildOptions]>(
    async () => overrides.build ?? { artifact, report: clean },
  );
  const commands: CliCommands = { build, validate };
  const io = {
    stderr: { write: (text: string) => err.push(text) },
    stdout: { write: (text: string) => out.push(text) },
  };

  return {
    build,
    run: (...argv: string[]) => runCli(argv, io, commands),
    stderr: () => err.join(''),
    stdout: () => out.join(''),
    validate,
  };
};

describe('runCli (#1093)', () => {
  describe('validate', () => {
    it('passes the stamped BGE version, locale en and no accepted imports by default, and exits 0 with no errors', async () => {
      const cli = setup();

      await expect(cli.run('validate', 'some/plugin')).resolves.toBe(0);
      expect(cli.validate).toHaveBeenCalledWith(resolve('some/plugin'), {
        acceptImports: [],
        bgeVersion: BGE_VERSION,
        defaultLocale: 'en',
      });
      expect(cli.stdout()).toContain('warning non-literal-require dist/x.js:');
      expect(cli.stdout()).toContain('0 errors, 1 warning');
      expect(cli.stderr()).toBe('');
    });

    it('exits 1 when the report has an error', async () => {
      const cli = setup({ validate: failing });

      await expect(cli.run('validate', 'p')).resolves.toBe(1);
      expect(cli.stdout()).toContain('error esm-import dist/index.js: The code imports "axios"');
    });

    it('collects every --accept-import', async () => {
      const cli = setup();

      await cli.run('validate', 'p', '--accept-import', 'axios', '--accept-import', 'pg');

      expect(cli.validate.mock.calls[0][1].acceptImports).toEqual(['axios', 'pg']);
    });

    it('passes --against, --bge-version and --default-locale through', async () => {
      const cli = setup();

      await cli.run('validate', 'p', '--against', 'x', '--bge-version', '1.2.3', '--default-locale', 'de');

      expect(cli.validate).toHaveBeenCalledWith(resolve('p'), {
        acceptImports: [],
        against: resolve('x'),
        bgeVersion: '1.2.3',
        defaultLocale: 'de',
      });
    });

    it('writes one JSON document to stdout with --json', async () => {
      const cli = setup({ validate: failing });

      await expect(cli.run('validate', 'p', '--json')).resolves.toBe(1);

      const parsed: unknown = JSON.parse(cli.stdout());

      expect(parsed).toEqual({ errors: failing.errors, notes: failing.notes, ok: false, warnings: failing.warnings });
    });
  });

  describe('build', () => {
    it('builds the current folder into <project>/bge-artifacts by default', async () => {
      const cli = setup();

      await expect(cli.run('build')).resolves.toBe(0);
      expect(cli.build).toHaveBeenCalledWith(process.cwd(), {
        acceptImports: [],
        bgeVersion: BGE_VERSION,
        defaultLocale: 'en',
        outDir: join(process.cwd(), 'bge-artifacts'),
      });
    });

    it('puts the default output folder inside the project it is given, and resolves --out-dir from where it runs', async () => {
      const cli = setup();

      await cli.run('build', 'plugins/x');
      await cli.run('build', 'plugins/x', '--out-dir', 'out');

      expect(cli.build.mock.calls[0][1].outDir).toBe(join(resolve('plugins/x'), 'bge-artifacts'));
      expect(cli.build.mock.calls[1][1].outDir).toBe(resolve('out'));
    });

    it('names the plugin artifact, its checksum file and its sha256 when one was written', async () => {
      const cli = setup();

      await cli.run('build');

      expect(cli.stdout()).toContain(artifact.path);
      expect(cli.stdout()).toContain(artifact.sidecarPath);
      expect(cli.stdout()).toContain(artifact.sha256);
    });

    it('exits 1 and names no plugin artifact when the report has an error', async () => {
      const cli = setup({ build: { report: failing } });

      await expect(cli.run('build')).resolves.toBe(1);
      expect(cli.stdout()).not.toContain('.tgz');
    });

    it('carries the artifact in the --json document', async () => {
      const cli = setup();

      await cli.run('build', '--json');

      expect(JSON.parse(cli.stdout())).toMatchObject({ artifact, ok: true });
    });
  });

  const usageCases: [string, string[]][] = [
    ['an unknown command', ['publish', 'p']],
    ['an unknown option', ['validate', 'p', '--frobnicate']],
    ['a missing validate path', ['validate']],
    ['a second validate path', ['validate', 'a', 'b']],
    ['an invalid --bge-version', ['validate', 'p', '--bge-version', 'notsemver']],
    ['an invalid --default-locale', ['validate', 'p', '--default-locale', 'not a locale']],
    ['--out-dir on validate', ['validate', 'p', '--out-dir', 'x']],
    ['an option with no value', ['validate', 'p', '--against']],
  ];

  describe('usage errors exit 2 with a USAGE line on stderr', () => {
    it.each(usageCases)('%s', async (_name, argv) => {
      const cli = setup();

      await expect(cli.run(...argv)).resolves.toBe(2);
      expect(cli.stderr()).toMatch(/^error USAGE: /m);
      expect(cli.stderr()).toContain('bge-plugin --help');
      expect(cli.stdout()).toBe('');
      expect(cli.validate).not.toHaveBeenCalled();
      expect(cli.build).not.toHaveBeenCalled();
    });
  });

  describe('usage errors with --json print one JSON document and still exit 2, for a CI that parses stdout (#1093)', () => {
    it.each(usageCases)('%s', async (_name, argv) => {
      const cli = setup();

      await expect(cli.run(...argv, '--json')).resolves.toBe(2);
      expect(JSON.parse(cli.stdout())).toEqual({
        errors: [{ code: 'USAGE', message: expect.stringMatching(/^The command was not understood\. /) }],
        notes: [],
        ok: false,
        warnings: [],
      });
      expect(cli.stderr()).toBe('');
      expect(cli.validate).not.toHaveBeenCalled();
    });

    it('decides --json from the arguments even when they do not parse, but not from a path after --', async () => {
      const cli = setup();

      await expect(cli.run('--json', 'validate', '--against')).resolves.toBe(2);
      expect(JSON.parse(cli.stdout())).toMatchObject({ errors: [{ code: 'USAGE' }], ok: false });

      const plain = setup();

      await expect(plain.run('validate', '--frob', '--', '--json')).resolves.toBe(2);
      expect(plain.stdout()).toBe('');
      expect(plain.stderr()).toMatch(/^error USAGE: /);
    });
  });

  describe('help', () => {
    it.each([[[]], [['--help']], [['-h']], [['validate', '--help']], [['build', '-h']]])(
      'prints usage naming both commands and every option, and exits 0, for %j',
      async (argv) => {
        const cli = setup();

        await expect(cli.run(...argv)).resolves.toBe(0);

        const text = cli.stdout();

        expect(text).toMatch(/^Usage: bge-plugin/);

        for (const word of [
          'validate',
          'build',
          '--accept-import',
          '--against',
          '--bge-version',
          '--default-locale',
          '--out-dir',
          '--json',
          '--help',
        ]) {
          expect(text).toContain(word);
        }

        expect(text).toContain(BGE_VERSION);
        expect(cli.validate).not.toHaveBeenCalled();
      },
    );
  });

  describe('failures inside a command', () => {
    it('prints a ToolkitError as a one-error report and exits 1', async () => {
      const cli = setup();
      cli.validate.mockRejectedValueOnce(new ToolkitError('NPM_PACK_FAILED', 'package.json', 'npm said no.'));

      await expect(cli.run('validate', 'p')).resolves.toBe(1);
      expect(cli.stdout()).toMatch(/^error NPM_PACK_FAILED package\.json: .+ npm said no\.\n1 error, 0 warnings\n$/);
    });

    it('prints a ToolkitError as a one-error JSON document with --json', async () => {
      const cli = setup();
      cli.build.mockRejectedValueOnce(new ToolkitError('LOCKFILE_MISSING'));

      await expect(cli.run('build', '--json')).resolves.toBe(1);
      expect(JSON.parse(cli.stdout())).toMatchObject({
        errors: [{ code: 'LOCKFILE_MISSING' }],
        notes: [],
        ok: false,
        warnings: [],
      });
    });

    it('exits 2 for a USAGE error a command reports, such as a target it cannot read', async () => {
      const cli = setup({ validate: { ...clean, errors: [{ code: 'USAGE', message: 'Not a plugin folder.' }] } });

      await expect(cli.run('validate', 'README.md')).resolves.toBe(2);
    });

    it('prints any other error as one UNEXPECTED_ERROR line on stderr, never a stack trace, and exits 1', async () => {
      const cli = setup();
      cli.validate.mockRejectedValueOnce(new Error('disk on fire\n    at somewhere (file.js:1:1)'));

      await expect(cli.run('validate', 'p')).resolves.toBe(1);
      expect(cli.stderr().trimEnd().split('\n')).toHaveLength(1);
      expect(cli.stderr()).toMatch(/^error UNEXPECTED_ERROR: /);
      expect(cli.stderr()).toContain('disk on fire');
      expect(cli.stderr()).not.toContain('file.js');
      expect(cli.stdout()).toBe('');
    });

    it('prints any other error as one JSON document with --json, so every line the CLI prints carries a code (#1093)', async () => {
      const cli = setup();
      cli.build.mockRejectedValueOnce(new Error('disk on fire\n    at somewhere (file.js:1:1)'));

      await expect(cli.run('build', '--json')).resolves.toBe(1);
      expect(JSON.parse(cli.stdout())).toEqual({
        errors: [{ code: 'UNEXPECTED_ERROR', message: expect.stringContaining('disk on fire') }],
        notes: [],
        ok: false,
        warnings: [],
      });
      expect(cli.stdout()).not.toContain('file.js');
      expect(cli.stderr()).toBe('');
    });
  });
});
