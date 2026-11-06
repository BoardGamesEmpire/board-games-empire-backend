// The subpath, for the reason given in global-setup.
import { stopChild } from '@bge/testing-e2e/child-process';
import { rm } from 'node:fs/promises';
import { getE2EGlobalState } from './global-state';

/**
 * Stops whatever `global-setup` started — the API child process first (it
 * holds connections into both containers and the fake sign-in provider),
 * then the fake and the containers together. Every one of those stops is
 * attempted, even when another fails; failures are aggregated and rethrown
 * so a leaked container is a loud suite failure rather than a silent stray.
 * (A crashed run that never reaches teardown is covered by testcontainers'
 * reaper.)
 */
export default async function globalTeardown(): Promise<void> {
  const { postgres, redis, api, signInProvider, pluginsRoot } = getE2EGlobalState();

  await stopChild(api);

  // After the API has stopped, so nothing is writing into it.
  const results = await Promise.allSettled([
    signInProvider?.close(),
    postgres?.stop(),
    redis?.stop(),
    pluginsRoot === undefined ? undefined : rm(pluginsRoot, { recursive: true, force: true }),
  ]);

  const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failures.length > 0) {
    throw new Error(
      `e2e teardown failed to stop ${failures.length} of the fake sign-in provider, the containers and the plugins root: ${failures.map((f) => String(f.reason)).join('; ')}`,
    );
  }

  console.log('[e2e] teardown complete');
}
