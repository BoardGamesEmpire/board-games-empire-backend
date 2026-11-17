import { getE2EGlobalState } from './global-state';

/**
 * Stops the containers `global-setup` started. Both stops are attempted even
 * when one fails, and a failure is rethrown, so a leaked container fails the
 * run loudly. Each spec file stops the coordinator it launched, so none is
 * running by now.
 */
export default async function globalTeardown(): Promise<void> {
  const { postgres, redis } = getE2EGlobalState();

  const results = await Promise.allSettled([postgres?.stop(), redis?.stop()]);

  const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failures.length > 0) {
    throw new Error(
      `e2e teardown failed to stop ${failures.length} of the containers: ${failures.map((f) => String(f.reason)).join('; ')}`,
    );
  }

  console.log('[e2e] teardown complete');
}
