import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { launchChild, type ChildLaunch } from './child-process';

/**
 * `launchChild`'s failure paths, against real `node` children built from the
 * scripts below. Each one fails a launch in a way the API or worker can, and
 * pins what the outcome must say about it.
 */
describe('launchChild', () => {
  let scripts: string;

  const script = (name: string, source: string): string => {
    const file = path.join(scripts, name);
    fs.writeFileSync(file, source);
    return file;
  };

  const launch = (bundle: string, overrides: Partial<ChildLaunch>): ReturnType<typeof launchChild> =>
    launchChild({
      label: 'fixture',
      bundle,
      env: process.env,
      verbose: false,
      isReady: () => Promise.resolve(false),
      timeoutMs: 5_000,
      pollMs: 20,
      ...overrides,
    });

  beforeAll(() => {
    scripts = fs.mkdtempSync(path.join(os.tmpdir(), 'bge-child-process-'));
  });

  afterAll(() => {
    fs.rmSync(scripts, { recursive: true, force: true });
  });

  it('reports a child that exits while the probe is still out as a boot exit, not a timeout', async () => {
    // The probe never answers, so the launch sits in it until the deadline,
    // and the child exits long before that. Checking the deadline first
    // called this a readiness timeout and hid the exit code.
    const outcome = await launch(script('exits.cjs', 'process.exit(3);'), {
      isReady: () => new Promise<boolean>(() => undefined),
      timeoutMs: 1_000,
    });

    expect(outcome.kind).toBe('exited');
    expect(outcome.kind !== 'ready' && outcome.failure).toMatch(/exited during boot \(code 3\)/);
  });

  it('includes output that was still in the pipe when the child exited', async () => {
    // 'exit' can fire before the child's last output has been read. A process
    // the child started holds the pipe open here and writes after the child is
    // gone, which makes that window long enough to see every time. For the API
    // the missing line would be the EADDRINUSE its port retry looks for.
    const bundle = script(
      'late-output.cjs',
      [
        `const { spawn } = require('node:child_process');`,
        `spawn(process.execPath, ['-e', "setTimeout(() => process.stderr.write('written after the exit\\\\n'), 200)"], {`,
        `  stdio: ['ignore', 'inherit', 'inherit'],`,
        `});`,
        `process.exit(3);`,
      ].join('\n'),
    );

    const outcome = await launch(bundle, {});

    expect(outcome.kind).toBe('exited');
    expect(outcome.outputTail).toContain('written after the exit');
  });

  it('has stopped a child it gave up on by the time it returns', async () => {
    const outcome = await launch(script('never-ready.cjs', 'setInterval(() => undefined, 1_000);'), {
      timeoutMs: 300,
    });

    expect(outcome.kind).toBe('failed');
    expect(outcome.child.signalCode).toBe('SIGKILL');
  });
});
