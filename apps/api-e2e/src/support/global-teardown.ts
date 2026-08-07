import type { ChildProcess } from 'node:child_process';
import { getE2EGlobalState } from './global-state';

const SIGTERM_GRACE_MS = 10_000;

/**
 * SIGTERM first — the API registers graceful shutdown handlers and should
 * exit cleanly — with a SIGKILL fallback so a wedged process can't hang the
 * suite forever.
 */
async function stopApi(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));

  child.kill('SIGTERM');
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, SIGTERM_GRACE_MS))]);

  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
}

/**
 * Stops whatever `global-setup` started — the API child process first (it
 * holds connections into both containers), then the containers. Container
 * stops are always attempted; failures are aggregated and rethrown so a
 * leaked container is a loud suite failure rather than a silent stray.
 * (A crashed run that never reaches teardown is covered by testcontainers'
 * reaper.)
 */
export default async function globalTeardown(): Promise<void> {
  const { postgres, redis, api } = getE2EGlobalState();

  await stopApi(api);

  const results = await Promise.allSettled([postgres?.stop(), redis?.stop()]);

  const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failures.length > 0) {
    throw new Error(
      `e2e teardown failed to stop ${failures.length} container(s): ${failures.map((f) => String(f.reason)).join('; ')}`,
    );
  }

  console.log('[e2e] teardown complete');
}
