import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NpmCommandError, runNpm } from './run-npm.js';

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
});
