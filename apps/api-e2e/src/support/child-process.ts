import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * Launch and stop for the application bundles the harness runs as child
 * processes: the API from `global-setup`, and the worker from specs that opt
 * into one (`useWorker`). Both follow one contract, so it lives here once:
 *
 * - Output is always piped, never inherited, and the last lines are kept so a
 *   child that dies during boot can be diagnosed from its own logs. With
 *   `BGE_E2E_VERBOSE` each chunk is also teed to the parent as it arrives, which
 *   is how CI, which runs verbose (#259), shows the child's full output.
 * - Readiness is polled against a caller-supplied probe, and a child that exits
 *   before the probe passes is reported as a boot failure, not a timeout.
 * - Stopping is SIGTERM first, SIGKILL after a grace period.
 */

/** apps/api-e2e/src/support → workspace root. */
export const WORKSPACE_ROOT = path.join(__dirname, '..', '..', '..', '..');

const OUTPUT_TAIL_LINES = 120;
const SIGTERM_GRACE_MS = 10_000;

/** How long a failed child's pipes get to finish before its output is reported without the rest. */
const OUTPUT_DRAIN_MS = 1_000;

/**
 * Fails fast, naming the build target, when a bundle is missing. A child
 * spawned on a missing file exits at once with a module-not-found error that
 * says nothing about which Nx dependency was skipped.
 */
export function requireBundle(label: string, bundle: string, buildTarget: string): void {
  if (!fs.existsSync(bundle)) {
    throw new Error(
      `${label} bundle not found at ${bundle}. The e2e target depends on '${buildTarget}' — ` +
        `run via 'npx nx e2e @boardgamesempire/api-e2e' (or run '${buildTarget}' first).`,
    );
  }
}

export interface ChildLaunch {
  /** How the child is named in log lines and failure messages. */
  readonly label: string;
  readonly bundle: string;
  readonly env: NodeJS.ProcessEnv;
  readonly verbose: boolean;

  /**
   * Resolves true once the child is ready. A probe that cannot tell yet (the
   * server is not listening) returns false; a probe that THROWS is reporting
   * that readiness can never be observed, and the launch fails with its message.
   */
  isReady(): Promise<boolean>;
  readonly timeoutMs: number;
  readonly pollMs: number;

  /** Appended to a timeout: what the probe was still waiting for, and why it might never arrive. */
  describeWait?(): string;
}

export type ChildLaunchOutcome =
  | {
      readonly kind: 'ready';
      readonly child: ChildProcess;
      /** Kept current for the child's lifetime, for callers that report a later exit. */
      readonly outputTail: readonly string[];
    }
  | {
      readonly kind: 'exited' | 'failed';
      readonly child: ChildProcess;
      readonly failure: string;
      /** The captured output, for callers that classify a boot failure by it. */
      readonly outputTail: readonly string[];
    };

/** A reason followed by the child's output, or a pointer to it when it was streamed. */
export function withChildOutput(reason: string, verbose: boolean, outputTail: readonly string[]): string {
  const logs = verbose ? '(logs were streamed above)' : `Last output:\n${outputTail.join('\n')}`;
  return `${reason}\n${logs}`;
}

/**
 * Resolves with `promise`, or with `fallback` once `ms` has passed, whichever
 * comes first. The timer is cleared either way, so a settled race leaves
 * nothing holding the event loop open.
 */
async function settleWithin<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Spawns `node <bundle>` and polls `isReady` until it passes, the child exits,
 * or the deadline lapses. An exit seen while a probe is out outranks what the
 * probe then answers. A probe that never settles counts as not ready, so
 * it cannot hold the launch past its deadline. A child still running when the
 * launch fails is SIGKILLed, and waited for, before this returns, so a failed
 * outcome never leaves a process behind.
 */
export async function launchChild(launch: ChildLaunch): Promise<ChildLaunchOutcome> {
  const { label, verbose } = launch;

  const child = spawn(process.execPath, [launch.bundle], {
    cwd: WORKSPACE_ROOT,
    env: launch.env,
    // Always piped, never inherited: the API's retry path classifies a boot
    // failure by scanning this output for EADDRINUSE, and inherited stdio
    // would leave nothing to scan — making verbose runs the flaky ones.
    // Verbose mode tees each chunk through to the parent instead, so logs
    // still stream live.
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const outputTail: string[] = [];
  const capture = (chunk: Buffer, sink: NodeJS.WriteStream): void => {
    if (verbose) {
      sink.write(chunk);
    }

    for (const line of chunk.toString('utf8').split('\n')) {
      if (line.length === 0) {
        continue;
      }

      outputTail.push(line);
      if (outputTail.length > OUTPUT_TAIL_LINES) {
        outputTail.shift();
      }
    }
  };

  child.stdout?.on('data', (chunk: Buffer) => capture(chunk, process.stdout));
  child.stderr?.on('data', (chunk: Buffer) => capture(chunk, process.stderr));

  let exited = false;
  child.once('exit', () => {
    exited = true;
  });

  // 'close' comes after 'exit', once the child's pipes have closed, so it marks
  // the point where its last output has been read. Any process the child
  // started can hold the pipes open past that, which is why it is only ever
  // awaited with a bound.
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));

  // A spawn that fails (EAGAIN, ENOMEM) emits 'error', and an EventEmitter
  // with no listener for it throws instead, past everything below.
  let spawnError: Error | undefined;
  child.once('error', (error) => {
    spawnError = error;
    exited = true;
  });

  const fail = async (kind: 'exited' | 'failed', reason: string): Promise<ChildLaunchOutcome> => {
    if (!exited) {
      child.kill('SIGKILL');
    }

    // Awaited in both cases. After a SIGKILL, so the child is gone when this
    // returns. After an exit, so the report carries the final lines, which
    // 'exit' does not wait for. For the API those include the EADDRINUSE its
    // port retry looks for.
    await settleWithin(closed, OUTPUT_DRAIN_MS, undefined);

    return { kind, child, failure: withChildOutput(reason, verbose, outputTail), outputTail };
  };

  const deadline = Date.now() + launch.timeoutMs;
  for (;;) {
    if (exited) {
      return fail(
        'exited',
        spawnError
          ? `${label} process could not be started: ${spawnError.message}`
          : `${label} process exited during boot (code ${String(child.exitCode)})`,
      );
    }

    const probe = await settleWithin(launch.isReady(), Math.max(deadline - Date.now(), 0), false).then(
      (ready) => ({ ready }),
      (error: unknown) => ({ error }),
    );

    // The child died while the probe was out. Reported at the top of the loop
    // as the exit it is, whatever the probe answered: a probe can pass for a
    // child that has just died (CLIENT LIST lists a worker's connections until
    // Redis reads their close). Nor is it the timeout the check below would
    // call it.
    if (exited) {
      continue;
    }

    if ('error' in probe) {
      const { error } = probe;
      return fail(
        'failed',
        `${label} readiness probe failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (probe.ready) {
      return { kind: 'ready', child, outputTail };
    }

    if (Date.now() >= deadline) {
      const waitingOn = launch.describeWait ? ` — ${launch.describeWait()}` : '';
      return fail('failed', `${label} did not become ready within ${launch.timeoutMs}ms${waitingOn}`);
    }

    await delay(launch.pollMs);
  }
}

/**
 * SIGTERM first — both apps register graceful shutdown handlers and should
 * exit cleanly — with a SIGKILL fallback so a wedged process can't hang the
 * suite forever.
 */
export async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));

  child.kill('SIGTERM');
  await settleWithin(exited, SIGTERM_GRACE_MS, undefined);

  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
}

/**
 * Best-effort orphan guard: SIGKILLs the child on any normal or thrown exit of
 * THIS process. It no-ops once the child has stopped. It cannot cover a
 * SIGKILLed parent, since there is no portable parent-death signal.
 *
 * `globalSetup` only. A spec file sees Jest's copy of `process`, whose event
 * emitter is its own, so the real process's `exit` never reaches a listener
 * registered there. `useWorker` relies on its `afterAll` instead, and on the
 * shared process group for Ctrl-C.
 */
export function killOnExit(child: ChildProcess): void {
  process.once('exit', () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  });
}
