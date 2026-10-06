import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { launchChild, launchOnFreePort, stopChild, WORKSPACE_ROOT, type ChildLaunch } from './child-process.js';

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

  /** A child that records its pid where {@link afterReap} can find it, then exits with code 3. */
  const exitsLeavingPid = (name: string): { bundle: string; pidFile: string } => {
    const pidFile = path.join(scripts, `${name}.pid`);
    const bundle = script(
      `${name}.cjs`,
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nprocess.exit(3);`,
    );

    return { bundle, pidFile };
  };

  /**
   * A probe that settles, as `settle` says, only once the child has been
   * reaped. A zombie still answers `kill(pid, 0)`, and Node reaps a child in
   * the same step that emits its 'exit', so the launch has seen the exit by
   * the time this settles.
   */
  const afterReap = (pidFile: string, settle: () => Promise<boolean>) => async (): Promise<boolean> => {
    for (;;) {
      const pid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : 0;
      if (pid > 0) {
        try {
          process.kill(pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
            return settle();
          }

          throw error;
        }
      }

      await delay(10);
    }
  };

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

  it('reports a child that exits while the probe is out as a boot exit, even when the probe then passes', async () => {
    // A probe can pass for a child that has just died: CLIENT LIST still lists
    // a worker's connections until Redis reads their close. Accepting the
    // answer called a dead child ready.
    const { bundle, pidFile } = exitsLeavingPid('exits-then-passes');

    const outcome = await launch(bundle, { isReady: afterReap(pidFile, () => Promise.resolve(true)) });

    expect(outcome.kind).toBe('exited');
    expect(outcome.kind !== 'ready' && outcome.failure).toMatch(/exited during boot \(code 3\)/);
  });

  it('reports a child that exits while the probe is out as a boot exit, even when the probe then fails', async () => {
    const { bundle, pidFile } = exitsLeavingPid('exits-then-fails');

    const outcome = await launch(bundle, {
      isReady: afterReap(pidFile, () => Promise.reject(new Error('connection lost'))),
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

  it('runs the child from the workspace root unless the launch names a directory', async () => {
    const bundle = script('prints-cwd.cjs', 'console.log(process.cwd());\nprocess.exit(3);');

    const fromRoot = await launch(bundle, {});
    const fromScripts = await launch(bundle, { cwd: scripts });

    expect(fromRoot.outputTail).toEqual([fs.realpathSync(WORKSPACE_ROOT)]);
    expect(fromScripts.outputTail).toEqual([fs.realpathSync(scripts)]);
  });

  it('has stopped a child it gave up on by the time it returns', async () => {
    const outcome = await launch(script('never-ready.cjs', 'setInterval(() => undefined, 1_000);'), {
      timeoutMs: 300,
    });

    expect(outcome.kind).toBe('failed');
    expect(outcome.child.signalCode).toBe('SIGKILL');
  });
});

/**
 * `launchOnFreePort`'s retry, against a `node` child that reports EADDRINUSE,
 * as a server that lost its port does, until a given attempt.
 */
describe('launchOnFreePort', () => {
  let scripts: string;

  /**
   * A child that counts its launches in `marker`, reports a lost port on every
   * launch before `bindsOn`, and otherwise writes the PORT it was given to
   * `boundTo` and stays up. Each call gets its own files.
   */
  const losesItsPortUntil = (name: string, bindsOn: number) => {
    const marker = path.join(scripts, `${name}.launches`);
    const boundTo = path.join(scripts, `${name}.port`);
    const bundle = path.join(scripts, `${name}.cjs`);
    fs.writeFileSync(
      bundle,
      [
        `const fs = require('node:fs');`,
        `const launch = fs.existsSync(${JSON.stringify(marker)}) ? Number(fs.readFileSync(${JSON.stringify(marker)}, 'utf8')) + 1 : 1;`,
        `fs.writeFileSync(${JSON.stringify(marker)}, String(launch));`,
        `if (launch < ${bindsOn}) {`,
        `  console.error('Error: listen EADDRINUSE: address already in use 127.0.0.1:' + process.env.PORT);`,
        `  process.exit(1);`,
        `}`,
        `fs.writeFileSync(${JSON.stringify(boundTo)}, process.env.PORT);`,
        `setInterval(() => undefined, 1_000);`,
      ].join('\n'),
    );

    return { bundle, boundTo };
  };

  const launchOn =
    (bundle: string, ready: () => boolean, ports: number[]) =>
    (port: number): ChildLaunch => {
      ports.push(port);

      return {
        label: 'fixture',
        bundle,
        env: { ...process.env, PORT: String(port) },
        verbose: false,
        isReady: () => Promise.resolve(ready()),
        timeoutMs: 5_000,
        pollMs: 20,
      };
    };

  beforeAll(() => {
    scripts = fs.mkdtempSync(path.join(os.tmpdir(), 'bge-free-port-'));
  });

  afterAll(() => {
    fs.rmSync(scripts, { recursive: true, force: true });
  });

  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('launches again on a fresh port when the child loses its port, and reports the port it kept', async () => {
    const { bundle, boundTo } = losesItsPortUntil('second-time-lucky', 2);
    const ports: number[] = [];

    const launched = await launchOnFreePort(launchOn(bundle, () => fs.existsSync(boundTo), ports));

    try {
      expect(ports).toHaveLength(2);
      expect(launched.port).toBe(ports[1]);
      expect(fs.readFileSync(boundTo, 'utf8')).toBe(String(launched.port));
    } finally {
      await stopChild(launched.child);
    }
  });

  it('does not launch again after a boot death that is not a lost port', async () => {
    const bundle = path.join(scripts, 'dies.cjs');
    fs.writeFileSync(bundle, 'process.exit(3);');
    const ports: number[] = [];

    await expect(launchOnFreePort(launchOn(bundle, () => false, ports))).rejects.toThrow(
      /exited during boot \(code 3\)/,
    );
    expect(ports).toHaveLength(1);
  });

  it('reports the lost port as the failure once its three attempts run out', async () => {
    const { bundle } = losesItsPortUntil('never-binds', Number.POSITIVE_INFINITY);
    const ports: number[] = [];

    await expect(launchOnFreePort(launchOn(bundle, () => false, ports))).rejects.toThrow(/EADDRINUSE/);
    expect(ports).toHaveLength(3);
  });
});
