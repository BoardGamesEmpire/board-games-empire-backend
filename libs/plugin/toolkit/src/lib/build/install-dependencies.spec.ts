import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runNpm } from '../npm/run-npm.js';
import { installDependencies } from './install-dependencies.js';

jest.mock('../npm/run-npm.js', () => ({
  ...jest.requireActual<typeof import('../npm/run-npm.js')>('../npm/run-npm.js'),
  runNpm: jest.fn().mockResolvedValue(''),
}));

describe('installDependencies (#1093)', () => {
  let stageDir: string;

  beforeEach(async () => {
    stageDir = await mkdtemp(join(tmpdir(), 'bge-install-dependencies-spec-'));
  });

  afterEach(async () => {
    await rm(stageDir, { force: true, recursive: true });
  });

  // npm installs a dependency type that is both included and omitted, and an
  // `include=dev` from the environment or an .npmrc is a different setting
  // from the command line's `--omit=dev`, so it would still add development
  // dependencies that SOURCES.md leaves out. `--include=prod` on the command
  // line replaces any inherited `include` (#1093). A spec cannot set npm's
  // environment for a real run: Jest gives each test file its own copy of
  // process.env, which the npm child never sees.
  it('runs npm ci with production dependencies only, overriding an inherited include setting', async () => {
    await installDependencies(stageDir);

    expect(runNpm).toHaveBeenCalledWith(expect.arrayContaining(['ci', '--omit=dev', '--include=prod']), stageDir);
  });
});
