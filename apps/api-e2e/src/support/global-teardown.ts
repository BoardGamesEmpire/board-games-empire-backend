// The subpath, for the reason given in global-setup.
import { stopChild } from '@bge/testing-e2e/child-process';
import { getE2EGlobalState } from './global-state';

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

  await stopChild(api);

  const results = await Promise.allSettled([postgres?.stop(), redis?.stop()]);

  const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failures.length > 0) {
    throw new Error(
      `e2e teardown failed to stop ${failures.length} container(s): ${failures.map((f) => String(f.reason)).join('; ')}`,
    );
  }

  console.log('[e2e] teardown complete');
}
