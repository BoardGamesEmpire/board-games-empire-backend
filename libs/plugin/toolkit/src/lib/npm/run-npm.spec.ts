import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeNpmFailure, NpmCommandError, runNpm } from './run-npm.js';

// Each case spawns a real npm, offline (#1093).
const NPM_TIMEOUT = 60_000;

/**
 * Run through `npm run nx`, the Jest worker carries the parent npm's
 * variables (`npm_config_local_prefix`, `npm_package_json`) naming the
 * workspace root, and the child npm inherits them. These cases pass only if
 * npm still acts on the fixture folder it is run in (#1093). Fixtures sit
 * under the OS temp directory: npm walks up to the nearest package.json.
 */
describe('runNpm (#1093)', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'bge-run-npm-'));
  });

  afterAll(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it(
    'resolves with what npm prints, run in the given folder',
    async () => {
      const projectDir = await mkdtemp(join(root, 'ok-'));
      await writeFile(join(projectDir, 'package.json'), '{"name":"dice-tools","version":"1.2.3"}');

      await expect(runNpm(['pkg', 'get', 'version'], projectDir)).resolves.toBe('"1.2.3"\n');
    },
    NPM_TIMEOUT,
  );

  it(
    "rejects with the arguments, npm's stderr and its exit code when npm fails",
    async () => {
      const projectDir = await mkdtemp(join(root, 'empty-'));
      const args = ['pack', '--dry-run', '--json', '--ignore-scripts'];

      const failure = await runNpm(args, projectDir).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(NpmCommandError);
      expect(failure).toMatchObject({
        args,
        exitCode: expect.any(Number),
        stderr: expect.stringContaining('ENOENT'),
      });
      expect(failure).not.toMatchObject({ exitCode: 0 });
    },
    NPM_TIMEOUT,
  );

  it(
    'gives an account of the failure when npm fails without a word on stderr',
    async () => {
      const projectDir = await mkdtemp(join(root, 'silent-'));
      await writeFile(
        join(projectDir, 'package.json'),
        '{"name":"dice-tools","version":"1.2.3","scripts":{"quiet":"exit 3"}}',
      );

      const failure = await runNpm(['run', 'quiet', '--silent'], projectDir).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(NpmCommandError);
      expect(failure).toMatchObject({ exitCode: 3, stderr: expect.stringContaining('npm run quiet --silent') });
    },
    NPM_TIMEOUT,
  );

  it('rejects with a null exit code and the reason when npm cannot be started at all', async () => {
    // A working folder that does not exist stops the spawn itself, as a
    // missing npm does on macOS and Linux (#1093).
    const failure = await runNpm(['--version'], join(root, 'no-such-folder')).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(NpmCommandError);
    expect(failure).toMatchObject({ exitCode: null, stderr: expect.stringContaining('ENOENT') });
  });
});

describe('describeNpmFailure (#1093)', () => {
  const args = ['ci'];

  it("says npm could not be run, with Node's reason, when npm never ran to an exit code", () => {
    expect(describeNpmFailure(new NpmCommandError(args, 'spawn npm ENOENT', null))).toBe(
      'npm could not be run: spawn npm ENOENT',
    );
  });

  it('quotes what npm said, without blank lines', () => {
    expect(describeNpmFailure(new NpmCommandError(args, 'npm error code E404\n\nnpm error 404 Not Found\n', 1))).toBe(
      'npm said:\nnpm error code E404\nnpm error 404 Not Found',
    );
  });

  it('quotes only the last 20 lines of a long failure, and says so', () => {
    const stderr = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join('\n');

    const said = describeNpmFailure(new NpmCommandError(args, stderr, 1));

    expect(said.startsWith("npm's last 20 lines:\nline 6\n")).toBe(true);
    expect(said.endsWith('line 25')).toBe(true);
  });
});
